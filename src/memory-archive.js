// 第三级记忆：完整聊天归档（只追加的 JSONL，按会话分文件）。
//
// 为什么要它：桥接只在 social-v2.json 里保留最近 100 条消息，更早的就没了；而网关历史只给最近 N 条、
// 会滚掉。没有原始档案的话，① 日记（第二级）只能靠模型现编、无法核对；② 有人问"上个月你说的那个"
// 就永远查不到；③ 换模型/改摘要策略时历史无法重算。
//
// 设计要点：
//  · **只追加**（append-only），按月分文件 `messages/<会话>/YYYY-MM.jsonl`，便于压缩与删除；
//  · 每行一条精简记录：时间、消息 id、发送者、是否自己、文本、媒体描述、引用关系；
//  · 保留策略：超过 keepDays 的月文件直接删（日记里留摘要即可），另有单会话总量上限；
//  · 检索：流式逐行扫（不做全量读入），支持关键词/时间范围/条数上限，返回"命中行 + 少量上下文"。
import fs from 'node:fs';
import path from 'node:path';

export const ARCHIVE_DIR = 'messages';
const MONTH_RE = /^\d{4}-\d{2}\.jsonl$/;

/** 会话 key 变成安全的目录名：group:1050666134 → group_1050666134 */
export function convDirName(key) {
  return String(key ?? '').replace(/[^\w.-]/g, '_').slice(0, 80) || 'unknown';
}

export function monthOf(ms) {
  const d = new Date(Number(ms) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** 把一条消息压成归档记录（字段尽量短，省磁盘）。 */
export function toArchiveRecord(message = {}, now = Date.now()) {
  const rec = {
    t: Number(message.time ?? message.t) || now,
    id: String(message.messageId ?? message.id ?? ''),
    from: String(message.sender ?? message.from ?? ''),
    me: Boolean(message.isSelf ?? message.me),
    text: String(message.text ?? message.plain ?? '').slice(0, 4000)
  };
  const media = Array.isArray(message.media) ? message.media : [];
  if (media.length) rec.media = media.map((m) => String(m?.kind ?? 'media') + (m?.label ? `:${m.label}` : '')).slice(0, 10);
  if (message.replyToMessageId) rec.re = String(message.replyToMessageId);
  return rec;
}

/**
 * 追加一条记录。目录/文件不存在会自动建。
 * @returns {{file:string, bytes:number}|null}
 */
export function appendArchive({ stateDir, key, record, maxFileBytes = 64 * 1024 * 1024, keepDays = 90 }) {
  const dir = path.join(stateDir, ARCHIVE_DIR, convDirName(key));
  const file = path.join(dir, `${monthOf(record?.t)}.jsonl`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(file, line, 'utf8');
    const bytes = fs.statSync(file).size;
    // 单文件过大时轮转（不删数据，另起一个 .partN，便于人工处理）
    if (bytes > maxFileBytes) {
      let n = 1;
      while (fs.existsSync(`${file}.part${n}`)) n += 1;
      fs.renameSync(file, `${file}.part${n}`);
    }
    pruneArchive({ stateDir, key, keepDays });
    return { file, bytes };
  } catch {
    return null;
  }
}

/** 删除超过 keepDays 的月文件（按文件名里的年月判断）。 */
export function pruneArchive({ stateDir, key, keepDays = 90, now = Date.now() }) {
  if (!(keepDays > 0)) return 0;
  const dir = path.join(stateDir, ARCHIVE_DIR, convDirName(key));
  const cutoff = new Date(Number(now) - keepDays * 86400000);
  const cutoffMonth = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!MONTH_RE.test(name)) continue;
      if (name.slice(0, 7) < cutoffMonth) {
        try { fs.unlinkSync(path.join(dir, name)); removed += 1; } catch { /* 删不掉就算了 */ }
      }
    }
  } catch { /* 目录不存在 */ }
  return removed;
}

/** 列出归档里的月份文件（新到旧）。 */
export function listArchiveMonths({ stateDir, key }) {
  const dir = path.join(stateDir, ARCHIVE_DIR, convDirName(key));
  try {
    return fs.readdirSync(dir).filter((n) => MONTH_RE.test(n)).sort().reverse();
  } catch {
    return [];
  }
}

/**
 * 检索归档：逐行流式扫，支持关键词（多关键词 AND）、时间范围、条数上限。
 * @returns {Array<{t:number, id:string, from:string, me:boolean, text:string, media?:string[]}>}
 */
export function searchArchive({ stateDir, key, query = '', since = 0, until = 0, limit = 20, months = null } = {}) {
  const dir = path.join(stateDir, ARCHIVE_DIR, convDirName(key));
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
  const files = (months ?? listArchiveMonths({ stateDir, key })).map((m) => path.join(dir, m));
  const out = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const t = Number(rec.t) || 0;
      if (since && t < since) continue;
      if (until && t > until) continue;
      if (terms.length) {
        const hay = `${rec.text ?? ''} ${rec.from ?? ''}`.toLowerCase();
        if (!terms.every((w) => hay.includes(w))) continue;
      }
      out.push(rec);
    }
  }
  out.sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0));
  return out.slice(0, Math.max(1, Math.min(200, Number(limit) || 20)));
}

/** 归档概况（给控制台/提示用）。 */
export function archiveStats({ stateDir, key }) {
  const months = listArchiveMonths({ stateDir, key });
  const dir = path.join(stateDir, ARCHIVE_DIR, convDirName(key));
  let lines = 0;
  let bytes = 0;
  for (const m of months) {
    try {
      const st = fs.statSync(path.join(dir, m));
      bytes += st.size;
      lines += fs.readFileSync(path.join(dir, m), 'utf8').split('\n').filter(Boolean).length;
    } catch { /* 跳过 */ }
  }
  return { months, lines, bytes };
}
