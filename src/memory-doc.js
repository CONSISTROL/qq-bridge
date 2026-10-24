// AI 自己维护的笔记（MEMORY.md）：明文、可按人/梗/约定分区，AI 可读写，人也能直接编辑。
//
// 和 memory.db 的分工：
//   · memory.db = 机器检索用的条目（向量/关键词召回，量大）；
//   · MEMORY.md = **常驻**的稳定认知（谁是谁、什么梗、什么约定），每轮都注入，几百字以内。
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'MEMORY.md';
const SECTIONS = ['人物', '群梗', '约定', '事件'];
const MAX_CHARS = 6000;

export const memoryDocPath = (stateDir) => path.join(stateDir, FILE);

const initialDoc = () => `# 我的记忆笔记

> 这是你自己维护的笔记：谁是谁、群里什么梗、跟主人有什么约定。
> 用 qq_memory_write 增删改（op=add/replace/remove），用 qq_memory_read 看全文。
> 只记**长期有用**的结论，不要记流水账；一段十几字就够。

## 人物

## 群梗

## 约定

## 事件
`;

export function readMemoryDoc({ stateDir = './state' } = {}) {
  try {
    const txt = fs.readFileSync(memoryDocPath(stateDir), 'utf8');
    return txt.length > MAX_CHARS ? txt.slice(0, MAX_CHARS) : txt;
  } catch {
    const doc = initialDoc();
    try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(memoryDocPath(stateDir), doc); } catch { /* 忽略 */ }
    return doc;
  }
}

export function writeMemoryDoc({ stateDir = './state', content = '' } = {}) {
  const txt = String(content ?? '');
  if (txt.length > MAX_CHARS) return { ok: false, error: `笔记太长（上限 ${MAX_CHARS} 字），先精简` };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(memoryDocPath(stateDir), txt);
    return { ok: true, length: txt.length };
  } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
}

/** 在某个分区下加一行（分区不存在就建）。 */
export function addNote({ stateDir = './state', section = '事件', text = '' } = {}) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!line) return { ok: false, error: '内容不能为空' };
  const sec = SECTIONS.includes(section) ? section : '事件';
  let doc = readMemoryDoc({ stateDir });
  const entry = `- ${line}`;
  if (doc.includes(entry)) return { ok: true, unchanged: true };
  const head = `## ${sec}`;
  if (doc.includes(head)) {
    const i = doc.indexOf(head);
    const nextSection = SECTIONS.map((s) => doc.indexOf(`## ${s}`, i + head.length)).filter((k) => k > i).sort((a, b) => a - b)[0];
    const insertAt = nextSection === undefined ? doc.length : nextSection;
    const before = doc.slice(0, insertAt).replace(/\s*$/, '\n');
    doc = `${before}${entry}\n\n${doc.slice(insertAt)}`;
  } else {
    doc = `${doc.replace(/\s*$/, '')}\n\n${head}\n\n${entry}\n`;
  }
  return writeMemoryDoc({ stateDir, content: doc });
}

/** 替换：把包含 match 的那一行换成 text；找不到就返回 notfound。 */
export function replaceNote({ stateDir = './state', match = '', text = '' } = {}) {
  const m = String(match ?? '').trim();
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!m || !t) return { ok: false, error: 'match / text 都不能为空' };
  const doc = readMemoryDoc({ stateDir });
  const lines = doc.split('\n');
  const idx = lines.findIndex((l) => l.trim().startsWith('- ') && l.includes(m));
  if (idx === -1) return { ok: false, error: `笔记里没找到包含「${m}」的条目` };
  lines[idx] = `- ${t.slice(0, 200)}`;
  return writeMemoryDoc({ stateDir, content: lines.join('\n') });
}

/** 删除：把包含 match 的那一行删掉。 */
export function removeNote({ stateDir = './state', match = '' } = {}) {
  const m = String(match ?? '').trim();
  if (!m) return { ok: false, error: 'match 不能为空' };
  const doc = readMemoryDoc({ stateDir });
  const lines = doc.split('\n');
  const before = lines.length;
  const kept = lines.filter((l) => !(l.trim().startsWith('- ') && l.includes(m)));
  if (kept.length === before) return { ok: false, error: `笔记里没找到包含「${m}」的条目` };
  return writeMemoryDoc({ stateDir, content: kept.join('\n') });
}
