#!/usr/bin/env node
// 把 social.json 的 recentMessages 里"还没进归档"的消息补进归档（补拉/历史同步的旧账）。
import fs from 'node:fs';
import path from 'node:path';
import { appendArchive, toArchiveRecord } from '../src/memory-archive.js';

const STATE = path.join(process.cwd(), 'state');
const social = JSON.parse(fs.readFileSync(path.join(STATE, 'social.json'), 'utf8'));
const convDir = (key) => key.replace(/^group:/, 'group_').replace(/^private:/, 'private_');

let added = 0;
for (const [key, st] of Object.entries(social.conversations || {})) {
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
  for (const m of st.recentMessages || []) {
    const mid = String(m?.messageId ?? m?.id ?? '');
    if (!mid || ids.has(mid) || m.isSelf) continue;
    const rec = toArchiveRecord({
      time: Number(m.time) || Date.now(),
      messageId: mid,
      sender: m.sender || '',
      isSelf: false,
      text: m.plain || m.text || '',
      media: m.media || []
    });
    if (!rec.text || String(rec.text).trim().length < 1) continue;
    appendArchive({ stateDir: STATE, key, record: rec, keepDays: 0 });
    ids.add(mid);
    added += 1;
  }
}
console.log('补进归档的消息:', added, '条');
