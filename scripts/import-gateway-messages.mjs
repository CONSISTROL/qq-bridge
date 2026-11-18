#!/usr/bin/env node
// 把 gateway-db-export.py 导出的消息（JSON lines）导入桥接归档，按 messageId 去重。
// 用法：node scripts/import-gateway-messages.mjs /tmp/gap-all.jsonl
import fs from 'node:fs';
import path from 'node:path';
import { appendArchive, toArchiveRecord } from '../src/memory-archive.js';

const STATE = path.join(process.cwd(), 'state');
const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('缺少输入文件'); process.exit(1); }
const convDir = (key) => key.replace(/^group:/, 'group_').replace(/^private:/, 'private_');

const recs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const known = new Map();
for (const rec of recs) {
  const key = `${rec.isGroup ? 'group' : 'private'}:${rec.session}`;
  if (!known.has(key)) {
    const dir = path.join(STATE, 'messages', convDir(key));
    const ids = new Set();
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
        for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { const r = JSON.parse(line); ids.add(String(r.id ?? r.messageId ?? '')); } catch { /* skip */ }
        }
      }
    }
    known.set(key, ids);
  }
}

let added = 0, skipped = 0;
for (const rec of recs) {
  if (rec.isSelf) { skipped += 1; continue; }
  const key = `${rec.isGroup ? 'group' : 'private'}:${rec.session}`;
  const ids = known.get(key);
  if (!rec.messageId || ids.has(rec.messageId)) { skipped += 1; continue; }
  appendArchive({
    stateDir: STATE,
    key,
    record: toArchiveRecord({
      time: rec.ts, messageId: rec.messageId, sender: rec.sender, isSelf: false,
      text: rec.text, media: []
    }),
    keepDays: 0
  });
  ids.add(rec.messageId);
  added += 1;
}
console.log(`导入完成：新增 ${added} 条，跳过 ${skipped} 条`);
