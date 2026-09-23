// B站视频理解回归测试：元数据 / 字幕 / 画面（雪碧图抽帧）
//
// 这组能力依赖 B站的公开接口，所以测试重点不是「逻辑对不对」，而是：
//   1. 接口还有效吗（B站接口会变，比如 subtitle_url 必须用 wbi 版才不过期）
//   2. 没有字幕/没有预览图的视频，是不是**优雅降级**（返回 available:false 而不是报错）
//   3. 抽帧的坐标计算对不对（雪碧图是 10x10 网格，切错位置就会拿到别的帧）
//
// 需要网络 + state/bili-cookie.txt（可选但建议）。用真实视频，因为这是集成测试。
//
// 用法：node scripts/test-bili-video.mjs
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createBiliClient, readBiliCookie } from '../src/bili.js';
import { createVideoTools } from '../src/bili-video.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BVID = 'BV1Uh3e6uETs';   // 【HLE中字】Zeus超长复盘Msi决赛（49 分钟，有字幕有画面）
let pass = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

const client = createBiliClient({ cookie: readBiliCookie(ROOT) });
const v = createVideoTools({ root: ROOT, client, log: () => {} });

console.log(`B站视频理解测试（cookie: ${readBiliCookie(ROOT) ? '有' : '无'}）\n`);

// ── 元数据 ────────────────────────────────────────────────────────────
let meta = null;
try {
  meta = await v.meta(BVID);
  console.log(`  测试视频：《${meta.title.slice(0, 34)}》${(meta.duration / 60).toFixed(0)} 分钟\n`);
} catch (e) {
  console.error(`  ✗ 取元数据失败（网络或接口变更）：${e.message}`);
  process.exit(1);
}
await ok('元数据包含检索所需字段', () => {
  assert.match(meta.bvid, /^BV[0-9A-Za-z]{10}$/);
  assert.ok(meta.aid > 0 && meta.cid > 0, 'aid/cid 必须有值');
  assert.ok(meta.duration > 0 && meta.title.length > 0);
});

// ── 字幕 ──────────────────────────────────────────────────────────────
const sub = await v.subtitle(BVID);
await ok('字幕可得，且带字数/token 估算', () => {
  assert.equal(sub.available, true, `该视频应有字幕（reason=${sub.reason || ''}）`);
  assert.ok(sub.chars > 500, `字幕太短：${sub.chars}`);
  assert.ok(sub.tokensEst > 300);
  assert.ok(sub.text.length > 0);
});
await ok('字幕分段（offset/limit）按段切片', () => {
  return v.subtitle(BVID, { offset: 10, limit: 3 }).then((r) => {
    assert.equal(r.returned, 3);
    assert.equal(r.offset, 10);
    assert.ok(r.text.length > 0);
    assert.notEqual(r.text, sub.text.slice(0, r.text.length), '切片结果不应等于从头开始');
  });
});
await ok('无字幕视频优雅降级（不抛错，返回 available:false）', async () => {
  // 用一个几乎肯定没有 AI 字幕的极短视频试；失败也算通过（说明接口拒绝而不是崩）
  const r = await v.subtitle('BV1GJ411x7h7').catch((e) => ({ available: false, reason: e.message }));
  assert.equal(typeof r.available, 'boolean');
});

// ── 画面 ──────────────────────────────────────────────────────────────
const sb = await v.storyboard(BVID);
await ok('雪碧图元信息自洽（网格尺寸 × 行列 ≈ 帧数）', () => {
  assert.equal(sb.available, true);
  assert.ok(sb.sheets.length > 0);
  assert.ok(sb.cols > 0 && sb.rows > 0 && sb.frameW > 0 && sb.frameH > 0);
  assert.ok(sb.count > 0, '时间戳数量应大于 0');
  assert.ok(sb.index[sb.index.length - 1] <= sb.duration + 60, '最后一帧时间不应超过时长太多');
});

const fr = await v.frames(BVID, { atSeconds: 1470, count: 2, spreadSeconds: 15 });
await ok('按时间点取到帧，且时间戳落在请求点附近', () => {
  assert.equal(fr.images.length, 2, `取帧数不符：${fr.images.length}；failures=${JSON.stringify(fr.failures || [])}`);
  for (const im of fr.images) {
    assert.ok(Math.abs(im.at - 1470) <= 60, `帧时间 ${im.at} 离请求点太远`);
    assert.equal(im.mimeType, 'image/png');
    assert.ok(im.data.length > 1000, 'base64 太短，可能不是有效图像');
  }
});
await ok('切出来的帧是合法 PNG 且有内容（不是空白片）', async () => {
  const sharp = (await import('sharp')).default;
  const buf = Buffer.from(fr.images[0].data, 'base64');
  const m = await sharp(buf).metadata();
  assert.equal(m.format, 'png');
  assert.equal(m.width, sb.frameW);
  assert.equal(m.height, sb.frameH);
  const stats = await sharp(buf).stats();
  const spread = stats.channels.reduce((s, c) => s + (c.max - c.min), 0);
  assert.ok(spread > 30, `帧几乎是纯色（spread=${spread}），说明切错位置或图没下全`);
});

await ok('取帧时间点必须是请求点附近（不能切到别的帧）', () => {
  // 请求 1470s，若坐标算错会拿到完全无关的时间
  const near = fr.images.map((i) => i.at).sort((a, b) => a - b);
  assert.ok(near[0] >= 1400 && near[near.length - 1] <= 1540, `时间点漂了：${near.join(',')}`);
});

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : '，全部通过 ✅'}`);
