#!/usr/bin/env node
// fetch-style-stickers.mjs — 按「表情包风格关键词」批量补库（二次元 / DeepSeek 二创 / 小鲸鱼 / 梗图）
//
// 与 fetch-bili-images.mjs 的区别：
//   fetch-bili-images.mjs   按 bvid / mid / cv 精确抓某个来源（追更用）
//   fetch-style-stickers.mjs 按关键词逛 B 站，自动筛掉头像级小图 / 长截图 / 大图，只留能当表情包的
//
// 数据来源：src/bili.js 的 searchImages（评论区图片优先 + 专栏配图补足）
// 下载：一律走 src/safe-fetch.js 的 safeFetchBuffer（DNS 固定 + 禁内网 + 体积校验 + 图片头校验）
//       必须带 Referer: https://www.bilibili.com，否则 B 站图床 403
//
// 用法：
//   node scripts/fetch-style-stickers.mjs                          # 默认关键词，入库 60 张上限
//   node scripts/fetch-style-stickers.mjs --limit 40
//   node scripts/fetch-style-stickers.mjs --keywords "小鲸鱼表情包,deepseek娘" --per-keyword 8
//   node scripts/fetch-style-stickers.mjs --animated-only          # 只留真动图（GIF 多帧 / 动画 WebP）
//   node scripts/fetch-style-stickers.mjs --dry-run                # 只看候选，不下载不入库
//   node scripts/fetch-style-stickers.mjs --no-cookie              # 不用 state/bili-cookie.txt
//
// 幂等：sha256 去重（对比 index.json + 磁盘同名文件），重复跑不会重复入库，
//       写索引前会重新读盘并按 file/sha256 合并，不会覆盖别的进程刚写的条目。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createBiliClient, readBiliCookie } from '../src/bili.js';
import { safeFetchBuffer, looksLikeImageBuffer } from '../src/safe-fetch.js';
import { describeAnimation } from '../src/image-meta.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REFERER = 'https://www.bilibili.com';

// 图片尺寸解析（只读文件头，和 fetch-bili-images.mjs 的 imageSize 同源写法）
// 注意：src/image-meta.js 只提供**帧数/动图**判断（gifFrameCount / isAnimatedWebp / describeAnimation），
// 没有宽高导出，所以这里保留一份头部解析。
function imageSize(buf) {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ext: 'png' };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), ext: 'jpg' };
        }
        i += 2 + len;
      }
      return { w: 0, h: 0, ext: 'jpg' };
    }
    const head6 = buf.toString('ascii', 0, 6);
    if (head6 === 'GIF87a' || head6 === 'GIF89a') {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), ext: 'gif' };
    }
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = buf.toString('ascii', 12, 16);
      if (fmt === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3), ext: 'webp' };
      if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, ext: 'webp' };
      if (fmt === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, ext: 'webp' };
      }
    }
    return { w: 0, h: 0, ext: '' };
  } catch { return { w: 0, h: 0, ext: '' }; }
}

// ── 参数解析 ───────────────────────────────────────────────────────────────
const DEFAULT_KEYWORDS = [
  '二次元表情包',
  '动漫表情包',
  '小鲸鱼表情包',
  'deepseek娘',
  'deepseek 表情包',
  '猫猫表情包',
  '沙雕表情包'
].join(',');

