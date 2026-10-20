// 运行：node scripts/test-memory.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendArchive, searchArchive, archiveStats, pruneArchive, listArchiveMonths,
  convDirName, monthOf, toArchiveRecord
} from '../src/memory-archive.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`); } };

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-test-'));
const key = 'group:1050666134';

console.log('\n[1] 第三级：归档追加与检索');
appendArchive({ stateDir, key, record: toArchiveRecord({ time: Date.now() - 3600_000, messageId: '1', sender: '面包屑', text: '今天聊了 s16 的冠军预测' }) });
appendArchive({ stateDir, key, record: toArchiveRecord({ time: Date.now() - 1800_000, messageId: '2', sender: '我', isSelf: true, text: '我觉得是 T1' }) });
appendArchive({ stateDir, key, record: toArchiveRecord({ time: Date.now(), messageId: '3', sender: '米哈游', text: '还有社保新规那条' }) });
const st = archiveStats({ stateDir, key });
ok('归档写进去了（3 条）', st.lines === 3, JSON.stringify(st));
ok('按月分文件', st.months.length === 1 && /^\d{4}-\d{2}\.jsonl$/.test(st.months[0]), st.months.join());
const hit1 = searchArchive({ stateDir, key, query: 's16' });
ok('关键词命中', hit1.length === 1 && hit1[0].text.includes('s16'), JSON.stringify(hit1.map((h) => h.text)));
const hit2 = searchArchive({ stateDir, key, query: 's16 T1' });
ok('多关键词是 AND（跨消息不命中）', hit2.length === 0, JSON.stringify(hit2));
const hit3 = searchArchive({ stateDir, key, query: '社保' });
ok('中文关键词正常', hit3.length === 1 && hit3[0].from === '米哈游');
ok('结果按时间倒序', searchArchive({ stateDir, key })[0].text.includes('社保'));
ok('since 过滤生效', searchArchive({ stateDir, key, since: Date.now() - 600_000 }).length === 1);
ok('条数上限生效', searchArchive({ stateDir, key, limit: 1 }).length === 1);
ok('空关键词返回最近几条', searchArchive({ stateDir, key }).length === 3);
ok('自己发的也归档了', searchArchive({ stateDir, key }).some((h) => h.me && h.text.includes('T1')));

console.log('\n[2] 第三级：保留期');
const now = Date.now();
const oldMonth = new Date(now - 200 * 86400000);
const oldDay = `${oldMonth.getFullYear()}-${String(oldMonth.getMonth() + 1).padStart(2, '0')}-15`;
const dir = path.join(stateDir, 'messages', convDirName(key));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${oldDay.slice(0, 7)}.jsonl`), '{"t":1,"text":"很老的消息"}\n');
const before = listArchiveMonths({ stateDir, key }).length;
const removed = pruneArchive({ stateDir, key, keepDays: 90, now });
ok('超过保留期的月文件被删', removed === 1 && listArchiveMonths({ stateDir, key }).length === before - 1, `removed=${removed}`);
ok('归档目录名安全（冒号替换）', convDirName('group:1') === 'group_1');

console.log('\n[4] 召回触发词');

fs.rmSync(stateDir, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
