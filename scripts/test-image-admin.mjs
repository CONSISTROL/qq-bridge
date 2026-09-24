// AI 图片管理自检（src/image-admin.js）。
//
// 覆盖：清单统计（每类来源多少张/多少字节/索引对得上吗）、缩略图定位、
//       逐张删 → 回收站、还原（含回收站批次级与单张级）、彻底删除、
//       整目录清空、自然清理（保留天数 + 总容量上限）、回收站容量淘汰、
//       路径穿越/符号链接/未知来源/非图片文件等安全边界。
//
//   node scripts/test-image-admin.mjs          # 纯函数层（临时目录，不碰真实 assets/ 与 state/）
//   node scripts/test-image-admin.mjs --e2e    # 额外跑一遍真实桥接的 /api/ai-images* 接口
//
// e2e 会用一个临时 state 目录 + 配置起桥接，并把受管来源全部指向临时目录（不碰真实图库），
// 跑完自动关掉；需要本机没有占用它选的端口。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createImageAdmin,
  defaultImageSources,
  safeImageName,
  isImageFileName,
  mimeOfImageName,
  resolveInsideDir,
  normalizeImageSources
} from '../src/image-admin.js';
import { createSentImageStore, extFromBuffer, originLabel } from '../src/sent-images.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label}（期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}）`); }

const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeImage(file, bytes = 100) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
}