const argv = process.argv.slice(2);
const opts = {
  keywords: DEFAULT_KEYWORDS.split(',').map((s) => s.trim()).filter(Boolean),
  perKeyword: 6,
  limit: 60,
  maxBytes: 2 * 1024 * 1024,
  minSide: 120,
  maxRatio: 2.2,
  sources: ['comment', 'article'],
  videoTop: 5,
  commentPages: 2,
  animatedOnly: false,
  dryRun: false,
  outDir: 'assets/stickers',
  delayMs: 800,
  cookie: '',
  noCookie: false,
  cookieFile: 'state/bili-cookie.txt'
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--keywords') opts.keywords = String(next()).split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--keyword') opts.keywords.push(String(next()).trim());
  else if (a === '--per-keyword') opts.perKeyword = Number(next());
  else if (a === '--limit') opts.limit = Number(next());
  else if (a === '--max-bytes') opts.maxBytes = Number(next());
  else if (a === '--min-side') opts.minSide = Number(next());
  else if (a === '--max-ratio') opts.maxRatio = Number(next());
  else if (a === '--sources') opts.sources = String(next()).split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--video-top') opts.videoTop = Number(next());
  else if (a === '--comment-pages') opts.commentPages = Number(next());
  else if (a === '--animated-only') opts.animatedOnly = true;
  else if (a === '--out') opts.outDir = next();
  else if (a === '--delay') opts.delayMs = Number(next());
  else if (a === '--cookie') opts.cookie = next();
  else if (a === '--cookie-file') opts.cookieFile = next();
  else if (a === '--no-cookie') opts.noCookie = true;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '-h' || a === '--help') {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  } else { console.error(`未知参数：${a}`); process.exit(2); }
}
if (!opts.keywords.length) { console.error('至少要有一个 --keywords'); process.exit(2); }
if (!(opts.limit > 0)) { console.error('--limit 必须为正数'); process.exit(2); }

const OUT_ABS = path.resolve(ROOT, opts.outDir);
const INDEX_FILE = path.join(OUT_ABS, 'index.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => Math.round(opts.delayMs * (0.75 + Math.random() * 0.6));
const short = (s, n = 60) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

// cookie：默认走 state/bili-cookie.txt（readBiliCookie），带 SESSDATA 能显著降低 412/-352
if (!opts.noCookie && !opts.cookie) {
  opts.cookie = readBiliCookie(ROOT);
  if (!opts.cookie && opts.cookieFile) {
    try {
      const raw = fs.readFileSync(path.resolve(ROOT, opts.cookieFile), 'utf8').trim();
      if (raw) opts.cookie = raw.includes('=') ? raw : `SESSDATA=${raw}`;
    } catch { /* 没有 cookie 也能跑，只是更容易被风控 */ }
  }
}

// ── 索引（读 → 合并 → 原子写） ─────────────────────────────────────────────
function readIndex() {
  let index = { version: 1, updatedAt: '', items: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) index = parsed;
  } catch { /* 首次运行 / 文件损坏时重建 */ }
  if (!Array.isArray(index.items)) index.items = [];
  return index;
}

