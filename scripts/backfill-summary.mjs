// 把历史归档重新压成「滚动摘要」写回会话状态（一次性补历史）。
// 用法：node scripts/backfill-summary.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { summarizeRecords } from '../src/chat-summary.js';
import { upsertItem } from '../src/memdb.js';

const STATE = path.resolve(import.meta.dirname, '..', 'state');
const SOCIAL = path.join(STATE, 'social.json');
const ARCHIVE = path.join(STATE, 'messages');
const dry = process.argv.includes('--dry');

const convDirToKey = (name) => {
  const m = /^(group|private)_(\d+)$/.exec(name);
  return m ? `${m[1]}:${m[2]}` : '';
};

if (!fs.existsSync(ARCHIVE)) { console.log('没有归档目录'); process.exit(0); }
const social = JSON.parse(fs.readFileSync(SOCIAL, 'utf8'));
social.conversations = social.conversations || {};

let total = 0;
for (const dir of fs.readdirSync(ARCHIVE)) {
  const key = convDirToKey(dir);
  if (!key) continue;
  const folder = path.join(ARCHIVE, dir);
  const files = fs.readdirSync(folder).filter((f) => f.endsWith('.jsonl')).sort();
  const records = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(folder, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
  }
  if (!records.length) continue;
  // 每 200 条压一段，作为 kind=summary 的记忆条目入库（按相关度召回）
  const fmt = (t) => new Date(Number(t) || Date.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  let made = 0;
  for (let i = 0; i < records.length; i += 200) {
    const chunk = records.slice(i, i + 200);
    const sum = summarizeRecords(chunk, { maxChars: 500 });
    if (!sum) continue;
    const first = chunk[0]?.t || chunk[0]?.time || chunk[0]?.at || Date.now();
    const last = chunk[chunk.length - 1]?.t || chunk[chunk.length - 1]?.time || chunk[chunk.length - 1]?.at || Date.now();
    const tags = [...new Set((sum.match(/高频词：([^；]+)/)?.[1] || '').split('、').filter(Boolean))].slice(0, 8);
    upsertItem({
      stateDir: STATE,
      item: {
        id: `summary:${key}:${last}`,
        kind: 'summary',
        scope: key,
        text: `【${key}】${fmt(first)} ~ ${fmt(last)} 的聊天（${chunk.length} 条）：${sum}`,
        tags,
        at: Number(last) || Date.now()
      }
    });
    made += 1;
  }
  console.log(`${key}: ${records.length} 条归档 → ${made} 条 summary 记忆`);
  total += made;
  continue;
  total += 1;
}
if (!dry) fs.writeFileSync(SOCIAL, JSON.stringify(social, null, 2) + '\n');
console.log(`\n${dry ? '(dry-run) ' : ''}写入 ${total} 条 summary 记忆`);
