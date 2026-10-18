// 相册的纯逻辑自检：来源扫描 / 元数据合并 / 备注保存 / 统计。
// 运行：node scripts/test-album.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectAlbumItems, updateAlbumMeta, albumStats, saveChatImage,
  listSourceFiles, readSourceIndex, isAlbumImageName, itemId
} from '../src/album.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'album-test-'));
const ctx = { root: path.join(tmp, 'repo'), stateDir: path.join(tmp, 'state') };
const dirs = {
  library: path.join(ctx.root, 'assets', 'stickers'),
  pixiv: path.join(ctx.stateDir, 'pixiv-picks'),
  video: path.join(ctx.stateDir, 'video-cache'),
  sent: path.join(ctx.stateDir, 'sent-images'),
  chat: path.join(ctx.stateDir, 'album-inbox')
};
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(dirs.library, 'a.jpg'), Buffer.alloc(10));
fs.writeFileSync(path.join(dirs.library, 'b.png'), Buffer.alloc(20));
fs.writeFileSync(path.join(dirs.library, 'index.json'), JSON.stringify({ items: [{ file: 'a.jpg', title: '图库标题', tags: ['图库'] }] }));
fs.writeFileSync(path.join(dirs.pixiv, 'p.jpg'), Buffer.alloc(30));
fs.writeFileSync(path.join(dirs.chat, 'group-1050666134-777-1.jpg'), Buffer.alloc(40));

console.log('\n[1] 基础工具');
ok('图片扩展名识别', isAlbumImageName('x.JPG') && !isAlbumImageName('x.txt') && !isAlbumImageName('x.json'));
ok('条目 id 带来源前缀', itemId('library', 'a.jpg') === 'library:a.jpg');
ok('列目录会跳过索引文件', (() => { const f = listSourceFiles(dirs.library, 'index.json'); return f.length === 2 && !f.includes('index.json'); })());
ok('读索引拿到标题', readSourceIndex(dirs.library, 'index.json').get('a.jpg')?.title === '图库标题');

console.log('\n[2] 汇总与元数据');
const meta = {
  'pixiv:p.jpg': { notes: '我写的备注', tags: ['猫'], addedAt: 1000 }
};
const items = collectAlbumItems({ ctx, meta, listFiles: (dir, indexFile) => listSourceFiles(dir, indexFile) });
ok('四个来源都扫到', items.length === 4, `实际 ${items.length}`);
const libA = items.find((it) => it.id === 'library:a.jpg');
ok('图库条目带索引里的备注', libA?.notes === '图库标题', libA?.notes);
const pixiv = items.find((it) => it.id === 'pixiv:p.jpg');
ok('自定义备注覆盖索引', pixiv?.notes === '我写的备注' && pixiv?.tags.join() === '猫');
ok('自定义 addedAt 生效', pixiv?.addedAt === 1000);
const chat = items.find((it) => it.source === 'chat');
ok('聊天图能扫到', chat?.file === 'group-1050666134-777-1.jpg');
ok('按添加时间倒序', items.every((it, i) => i === 0 || items[i - 1].addedAt >= it.addedAt));

console.log('\n[3] 备注更新');
let m2 = updateAlbumMeta({}, 'library:a.jpg', { notes: ' 新备注 ', tags: '猫, 无语，猫' }, 5);
ok('备注去空格、标签去重限长', m2['library:a.jpg'].notes === '新备注' && m2['library:a.jpg'].tags.length === 2, JSON.stringify(m2));
let m3 = updateAlbumMeta(m2, 'library:a.jpg', { notes: '', tags: [] }, 6);
ok('清空备注+标签后条目被删掉', !m3['library:a.jpg'], JSON.stringify(m3));
const m4 = updateAlbumMeta(m2, 'x:y.jpg', { notes: 'z'.repeat(999) });
ok('备注超长截断到 500', m4['x:y.jpg'].notes.length === 500);

console.log('\n[4] 统计与落盘');
const st = albumStats(items);
ok('统计总数与字节', st.count === items.length && st.bytes === 100, JSON.stringify(st));
ok('按来源计数', st.bySource.library === 2 && st.bySource.pixiv === 1, JSON.stringify(st.bySource));
const id = saveChatImage({ ctx, buffer: Buffer.from('xx'), name: 'group:1050666134' });
ok('聊天图落盘命名安全（冒号替换）', id === 'chat:group_1050666134.jpg', id);
ok('文件真的写出来了', fs.existsSync(path.join(dirs.chat, 'group_1050666134.jpg')));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