function makeFixture({ trashMaxBytes = 0, withSymlink = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-images-'));
  const stateDir = path.join(root, 'state');
  const libDir = path.join(root, 'assets', 'stickers');
  const picksDir = path.join(stateDir, 'pixiv-picks');
  const cacheDir = path.join(stateDir, 'video-cache');
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(picksDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  writeImage(path.join(libDir, 'bili-cover-aaaa.jpg'), 100);
  writeImage(path.join(libDir, 'style-bbbb.png'), 200);
  write(path.join(libDir, 'notes.txt'), 'not an image');
  write(path.join(libDir, 'index.json'), JSON.stringify({
    version: 1,
    items: [
      { file: 'bili-cover-aaaa.jpg', title: 'B站封面', source: 'cover', origin: 'BV1xx', bytes: 100 },
      { file: 'style-bbbb.png', title: '风格图', source: 'style', bytes: 200 },
      { file: 'ghost.jpg', title: '索引里有、磁盘上没有', source: 'style', bytes: 1 }
    ]
  }, null, 2));

  writeImage(path.join(picksDir, '149946957.jpg'), 300);
  // 视频缓存比图库旧 40 天：自然清理的「保留天数」规则要能只挑中它
  const old = new Date(Date.now() - 40 * DAY);
  fs.utimesSync(path.join(picksDir, '149946957.jpg'), old, old);
  writeImage(path.join(cacheDir, '40362969509-2.jpg'), 400);

  const outside = path.join(root, 'outside.jpg');
  writeImage(outside, 50);
  if (withSymlink) {
    try { fs.symlinkSync(outside, path.join(libDir, 'link.jpg')); } catch { /* 平台不支持就跳过 */ }
  }

  const mutations = [];
  const admin = createImageAdmin({
    root,
    stateDir,
    sources: defaultImageSources({ root, stateDir }),
    trashMaxBytes,
    onMutate: (info) => mutations.push(info)
  });
  return { root, stateDir, libDir, picksDir, cacheDir, outside, admin, mutations };
}

// ── 1. 文件名与路径边界 ──────────────────────────────────────────────
console.log('— 文件名与路径边界 —');
{
  eq(safeImageName('a.jpg'), 'a.jpg', '普通文件名通过');
  eq(safeImageName('  b.PNG  '), 'b.PNG', '去掉空白、后缀大小写不敏感');
  eq(safeImageName('../etc/passwd'), '', '拒绝路径穿越');
  eq(safeImageName('a/../../b.jpg'), '', '拒绝内嵌斜杠');
  eq(safeImageName('..\\win.jpg'), '', '拒绝反斜杠');
  eq(safeImageName('.hidden.jpg'), '', '拒绝隐藏文件');
  eq(safeImageName('..jpg'), '', '拒绝以点开头的名字');
  eq(safeImageName('notes.txt'), '', '拒绝非图片后缀');
  eq(safeImageName(''), '', '拒绝空名');
  eq(safeImageName('a'.repeat(300) + '.jpg'), '', '拒绝超长名字');
  eq(isImageFileName('x.JPEG'), true, 'JPEG 大小写都算图片');
  eq(mimeOfImageName('x.webp'), 'image/webp', '按后缀给 MIME');
  let threw = false;
  try { resolveInsideDir('/tmp/whatever', '../x.jpg'); } catch { threw = true; }
  ok(threw, 'resolveInsideDir 对穿越名抛错');
  const norm = normalizeImageSources([
    { id: 'ok', dir: 'state/a' },
    { id: 'bad id', dir: 'state/b' },
    { id: 'ok', dir: 'state/dup' },
    { id: 'nodir' },
    null
  ], '/srv/app');
  eq(norm.length, 1, '来源声明只留下合法且不重复的');
  eq(norm[0].dir, path.resolve('/srv/app', 'state/a'), '相对目录按 root 解析');
}

// ── 2. 清单 ──────────────────────────────────────────────────────────
console.log('— 清单统计 —');
{
  const fx = makeFixture();
  const inv = fx.admin.inventory();
  eq(inv.ok, true, 'inventory 返回 ok');
  const lib = inv.sources.find((s) => s.id === 'library');
  const picks = inv.sources.find((s) => s.id === 'pixivPicks');
  const cache = inv.sources.find((s) => s.id === 'videoCache');
  eq(lib.count, 2, '图库只数图片文件（notes.txt 不算）');
  eq(lib.otherFiles, 2, '非图片文件单独计数（notes.txt + index.json）');
  eq(lib.indexed, 2, '索引里两张图都对得上');
  eq(lib.missing, 1, '索引里失联的条目被标出来');
  eq(lib.orphan, 0, '没有未入索引的图');
  eq(picks.count, 1, 'pixiv 样图清单');
  eq(cache.count, 1, '视频帧缓存清单');
  eq(inv.totals.count, 4, '总数 = 四张图');
  eq(inv.totals.bytes, 100 + 200 + 300 + 400, '总体积');
  eq(inv.trash.batches, 0, '一开始回收站是空的');
  fs.rmSync(fx.root, { recursive: true, force: true });
}

// ── 3. 列表 / 搜索 / 排序 / 缩略图 ───────────────────────────────────
console.log('— 列表与搜索 —');
{
  const fx = makeFixture();
  const all = fx.admin.items({ source: 'library' });
  eq(all.total, 2, '列出图库两张图');
  // 缩略图地址必须是**相对**的（不带开头 /）：否则控制台被反代在子路径下时会被解析到反代自己的根上
  ok(all.items.every((it) => it.thumb.startsWith('api/ai-images/file?source=library&name=')), '每张都带控制台缩略图地址（相对路径）');
  const meta = all.items.find((it) => it.name === 'bili-cover-aaaa.jpg');
  eq(meta.title, 'B站封面', '带上 index.json 里的标题');
  eq(meta.indexed, true, '标明已入索引');
  const q = fx.admin.items({ source: 'library', q: '风格' });
  eq(q.total, 1, '搜索命中标题');
  eq(q.items[0].name, 'style-bbbb.png', '命中的是风格图');
  const byName = fx.admin.items({ source: 'library', sort: 'name' });
  eq(byName.items[0].name, 'bili-cover-aaaa.jpg', '按文件名排序');
  const bySize = fx.admin.items({ source: 'library', sort: 'size' });
  eq(bySize.items[0].name, 'style-bbbb.png', '按体积从大到小');
  const file = fx.admin.fileFor({ source: 'library', name: 'bili-cover-aaaa.jpg' });
  eq(file.mime, 'image/jpeg', '定位文件并给 MIME');
  eq(file.bytes, 100, '定位文件带上体积');
  let bad = false;
  try { fx.admin.fileFor({ source: 'library', name: '../notes.txt' }); } catch { bad = true; }
  ok(bad, '预览接口拒绝穿越名');
  let unknown = false;
  try { fx.admin.items({ source: 'nope' }); } catch { unknown = true; }
  ok(unknown, '未知来源被拒绝');
  fs.rmSync(fx.root, { recursive: true, force: true });
}

// ── 4. 删除 → 回收站 → 还原 ─────────────────────────────────────────
console.log('— 删除与还原 —');
{
  const fx = makeFixture();
  const res = fx.admin.remove({ source: 'library', names: ['bili-cover-aaaa.jpg'] });
  eq(res.ok, true, '删除成功');
  eq(res.removed.length, 1, '删掉一张');
  eq(fs.existsSync(path.join(fx.libDir, 'bili-cover-aaaa.jpg')), false, '原文件已经不在了');
  eq(fs.existsSync(path.join(fx.libDir, 'style-bbbb.png')), true, '别的图不受影响');
  const idx = JSON.parse(fs.readFileSync(path.join(fx.libDir, 'index.json'), 'utf8'));
  eq(idx.items.some((it) => it.file === 'bili-cover-aaaa.jpg'), false, '索引条目同步摘掉');
  eq(idx.items.some((it) => it.file === 'style-bbbb.png'), true, '别的索引条目还在');
  eq(fx.mutations.length, 1, '删除触发了 onMutate（桥接靠它刷新图库缓存）');

  const trash = fx.admin.listTrash();
  eq(trash.batches.length, 1, '回收站里有一个批次');
  eq(trash.batches[0].files, 1, '批次里一张图');
  eq(trash.batches[0].items[0].name, 'bili-cover-aaaa.jpg', '批次里记着原文件名');
  const stamp = trash.batches[0].stamp;

  // 单张还原：索引条目要跟着回来（否则还原的图会变成「未入索引」）
  const back = fx.admin.restore({ stamp, items: [{ source: 'library', name: 'bili-cover-aaaa.jpg' }] });
  eq(back.ok, true, '单张还原成功');
  eq(fs.existsSync(path.join(fx.libDir, 'bili-cover-aaaa.jpg')), true, '文件回到原目录');
  const idx2 = JSON.parse(fs.readFileSync(path.join(fx.libDir, 'index.json'), 'utf8'));
  eq(idx2.items.some((it) => it.file === 'bili-cover-aaaa.jpg'), true, '索引条目也回来了');
  eq(fx.admin.listTrash().batches.length, 0, '整批还原完，批次被清掉');

  // 目标已存在时不覆盖
  const r2 = fx.admin.remove({ source: 'library', names: ['style-bbbb.png'] });
  eq(r2.ok, true, '再删一张');
  writeImage(path.join(fx.libDir, 'style-bbbb.png'), 999); // 手工放回同名文件
  const conflict = fx.admin.restore({ stamp: r2.trash });
  eq(conflict.ok, false, '目标已存在时还原失败而不是覆盖');
  eq(conflict.failed.length, 1, '失败原因逐条回报');
  eq(fs.readFileSync(path.join(fx.libDir, 'style-bbbb.png')).length, 999, '在用的同名文件没被覆盖');
  fs.rmSync(fx.root, { recursive: true, force: true });
}

// ── 5. 整目录清空 + 彻底删除 ─────────────────────────────────────────
console.log('— 清空与彻底删除 —');
{
  const fx = makeFixture();
  const cleared = fx.admin.clear({ source: 'pixivPicks' });
  eq(cleared.ok, true, '清空来源成功');
  eq(cleared.removed.length, 1, '清掉一张');
  eq(fs.readdirSync(fx.picksDir).length, 0, '目录里没有图片了');
  const stamp = cleared.trash;
  const purged = fx.admin.purge({ stamp });
  eq(purged.ok, true, '彻底删除成功');
  eq(purged.purged.files, 1, '彻底删掉一张');
  eq(fs.existsSync(path.join(fx.stateDir, 'image-trash', stamp)), false, '回收站批次目录也没了');
  eq(fx.admin.listTrash().batches.length, 0, '回收站清空后没有批次');
  eq(fx.admin.restore({ stamp }).ok, false, '已被彻底删除的批次还原会失败');
  fs.rmSync(fx.root, { recursive: true, force: true });
}

// ── 6. 自然清理 ──────────────────────────────────────────────────────
console.log('— 自然清理 —');
{
  const fx = makeFixture();
  const noRule = fx.admin.forget({ source: '', olderThanDays: 0, maxTotalMB: 0 });
  eq(noRule.ok, false, '两条规则都没启用时拒绝执行（避免点了没反应）');
  const byAge = fx.admin.forget({ source: 'pixivPicks', olderThanDays: 30, maxTotalMB: 0 });
  eq(byAge.ok, true, '按保留天数清理成功');
  eq(byAge.forgotten.files, 1, '只清掉了 40 天前那张');
  eq(fx.admin.inventory().sources.find((s) => s.id === 'pixivPicks').count, 0, '样图目录空了');
  eq(fx.admin.inventory().sources.find((s) => s.id === 'library').count, 2, '别的来源没被动');
  fs.rmSync(fx.root, { recursive: true, force: true });
}
{
  const fx = makeFixture();
  // 总预算 1024 字节（< 4 张共 1000B？故意设成「刚好要删一点」）：4 张共 1000B > 900B 预算
  const byBudget = fx.admin.forget({ source: '', olderThanDays: 0, maxTotalMB: 900 / 1024 / 1024 });
  eq(byBudget.ok, true, '按容量上限清理成功');
  ok(byBudget.forgotten.budgetDropped >= 1, `超容量时从最旧的开始补删（删了 ${byBudget.forgotten.budgetDropped} 张）`);
  ok(byBudget.forgotten.bySource.pixivPicks, '最旧的样图先被删');
  fs.rmSync(fx.root, { recursive: true, force: true });
}

// ── 7. 回收站容量淘汰 ────────────────────────────────────────────────
console.log('— 回收站容量淘汰 —');
{
  const fx = makeFixture({ trashMaxBytes: 150 }); // 只装得下一张 100B 的图
  fx.admin.remove({ source: 'library', names: ['bili-cover-aaaa.jpg'] }); // 100B
  await sleep(5);
  fx.admin.remove({ source: 'library', names: ['style-bbbb.png'] }); // 200B → 超预算，最旧批次被丢
  const trash = fx.admin.listTrash();
  eq(trash.batches.length, 1, '超预算后只剩一个批次');
  eq(trash.batches[0].items[0].name, 'style-bbbb.png', '留下的是最新那批');
  eq(fx.admin.inventory().trash.bytes, 200, '回收站占用按批次统计');
  fs.rmSync(fx.root, { recursive: true, force: true });
}

// ── 8. 符号链接逃逸 ─────────────────────────────────────────────────
console.log('— 符号链接 —');
{
  const fx = makeFixture({ withSymlink: true });
  const link = path.join(fx.libDir, 'link.jpg');
  if (fs.existsSync(link)) {
    let served = false;
    try { fx.admin.fileFor({ source: 'library', name: 'link.jpg' }); } catch { served = true; }
    ok(served, '指向目录外的软链不能被预览');
    const res = fx.admin.remove({ source: 'library', names: ['link.jpg'] });
    eq(res.removed.length, 0, '指向目录外的软链不能被删进回收站');
    eq(res.failed.length, 1, '并且如实回报失败原因');
    eq(fs.existsSync(fx.outside), true, '目录外的真实文件毫发无损');
  } else {
    ok(true, '（当前平台不支持符号链接，跳过）');
    ok(true, '（当前平台不支持符号链接，跳过）');
    ok(true, '（当前平台不支持符号链接，跳过）');
    ok(true, '（当前平台不支持符号链接，跳过）');
  }
  fs.rmSync(fx.root, { recursive: true, force: true });
}

// ── 9. AI 发出去的网络图（src/sent-images.js）──────────────────────────
console.log('— 发出的图落盘 —');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sent-'));
  const store = createSentImageStore({ dir: path.join(root, 'sent-images'), maxBytes: 0 });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(97, 1)]);
  const first = store.store({ buffer: jpeg, url: 'https://i.pximg.net/img-original/img/2026/09/22/07/00/02/149957497_p0.jpg', key: 'group:1050666134', kind: 'send', delivered: true, rendition: 'large', artworkId: '149957497', width: 1200, height: 1600 });
  ok(first && /\.jpg$/.test(first.file), '按字节嗅探出 .jpg（URL 写的 png 也不上当）');
  eq(first.artworkId, '149957497', '落盘时带上调用方认出的 pixiv 作品 id');
  eq(first.origin, 'group:1050666134 · 发图', '索引里记着从哪个会话发出去的');
  eq(first.title, 'pixiv 149957497 · large', '标题带作品 id 与档位');
  eq(first.delivered, true, '如实记下送达状态');
  eq(store.records().length, 1, '索引里有一条');
  ok(fs.existsSync(path.join(store.dir, first.file)), '文件真的写到磁盘上了');

  const again = store.store({ buffer: jpeg, url: 'https://pixiv.re/149957497.png', key: 'group:1050666134', kind: 'send' });
  eq(again.duplicate, true, '同一张（sha256 相同）不重复占盘');
  eq(store.records().length, 1, '索引里仍然只有一条');

  // 认不出作品 id 的（比如 B站图）就用 URL 文件名当标题，至少能认出来源
  const generic = store.store({ buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(49, 9)]), url: 'https://i0.hdslb.com/bfs/new_dyn/abc.gif', key: 'group:1', kind: 'send' });
  eq(generic.title, 'abc.gif', '没有作品 id 时退回 URL 文件名当标题');
  eq(generic.artworkId, '', '非 pixiv 地址没有作品 id');

  store.update(first.file, { delivered: false, messageId: '9' });
  const updated = store.records()[0];
  eq(updated.delivered, false, '发送后能回填「其实没送达」');
  eq(updated.messageId, '9', '回填 message_id');

  eq(extFromBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '.png', 'PNG 魔数');
  eq(extFromBuffer(Buffer.from('GIF89a', 'latin1')), '.gif', 'GIF 魔数');
  eq(extFromBuffer(Buffer.from('RIFF0000WEBP', 'latin1')), '.webp', 'WebP 魔数');
  eq(extFromBuffer(Buffer.from('nonsense')), '', '认不出来就交回空串');
  eq(originLabel({ key: 'private:1472298635', kind: 'sticker' }), 'private:1472298635 · 存表情', '存表情的出处写法');

  store.store({ buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(197, 2)]), url: 'https://example.com/b.png', key: 'k', kind: 'backfill' });
  const capped = createSentImageStore({ dir: path.join(root, 'capped'), maxBytes: 150 });
  capped.store({ buffer: Buffer.alloc(100, 3), url: 'https://a/1.jpg' });
  capped.store({ buffer: Buffer.alloc(100, 4), url: 'https://a/2.jpg' });
  capped.store({ buffer: Buffer.alloc(100, 5), url: 'https://a/3.jpg' });
  const left = capped.records();
  eq(left.length, 1, '超容量上限时只留最新的（至少留一张）');
  eq(fs.readdirSync(capped.dir).filter((f) => /\.jpg$/.test(f)).length, 1, '被丢的文件也从磁盘删掉了');
  fs.rmSync(root, { recursive: true, force: true });

  const defs = defaultImageSources({ root: '/repo', stateDir: '/repo/state' });
  const sent = defs.find((s) => s.id === 'sentImages');
  ok(sent && sent.dir === path.join('/repo/state', 'sent-images') && sent.index === 'index.json',
    '默认受管来源里就有「AI 发出去的网络图」（控制台一进来就能管）');
}

