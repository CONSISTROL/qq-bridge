#!/usr/bin/env node
// 把 state/MEMORY.md 的条目迁进 memory.db（tags 带 pinned），让"常驻笔记"和"记忆条目"共用一份存储。
import fs from 'node:fs';
import path from 'node:path';
import { upsertItem, listItems } from '../src/memdb.js';

const STATE = path.join(process.cwd(), 'state');
const file = path.join(STATE, 'MEMORY.md');
if (!fs.existsSync(file)) { console.log('没有 MEMORY.md'); process.exit(0); }

const lines = fs.readFileSync(file, 'utf8').split('\n');
const existing = new Set(listItems({ stateDir: STATE, limit: 500 }).map((x) => String(x.text).trim()));
let section = '事件';
let added = 0, skipped = 0;
for (const raw of lines) {
  const line = raw.trim();
  const m = /^##\s*(.+)$/.exec(line);
  if (m) { section = m[1].trim(); continue; }
  const b = /^[-*]\s+(.+)$/.exec(line);
  if (!b) continue;
  const text = b[1].replace(/\s+/g, ' ').trim();
  if (text.length < 4) continue;
  if (existing.has(text)) { skipped += 1; continue; }
  const r = upsertItem({ stateDir: STATE, item: { kind: 'fact', scope: 'all', text, tags: `pinned,${section}` } });
  if (r.ok) { added += 1; existing.add(text); }
}
console.log(`迁移完成：新增 ${added} 条，跳过重复 ${skipped} 条`);
