// 把历史归档重新压成「滚动摘要」写回会话状态（一次性补历史）。
// 用法：node scripts/backfill-summary.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { summarizeRecords, mergeSummary } from '../src/chat-summary.js';

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
  // 每 200 条压一段，再滚动合并（和线上裁剪同样的口径）
  let summary = '';
  for (let i = 0; i < records.length; i += 200) {
    const chunk = records.slice(i, i + 200);
    const s1 = summarizeRecords(chunk, { maxChars: 500 });
    if (s1) summary = mergeSummary(summary, s1, { maxChars: 1400 });
  }
  const conv = social.conversations[key] || (social.conversations[key] = {});
  conv.rollingSummary = summary;
  total += 1;
  console.log(`${key}: ${records.length} 条归档 → 摘要 ${summary.length} 字`);
  if (summary) console.log('   ' + summary.split('\n').slice(-2).join('\n   ').slice(0, 300));
}
if (!dry) fs.writeFileSync(SOCIAL, JSON.stringify(social, null, 2) + '\n');
console.log(`\n${dry ? '(dry-run) ' : ''}处理了 ${total} 个会话的摘要`);