/** 重新读盘 + 按 file/sha256 去重，绝不整表覆盖别人刚写的条目 */
function mergeAndWriteIndex(newItems) {
  const index = readIndex();
  const seenFiles = new Set(), seenHashes = new Set();
  const merged = [];
  for (const item of [...index.items, ...newItems]) {
    if (!item || typeof item !== 'object') continue;
    const file = String(item.file || ''), sha = String(item.sha256 || '');
    if (file && seenFiles.has(file)) continue;
    if (sha && seenHashes.has(sha)) continue;
    if (file) seenFiles.add(file);
    if (sha) seenHashes.add(sha);
    merged.push(item);
  }
  index.items = merged;
  index.version = index.version ?? 1;
  index.updatedAt = new Date().toISOString();
  index.outDir = opts.outDir;
  fs.mkdirSync(OUT_ABS, { recursive: true });
  const tmp = `${INDEX_FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
  fs.renameSync(tmp, INDEX_FILE); // 原子替换
  return index.items.length;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(OUT_ABS, { recursive: true });
  const index = readIndex();
  const knownHashes = new Set(index.items.map((x) => x.sha256).filter(Boolean));
  const knownFiles = new Set(index.items.map((x) => x.file).filter(Boolean));
  const itemsBefore = index.items.length;
  // 磁盘上已有同名文件也算已知，避免索引被外部清空后重复写入
  for (const f of fs.readdirSync(OUT_ABS)) knownFiles.add(f);
  // 本次跑批新增（下载后才知道内容 hash）与已知 URL：两者一起保证幂等
  const knownUrls = new Set();

  console.log(`关键词：${opts.keywords.join(' / ')}`);
  console.log(`筛选：≤${(opts.maxBytes / 1024 / 1024).toFixed(1)}MB，最短边 ≥${opts.minSide}，长宽比 ≤${opts.maxRatio}${opts.animatedOnly ? '，仅真动图' : ''}`);
  console.log(`cookie：${opts.cookie ? `有（${opts.cookie.length} 字符）` : '无（风控风险高）'}；索引现有 ${itemsBefore} 条\n`);

  const client = createBiliClient({ cookie: opts.cookie });

  // ① 逐关键词搜图，汇总候选
  const candidates = [];
  const seenUrls = new Set();
  const perKeyword = new Map();
  for (const kw of opts.keywords) {
    const quota = Math.max(1, opts.perKeyword);
    try {
      const list = await client.searchImages(kw, {
        count: quota,
        sources: opts.sources,
        videoTop: opts.videoTop,
        commentPages: opts.commentPages,
        animatedOnly: false // 动图判断放到下载阶段，避免搜索阶段先下一遍
      });
      let added = 0;
      for (const it of list) {
        const url = String(it?.url || '');
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        candidates.push({
          url,
          keyword: kw,
          origin: kw,
          source: it.source || 'comment',
          title: short(it.title || '', 60)
        });
        added++;
      }
      perKeyword.set(kw, added);
      console.log(`[搜] 「${kw}」→ 候选 ${added} 张`);
    } catch (error) {
      perKeyword.set(kw, 0);
      console.warn(`[搜] 「${kw}」失败：${error?.message ?? error}`);
    }
    await sleep(jitter());
  }

  console.log(`\n候选合计 ${candidates.length} 张，按关键词顺序处理，总上限 --limit ${opts.limit}`);
  if (opts.dryRun) {
    for (const c of candidates) console.log(`  [dry] ${c.source} ${c.keyword} ${c.url}`);
    console.log('\n--dry-run：未下载、未入库。');
    return;
  }

  // ② 逐张下载 + 校验入库
  const skip = { duplicate: 0, tooLarge: 0, tooSmall: 0, ratio: 0, notImage: 0, notAnimated: 0, downloadFailed: 0, badSize: 0 };
  const newItems = [];
  let downloaded = 0, saved = 0, processed = 0;
  const perKeywordSaved = new Map();

  for (const c of candidates) {
    if (saved >= opts.limit) break;
    processed++;
    let buf;
    try {
      const res = await safeFetchBuffer(c.url, opts.maxBytes, { headers: { referer: REFERER } });
      buf = res.buffer;
      downloaded++;
    } catch (error) {
      const msg = String(error?.message ?? error);
      if (/大小限制/.test(msg)) { skip.tooLarge++; console.log(`  · 跳过（太大）：${short(c.url)}`); }
      else { skip.downloadFailed++; console.warn(`  ❌ 下载失败 ${short(c.url)}：${msg}`); }
      await sleep(jitter());
      continue;
    }

    if (!looksLikeImageBuffer(buf)) { skip.notImage++; console.warn(`  · 跳过（非图片）：${short(c.url)}`); await sleep(jitter()); continue; }

    const sha256 = createHash('sha256').update(buf).digest('hex');
    // 去重分两层：候选 URL（省下重复下载）与内容 sha256 / 目标文件名
    if (knownUrls.has(c.url)) { skip.duplicate++; await sleep(jitter()); continue; }
    knownUrls.add(c.url);
    // 纯 sha256 重复：静默跳过（重复跑时会是绝大多数，不刷屏）
    if (knownHashes.has(sha256)) { skip.duplicate++; await sleep(jitter()); continue; }

    const { w, h, ext } = imageSize(buf);
    if (!ext || !w || !h) { skip.badSize++; console.warn(`  · 跳过（尺寸解析失败）：${short(c.url)}`); await sleep(jitter()); continue; }
    if (buf.length > opts.maxBytes) { skip.tooLarge++; await sleep(jitter()); continue; }
    if (opts.minSide > 0 && Math.min(w, h) < opts.minSide) { skip.tooSmall++; console.log(`  · 跳过（太小 ${w}x${h}）：${short(c.url)}`); await sleep(jitter()); continue; }
    const ratio = Math.max(w, h) / Math.min(w, h);
    if (opts.maxRatio > 0 && ratio > opts.maxRatio) { skip.ratio++; console.log(`  · 跳过（长截图 ${w}x${h}，比例 ${ratio.toFixed(2)}）：${short(c.url)}`); await sleep(jitter()); continue; }

    let anim = { animated: false, frames: null, kind: null };
    if (opts.animatedOnly) {
      anim = describeAnimation(buf);
      if (!anim.animated) { skip.notAnimated++; await sleep(jitter()); continue; }
    }

    const file = `style-${c.source}-${sha256.slice(0, 10)}.${ext}`;
    // 只按文件名判重时要报出来：说明索引/磁盘被人为改动过（不是正常的重复跑）
    if (knownFiles.has(file)) { skip.duplicate++; console.log(`  · 跳过（文件名已存在 ${file}）`); await sleep(jitter()); continue; }
    try {
      fs.writeFileSync(path.join(OUT_ABS, file), buf);
    } catch (error) {
      skip.downloadFailed++;
      console.warn(`  ❌ 写文件失败 ${file}：${error?.message ?? error}`);
      await sleep(jitter());
      continue;
    }
    knownHashes.add(sha256);
    knownFiles.add(file);
    newItems.push({
      file, sha256, bytes: buf.length, width: w, height: h,
      source: 'style', origin: c.origin, title: c.title || '', url: c.url,
      ...(opts.animatedOnly ? { animated: true, frames: anim.frames ?? null } : {}),
      fetchedAt: new Date().toISOString()
    });
    perKeywordSaved.set(c.keyword, (perKeywordSaved.get(c.keyword) || 0) + 1);
    saved++;
    console.log(`  ✅ ${file}  ${w}x${h}  ${(buf.length / 1024).toFixed(0)}KB  ← 「${c.keyword}」${anim.animated ? ` 动图${anim.frames ? ` ${anim.frames}帧` : ''}` : ''}`);
    await sleep(jitter());
  }

  // ③ 合并写回索引
  let total = itemsBefore;
  if (newItems.length) {
    try { total = mergeAndWriteIndex(newItems); }
    catch (error) { console.error(`写索引失败：${error?.message ?? error}`); process.exitCode = 1; }
  }

  // ④ 汇总
  const skipParts = Object.entries(skip).filter(([, v]) => v > 0).map(([k, v]) => `${({ duplicate: '重复', tooLarge: '太大', tooSmall: '太小', ratio: '长截图', notImage: '非图片', notAnimated: '非动图', downloadFailed: '下载失败', badSize: '尺寸异常' })[k]}=${v}`).join('，') || '无';
  console.log('\n──────── 汇总 ────────');
  console.log(`候选 ${candidates.length} 张，实际处理 ${processed} 张${saved >= opts.limit ? '（已达 --limit 提前停止）' : ''}`);
  console.log(`下载成功 ${downloaded}，新增入库 ${newItems.length}，跳过：${skipParts}`);
  if (perKeyword.size) console.log(`各关键词候选/入库：${[...perKeyword].map(([k, v]) => `${k} ${v}/${perKeywordSaved.get(k) || 0}`).join('，')}`);
  console.log(`index.json：items ${itemsBefore} → ${total}（${path.relative(ROOT, INDEX_FILE)}）`);
  console.log('提示：QQ 侧可用 qq_send_image / qq_save_sticker 的 source=library 指定这些文件名。');
}

main().catch((error) => { console.error('补库失败：', error); process.exit(1); });