// ── 10. e2e：真实桥接的 HTTP 接口 ─────────────────────────────────────
if (process.argv.includes('--e2e')) {
  console.log('— e2e：/api/ai-images* 接口 —');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-images-e2e-'));
  const stateDir = path.join(root, 'state');
  const libDir = path.join(root, 'library');
  const picksDir = path.join(stateDir, 'picks');
  const port = 3398;
  const token = 'test-console-token';
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(picksDir, { recursive: true });
  writeImage(path.join(libDir, 'a.jpg'), 120);
  writeImage(path.join(libDir, 'b.png'), 240);
  write(path.join(libDir, 'index.json'), JSON.stringify({ version: 1, items: [{ file: 'a.jpg', title: 'e2e 图', source: 'style', bytes: 120 }] }, null, 2));
  writeImage(path.join(picksDir, 'p.jpg'), 360);

  fs.writeFileSync(path.join(stateDir, 'console-token'), token, 'utf8');
  // config.json 必须在 spawn 之前写好：桥接启动时只读一次
  write(path.join(stateDir, 'config.json'), JSON.stringify({
    dsh: { baseUrl: 'http://127.0.0.1:9', authToken: '' },
    snowluma: { wsUrl: 'ws://127.0.0.1:9', httpUrl: 'http://127.0.0.1:9' },
    consolePort: port,
    consoleToken: token,
    ownerQQ: 1472298635,
    slang: { enabled: false },
    knowledge: { enabled: false },
    rag: { enabled: false },
    imageAdmin: {
      trashMaxMB: 50,
      // 受管来源全部指向临时目录：e2e 绝不碰真实图库
      sources: [
        { id: 'library', title: 'e2e 图库', dir: libDir, index: 'index.json', note: 'e2e' },
        { id: 'pixivPicks', title: 'e2e 样图', dir: picksDir, note: 'e2e' }
      ]
    }
  }, null, 2));

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      QQ_BRIDGE_STATE_DIR: stateDir,
      QQ_BRIDGE_CONFIG: path.join(stateDir, 'config.json'),
      QQ_BRIDGE_CONSOLE_PORT: String(port),
      QQ_BRIDGE_NO_DSH: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let childLog = '';
  child.stdout.on('data', (d) => { childLog += d.toString(); });
  child.stderr.on('data', (d) => { childLog += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const call = async (method, routePath, body) => {
    const res = await fetch(base + routePath, {
      method,
      headers: { 'x-console-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const type = res.headers.get('content-type') || '';
    if (type.startsWith('image/')) {
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, type, buf };
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const waitUp = async () => {
    for (let i = 0; i < 60; i += 1) {
      try {
        const r = await call('GET', '/api/ai-images');
        if (r.status === 200) return true;
      } catch { /* 还没起来 */ }
      await sleep(250);
    }
    return false;
  };

  try {
    const up = await waitUp();
    ok(up, '桥接起来了（/api/ai-images 200）');
    if (up) {
      const inv = await call('GET', '/api/ai-images');
      eq(inv.json.sources.length, 2, 'e2e：读到配置里的两个受管来源');
      eq(inv.json.totals.count, 3, 'e2e：清单数出三张图');

      const items = await call('GET', '/api/ai-images/items?source=library&q=e2e');
      eq(items.status, 200, 'e2e：items 接口 200');
      eq(items.json.total, 1, 'e2e：搜索命中标题');
      eq(items.json.items[0].name, 'a.jpg', 'e2e：命中的是 a.jpg');

      const img = await call('GET', `/api/ai-images/file?source=library&name=${encodeURIComponent('a.jpg')}`);
      eq(img.status, 200, 'e2e：预览接口回 200');
      eq(img.type, 'image/jpeg', 'e2e：按后缀给 image/jpeg');
      eq(img.buf.length, 120, 'e2e：回的是真实字节');

      const trav = await call('GET', '/api/ai-images/file?source=library&name=..%2Fconfig.json');
      ok(trav.status !== 200, 'e2e：预览接口拒绝路径穿越');

      const del = await call('POST', '/api/ai-images/remove', { source: 'library', names: ['a.jpg'] });
      eq(del.json.ok, true, 'e2e：删除成功');
      eq(fs.existsSync(path.join(libDir, 'a.jpg')), false, 'e2e：文件进了回收站（原目录没有了）');
      const idx = JSON.parse(fs.readFileSync(path.join(libDir, 'index.json'), 'utf8'));
      eq(idx.items.some((it) => it.file === 'a.jpg'), false, 'e2e：索引条目同步摘掉');

      const trash = await call('GET', '/api/ai-images/trash');
      eq(trash.json.batches.length, 1, 'e2e：回收站里有一个批次');
      const stamp = trash.json.batches[0].stamp;

      const back = await call('POST', '/api/ai-images/restore', { stamp });
      eq(back.json.ok, true, 'e2e：还原成功');
      eq(fs.existsSync(path.join(libDir, 'a.jpg')), true, 'e2e：文件回到图库');
      const idx2 = JSON.parse(fs.readFileSync(path.join(libDir, 'index.json'), 'utf8'));
      eq(idx2.items.some((it) => it.file === 'a.jpg'), true, 'e2e：索引条目也回来了');

      const noRule = await call('POST', '/api/ai-images/forget', { source: '', olderThanDays: 0, maxTotalMB: 0 });
      eq(noRule.json.ok, false, 'e2e：自然清理两条规则都不填时被拒绝');

      const cleared = await call('POST', '/api/ai-images/clear', { source: 'pixivPicks' });
      eq(cleared.json.removed.length, 1, 'e2e：按来源清空');
      const purged = await call('POST', '/api/ai-images/purge', { stamp: 'all' });
      eq(purged.json.purged.batches, 1, 'e2e：彻底清空回收站（还原完的那批早已消失，只剩清空样图那批）');
      eq(fs.existsSync(path.join(stateDir, 'image-trash')), true, 'e2e：回收站目录还在（只是没有批次）');

      // 补抓历史发过的图：隔离实例里没有历史 URL，应该是「启动即完成、0 候选」
      const bfStart = await call('POST', '/api/ai-images/backfill', {});
      eq(bfStart.status, 200, 'e2e：补抓接口可用');
      eq(bfStart.json.ok, true, 'e2e：补抓启动成功');
      eq(bfStart.json.backfill.total, 0, 'e2e：没有历史 URL 时候选为 0');
      const bfState = await call('GET', '/api/ai-images/backfill');
      eq(bfState.json.ok, true, 'e2e：能查补抓进度');
      eq(bfState.json.backfill.running, false, 'e2e：补抓已结束（没有候选，不用等）');

      // AI 的 agent token 不许碰管理接口：带着合法 console token 也照样 403
      const denied = await fetch(base + '/api/ai-images', {
        headers: { 'x-console-token': token, 'x-agent-token': 'whatever' }
      });
      eq(denied.status, 403, 'e2e：带 agent token 一律 403（图片管理不给 AI 用）');
    }
  } finally {
    child.kill('SIGTERM');
    await sleep(400);
    try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
    if (fail && childLog) console.log('--- 桥接日志尾部 ---\n' + childLog.split('\n').slice(-25).join('\n'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n${pass} 项通过${fail ? `，${fail} 项失败 ❌` : '，全部通过 ✅'}`);
if (fail) process.exit(1);
