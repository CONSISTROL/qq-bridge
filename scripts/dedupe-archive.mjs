#!/usr/bin/env node
// 一次性清理归档里的重复 messageId（实时事件 + 掉线补拉会各写一次）。
// 用法：node scripts/dedupe-archive.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const dir = path.join(process.cwd(), 'state', 'messages');
if (!fs.existsSync(dir)) { console.log('没有归档目录'); process.exit(0); }

let totalDup = 0, totalFiles = 0;
for (const conv of fs.readdirSync(dir)) {
  const cdir = path.join(dir, conv);
  if (!fs.statSync(cdir).isDirectory()) continue;
  for (const name of fs.readdirSync(cdir).filter((n) => n.endsWith('.jsonl'))) {
    const file = path.join(cdir, name);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const seen = new Set();
    const out = [];
    let dup = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec = null;
      try { rec = JSON.parse(line); } catch { out.push(line); continue; }
      const id = String(rec?.id ?? rec?.messageId ?? '');
      if (id) {
        if (seen.has(id)) { dup += 1; continue; }
        seen.add(id);
      }
      out.push(line);
    }
    if (!dup) continue;
    totalDup += dup; totalFiles += 1;
    console.log(`${conv}/${name}: 去掉 ${dup} 条重复（${lines.length - 1} → ${out.length}）`);
    if (!DRY) {
      const bak = `${file}.bak-${Date.now()}`;
      fs.copyFileSync(file, bak);
      fs.writeFileSync(file, out.join('\n') + '\n');
      console.log(`  备份：${path.basename(bak)}`);
    }
  }
}
console.log(`${DRY ? '（dry-run）' : ''}共清理 ${totalDup} 条，涉及 ${totalFiles} 个文件`);
