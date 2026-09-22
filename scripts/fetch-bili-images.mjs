#!/usr/bin/env node
// fetch-bili-images.mjs — 从 B 站抓图存入本地图库（供 qq_save_sticker / qq_send_image 的 source=library 使用）
//
// 实测结论（2026-09，无登录）：
//   评论区  ✅ x/v2/reply/wbi/main（需 wbi 签名）→ data.replies[].content.pictures[].img_src
//   动态    ✅ x/polymer/web-dynamic/v1/opus/feed/space（wbi）→ items[].cover.url（详情接口 -352，需登录）
//   专栏    ✅ x/article/viewinfo?id=cv → data.image_urls
//   视频封面 ✅ x/web-interface/view?bvid= → data.pic
//   web-dynamic/v1/feed/space 无登录固定 412；opus/detail 固定 -352 → 这两条需要 --cookie（SESSDATA）
//
// 用法：
//   node scripts/fetch-bili-images.mjs --bvid BV1GJ411x7h7 --comments
//   node scripts/fetch-bili-images.mjs --mid 946974 --dynamic --dynamic-pages 2
//   node scripts/fetch-bili-images.mjs --cv 2 --cv 123456
//   node scripts/fetch-bili-images.mjs --bvid BV1xx --comments --mid 946974 --dynamic --cover
//   node scripts/fetch-bili-images.mjs ... --dry-run          # 只列出会抓哪些图，不下载
//   BILI_COOKIE='SESSDATA=xxx; bili_jct=yyy' node scripts/fetch-bili-images.mjs --mid 946974 --dynamic --detail
//
// 说明：--detail 尝试用 opus/detail 拿一条动态的全部图片（需要 cookie，否则 -352 会跳过）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

// ── 参数解析 ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opts = {
  sources: { comments: false, dynamic: false, articles: [], cover: false },
  bvids: [], mids: [], cvs: [], keywords: [],
  keywordTop: 6, keywordComments: 2,
  outDir: 'assets/stickers',
  maxBytes: 2 * 1024 * 1024,
  minSide: 150,
  limit: 60,
  dynamicPages: 1,
  commentPages: 1,
  delayMs: 900,
  dryRun: false,
  detail: false,
  cookie: process.env.BILI_COOKIE || '',
  cookieFile: 'state/bili-cookie.txt',
  gotCookieFlag: false
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === '--comments') opts.sources.comments = true;
  else if (a === '--dynamic') opts.sources.dynamic = true;
  else if (a === '--cover') opts.sources.cover = true;
  else if (a === '--detail') opts.detail = true;
  else if (a === '--bvid') opts.bvids.push(next());
  else if (a === '--mid') opts.mids.push(String(next()));
  else if (a === '--cv') opts.cvs.push(String(next()).replace(/^cv/i, ''));
  else if (a === '--keyword') opts.keywords.push(String(next()));
  else if (a === '--keyword-top') opts.keywordTop = Number(next());
  else if (a === '--keyword-comments') opts.keywordComments = Number(next());
  else if (a === '--out') opts.outDir = next();
  else if (a === '--max-bytes') opts.maxBytes = Number(next());
  else if (a === '--min-side') opts.minSide = Number(next());
  else if (a === '--limit') opts.limit = Number(next());
  else if (a === '--dynamic-pages') opts.dynamicPages = Number(next());
  else if (a === '--comment-pages') opts.commentPages = Number(next());
  else if (a === '--delay') opts.delayMs = Number(next());
  else if (a === '--cookie') { opts.cookie = next(); opts.gotCookieFlag = true; }
  else if (a === '--cookie-file') opts.cookieFile = next();
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).join('\n')); process.exit(0); }
  else { console.error(`未知参数：${a}`); process.exit(2); }
}
if (!opts.sources.comments && !opts.sources.dynamic && !opts.cvs.length && !opts.bvids.length && !opts.keywords.length) {
  console.error('至少要指定一个来源：--bvid / --mid --dynamic / --cv / --keyword，或 --comments / --cover');
  process.exit(2);
}
if (opts.sources.comments && !opts.bvids.length) { console.error('--comments 需要 --bvid'); process.exit(2); }
if (opts.sources.dynamic && !opts.mids.length) { console.error('--dynamic 需要 --mid'); process.exit(2); }
if (opts.sources.cover && !opts.bvids.length) { console.error('--cover 需要 --bvid'); process.exit(2); }

