// 第二级记忆：日记本。把每天的消息浓缩成一篇日记，落盘、可检索、可回看。
//
// 为什么不让模型"自己记"：一二代仿真里模型每轮只看到最近的上下文，跨天的事它记不住；
// 而第三级（全量归档）信息太散，直接喂进上下文又太贵。日记是两者的折中：
//   · 生成：每天一次（凌晨汇总前一天），由机器人自己按归档写，写完调 qq_diary_save 存下来；
//   · 内容：只写结论与线索（话题、决定、人物印象、没聊完的事），**不写流水**；
//   · 召回：按日期/关键词查，命中后再去第三级取原文核对（防止日记把话说死说错）。
import fs from 'node:fs';
import path from 'node:path';
import { convDirName } from './memory-archive.js';

export const DIARY_DIR = 'diary';
const DAY_RE = /^\d{4}-\d{2}-\d{2}\.json$/;

/** 某天的日期字符串（本地时区）。 */
export function dayKey(ms = Date.now()) {
  const d = new Date(Number(ms) || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function diaryPath({ stateDir, key, day }) {
  return path.join(stateDir, DIARY_DIR, convDirName(key), `${day}.json`);
}

/**
 * 保存/覆盖一条日记。
 * @returns {{ok:true, day:string, file:string}|{ok:false, error:string}}
 */
export function saveDiary({ stateDir, key, day = dayKey(), summary = '', topics = [], openThreads = [], members = {}, rawCount = 0, now = Date.now() } = {}) {
  const d = String(day);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: 'day 必须是 YYYY-MM-DD' };
  const text = String(summary ?? '').trim().slice(0, 4000);
  if (!text) return { ok: false, error: 'summary 不能为空' };
  const file = diaryPath({ stateDir, key, day: d });
  const entry = {
    day: d,
    summary: text,
    topics: (Array.isArray(topics) ? topics : String(topics ?? '').split(/[,，、\s]+/)).map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 12),
    openThreads: (Array.isArray(openThreads) ? openThreads : []).map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 8),
    members: members && typeof members === 'object' ? members : {},
    rawCount: Math.max(0, Number(rawCount) || 0),
    updatedAt: now
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entry, null, 2) + '\n', 'utf8');
    return { ok: true, day: d, file };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 列出日记（新到旧），可只列最近 n 天。 */
export function listDiary({ stateDir, key, limit = 30 } = {}) {
  const dir = path.join(stateDir, DIARY_DIR, convDirName(key));
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => DAY_RE.test(n)).sort().reverse(); } catch { return []; }
  const out = [];
  for (const n of names.slice(0, Math.max(1, Math.min(400, Number(limit) || 30)))) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch { /* 跳过坏文件 */ }
  }
  return out;
}

/** 读某天的日记（没有就 null）。 */
export function readDiary({ stateDir, key, day }) {
  try { return JSON.parse(fs.readFileSync(diaryPath({ stateDir, key, day: String(day) }), 'utf8')); } catch { return null; }
}

/**
 * 检索日记：按关键词（AND）+ 时间范围；返回按日期倒序的命中条目。
 * 召回层用它先找"哪天聊过"，再决定要不要去第三级取原文。
 */
export function searchDiary({ stateDir, key, query = '', sinceDay = '', untilDay = '', limit = 10 } = {}) {
  const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
  const all = listDiary({ stateDir, key, limit: 400 });
  const hits = [];
  for (const e of all) {
    if (sinceDay && e.day < sinceDay) continue;
    if (untilDay && e.day > untilDay) continue;
    if (terms.length) {
      const hay = `${e.summary ?? ''} ${(e.topics || []).join(' ')} ${(e.openThreads || []).join(' ')} ${Object.keys(e.members || {}).join(' ')}`.toLowerCase();
      if (!terms.every((w) => hay.includes(w))) continue;
    }
    hits.push(e);
  }
  return hits.slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
}

/**
 * 判定一段话是不是在问"过去的事"（决定要不要自动召回）。
 * 命中就建议注入「日记命中 + 原文锚点」，而不是把日记整篇塞进上下文。
 */
export function looksLikeMemoryQuery(text = '') {
  const t = String(text ?? '');
  if (!t.trim()) return false;
  return /(还记得|记不记得|之前说|上次说|上回|上个月|前几天|以前|那时候|当初|老早|翻旧账|你忘|回忆)/.test(t);
}