const OUT_ABS = path.resolve(ROOT, opts.outDir);
const INDEX_FILE = path.join(OUT_ABS, 'index.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => createHash('md5').update(s).digest('hex');
let cookie = opts.cookie;

// cookie 文件（默认 state/bili-cookie.txt，已被 .gitignore 忽略）：
// 内容可以是完整 cookie 串（SESSDATA=xxx; bili_jct=yyy），也可以只写 SESSDATA 的值。
if (!cookie && opts.cookieFile) {
  try {
    const raw = fs.readFileSync(path.resolve(ROOT, opts.cookieFile), 'utf8').trim();
    if (raw) cookie = raw.includes('=') ? raw : `SESSDATA=${raw}`;
  } catch { /* 没有 cookie 文件也能跑（评论区/专栏/动态封面/视频封面） */ }
}

// ── HTTP + wbi 签名 ───────────────────────────────────────────────────────
async function api(url, params = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  const res = await fetch(u, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com', ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 风控页/HTML */ }
  return { status: res.status, json, text };
}

async function ensureCookie() {
  if (cookie) return;
  try {
    const r = await api('https://api.bilibili.com/x/frontend/finger/spi');
    const b3 = r.json?.data?.b_3, b4 = r.json?.data?.b_4;
    if (b3) cookie = `buvid3=${b3}; buvid4=${b4 || ''}`;
  } catch { /* 无 cookie 也能跑大部分接口 */ }
}

let wbi = null;
async function wbiQuery(params) {
  if (!wbi || Date.now() - wbi.at > 3600_000) {
    const r = await api('https://api.bilibili.com/x/web-interface/nav');
    const keyOf = (u) => (String(u).split('/').pop() || '').split('.')[0];
    const raw = keyOf(r.json?.data?.wbi_img?.img_url) + keyOf(r.json?.data?.wbi_img?.sub_url);
    if (raw.length < 64) throw new Error('wbi key 获取失败（nav 异常）');
    wbi = { mixin: MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32), at: Date.now() };
  }
  const q = { ...params, wts: Math.floor(Date.now() / 1000) };
  const query = Object.keys(q).filter((k) => q[k] !== undefined && q[k] !== null && q[k] !== '')
    .sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(q[k]).replace(/[!'()*]/g, ''))}`).join('&');
  return { ...q, w_rid: md5(query + wbi.mixin) };
}

// ── 图片尺寸（只读文件头，不依赖第三方库） ─────────────────────────────────
export function imageSize(buf) {
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

// ── 索引 ─────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_ABS, { recursive: true });
let index = { version: 1, updatedAt: '', items: [] };
try { index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { /* 首次运行 */ }
if (!Array.isArray(index.items)) index.items = [];
const knownHashes = new Set(index.items.map((x) => x.sha256).filter(Boolean));
const knownFiles = new Set(index.items.map((x) => x.file).filter(Boolean));

const candidates = [];
const addCandidate = (url, meta) => {
  if (!url) return;
  const clean = String(url).replace(/^\/\//, 'https://').replace(/^http:\/\//, 'https://');
  if (!/^https:\/\/i\d\.hdslb\.com\//.test(clean)) return;
  if (candidates.some((c) => c.url === clean)) return;
  candidates.push({ url: clean, ...meta });
};

// ── 采集 ─────────────────────────────────────────────────────────────────
async function collectCover(bvid) {
  const r = await api('https://api.bilibili.com/x/web-interface/view', { bvid });
  if (r.json?.code !== 0) { console.warn(`[cover] ${bvid} 取视频信息失败 code=${r.json?.code}`); return; }
  const d = r.json.data;
  addCandidate(d.pic, { source: 'cover', origin: `BV ${d.bvid}`, title: d.title });
  console.log(`[cover] ${bvid} → ${d.title}`);
}

async function collectComments(bvid) {
  const v = await api('https://api.bilibili.com/x/web-interface/view', { bvid });
  if (v.json?.code !== 0) { console.warn(`[comment] ${bvid} 取 aid 失败`); return; }
  const aid = v.json.data.aid, title = v.json.data.title;
  let next = 0, page = 0, got = 0;
  while (page < opts.commentPages) {
    const r = await api('https://api.bilibili.com/x/v2/reply/wbi/main',
      await wbiQuery({ oid: aid, type: 1, mode: 3, next, ps: 20, plat: 1, web_location: 1315875 }));
    if (r.status === 412 || r.json?.code === -352) { console.warn(`[comment] ${bvid} 触发风控（412/-352），已停止该来源`); break; }
    if (r.json?.code !== 0) { console.warn(`[comment] ${bvid} code=${r.json?.code} ${r.json?.message || ''}`); break; }
    const data = r.json.data || {};
    const all = [...(data.replies || []), ...((data.top_replies) || [])];
    for (const reply of all) {
      for (const pic of (reply.content?.pictures || [])) {
        addCandidate(pic.img_src, { source: 'comment', origin: `BV ${bvid}`, title });
        got++;
      }
    }
    next = data.cursor?.next ?? 0;
    page++;
    if (!next || !(data.replies || []).length) break;
    await sleep(opts.delayMs);
  }
  console.log(`[comment] ${bvid} 翻 ${page} 页，命中带图评论 ${got} 张`);
}

async function collectDynamic(mid) {
  let offset = '', page = 0, got = 0;
  while (page < opts.dynamicPages) {
    const r = await api('https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/feed/space',
      await wbiQuery({ host_mid: mid, page: page + 1, offset, type: 'all', web_location: 333.1387 }));
    if (r.status === 412 || r.json?.code === -352) { console.warn(`[dynamic] mid=${mid} 风控（412/-352）`); break; }
    if (r.json?.code !== 0) { console.warn(`[dynamic] mid=${mid} code=${r.json?.code} ${r.json?.message || ''}`); break; }
    const items = r.json.data?.items || [];
    for (const it of items) {
      const oid = it.opus_id;
      const cover = it.cover?.url;
      if (cover) { addCandidate(cover, { source: 'dynamic', origin: `mid ${mid}`, title: String(it.content || '').slice(0, 40) }); got++; }
      // 详情接口要登录（-352），仅在 --detail 且带 cookie 时尝试
      if (opts.detail && opts.cookie && oid) {
        const d = await api('https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail',
          await wbiQuery({ id: oid, timezone_offset: -480, web_location: 333.1387 }));
        if (d.json?.code === 0) {
          const seen = new Set();
          (function walk(o) {
            if (o == null) return;
            if (typeof o === 'string') return;
            if (Array.isArray(o)) return o.forEach(walk);
            if (typeof o === 'object') {
              if (typeof o.url === 'string' && /hdslb\.com/.test(o.url) && !seen.has(o.url)) { seen.add(o.url); addCandidate(o.url, { source: 'dynamic', origin: `mid ${mid}`, title: `opus ${oid}` }); }
              if (typeof o.src === 'string' && /hdslb\.com/.test(o.src) && !seen.has(o.src)) { seen.add(o.src); addCandidate(o.src, { source: 'dynamic', origin: `mid ${mid}`, title: `opus ${oid}` }); }
              Object.values(o).forEach(walk);
            }
          })(d.json.data);
        }
        await sleep(opts.delayMs);
      }
    }
    console.log(`[dynamic] mid=${mid} 第 ${page + 1} 页：${items.length} 条，累计候选 ${got} 张`);
    offset = r.json.data?.offset || '';
    page++;
    if (!items.length) break;
    await sleep(opts.delayMs);
  }
}

async function collectKeyword(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return;
  const vres = await api('https://api.bilibili.com/x/web-interface/wbi/search/type',
    await wbiQuery({ search_type: 'video', keyword: kw, page: 1, page_size: 20 }));
  if (vres.status === 412 || vres.json?.code === -352) { console.warn(`[keyword] 「${kw}」风控（412/-352）`); return; }
  if (vres.json?.code !== 0) { console.warn(`[keyword] 「${kw}」搜索失败 code=${vres.json?.code}`); return; }
  const vids = (vres.json.data?.result || []).filter((v) => v.bvid).slice(0, Math.max(1, opts.keywordComments));
  let n = 0;
  // ① 评论区图片优先（不抓视频封面）
  for (const v of vids) {
    await sleep(opts.delayMs);
    const before = candidates.length;
    try { await collectComments(v.bvid); } catch (e) { console.warn(`[keyword] 「${kw}」评论抓取失败：${e?.message ?? e}`); }
    n += candidates.length - before;
  }
  // ② 不够再补专栏配图
  const ares = await api('https://api.bilibili.com/x/web-interface/wbi/search/type',
    await wbiQuery({ search_type: 'article', keyword: kw, page: 1, page_size: 20 }));
  if (ares.json?.code === 0) {
    for (const a of (ares.json.data?.result || []).slice(0, 6)) {
      const title = String(a.title || '').replace(/<[^>]+>/g, '');
      for (const u of (Array.isArray(a.image_urls) ? a.image_urls : [])) {
        addCandidate(u, { source: 'article', origin: `搜索「${kw}」`, title });
        n++;
      }
    }
  }
  console.log(`[keyword] 「${kw}」→ 候选 ${n} 张（评论视频 ${vids.length} 个 + 专栏配图）`);
}

async function collectArticle(cv) {
  const r = await api('https://api.bilibili.com/x/article/viewinfo', { id: cv });
  if (r.json?.code !== 0) { console.warn(`[article] cv${cv} code=${r.json?.code} ${r.json?.message || ''}`); return; }
  const d = r.json.data || {};
  const pics = [...(d.image_urls || [])];
  for (const u of pics) addCandidate(u, { source: 'article', origin: `cv${cv}`, title: String(d.title || '').slice(0, 40) });
  console.log(`[article] cv${cv} → 《${String(d.title || '').slice(0, 30)}》 image_urls=${pics.length}`);
}

// ── 下载 ─────────────────────────────────────────────────────────────────
async function download(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://www.bilibili.com', ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > opts.maxBytes) throw new Error(`超过体积上限（${len} > ${opts.maxBytes}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > opts.maxBytes) throw new Error(`超过体积上限（${buf.length} > ${opts.maxBytes}）`);
  return buf;
}

async function main() {
  await ensureCookie();
  console.log(`来源：${[opts.keywords.length && '关键词', opts.sources.comments && '评论', opts.sources.dynamic && '动态', opts.sources.cover && '封面', opts.cvs.length && '专栏'].filter(Boolean).join(' / ') || '（仅显式列表）'}`);

  for (const bvid of opts.bvids) { if (opts.sources.cover) { await collectCover(bvid); await sleep(opts.delayMs); } }
  for (const bvid of opts.bvids) { if (opts.sources.comments) { await collectComments(bvid); await sleep(opts.delayMs); } }
  for (const mid of opts.mids) { if (opts.sources.dynamic) { await collectDynamic(mid); await sleep(opts.delayMs); } }
  for (const cv of opts.cvs) { await collectArticle(cv); await sleep(opts.delayMs); }
  for (const kw of opts.keywords) { await collectKeyword(kw); await sleep(opts.delayMs); }

  const limited = candidates.slice(0, opts.limit);
  console.log(`\n候选图片 ${candidates.length} 张，本次处理 ${limited.length} 张（--limit ${opts.limit}）`);
  if (opts.dryRun) { for (const c of limited) console.log(`  [dry] ${c.source} ${c.url}`); return; }

  let saved = 0, skipped = 0, failed = 0;
  for (const c of limited) {
    try {
      const buf = await download(c.url);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      if (knownHashes.has(sha256)) { skipped++; continue; }
      const { w, h, ext } = imageSize(buf);
      if (!ext) { failed++; console.warn(`  跳过（非图片）：${c.url}`); continue; }
      if (opts.minSide > 0 && (w < opts.minSide || h < opts.minSide)) { skipped++; console.log(`  跳过（太小 ${w}x${h}）：${c.url}`); continue; }
      const file = `bili-${c.source}-${sha256.slice(0, 10)}.${ext}`;
      if (knownFiles.has(file)) { skipped++; continue; }
      fs.writeFileSync(path.join(OUT_ABS, file), buf);
      index.items.push({
        file, sha256, bytes: buf.length, width: w, height: h,
        source: c.source, origin: c.origin, title: c.title || '', url: c.url,
        fetchedAt: new Date().toISOString()
      });
      knownHashes.add(sha256); knownFiles.add(file);
      saved++;
      console.log(`  ✅ ${file}  ${w}x${h}  ${(buf.length / 1024).toFixed(0)}KB  ← ${c.source}`);
    } catch (error) {
      failed++;
      console.warn(`  ❌ ${c.url}：${error?.message ?? error}`);
    }
    await sleep(opts.delayMs);
  }
  index.updatedAt = new Date().toISOString();
  index.outDir = opts.outDir;
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  console.log(`\n完成：新增 ${saved}，去重跳过 ${skipped}，失败 ${failed}；图库共 ${index.items.length} 张`);
  console.log(`索引：${path.relative(ROOT, INDEX_FILE)}`);
  console.log('提示：AI 可以用 qq_save_sticker / qq_send_image 的 source=library 指定这些文件名。');
}

main().catch((error) => { console.error('抓图失败：', error); process.exit(1); });
