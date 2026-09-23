// pixiv 图片检索（不直连 pixiv）。
//
// 背景：本机到 www.pixiv.net / i.pximg.net 的 DNS 被污染且没有代理，直连必然超时。
// 实测可用的两条路：
//   1) bobopic.com 镜像了 pixiv 的综合日榜与标签页（中文标签），能拿到作品 id、标签、标题、分辨率；
//   2) pixiv.re 是按作品 id 取原图的第三方代理（已进 refererAllow 白名单）。
// 于是「搜图」= 在 bobopic 上按关键词/日榜找 id，「取图」= 拼 pixiv.re 的直链。
//
// 本模块只负责 ① 抓 bobopic 页面 ② 解析出条目 ③ 按年龄分级过滤
// （分级判定在 image-rating.js，别在这里再写一套）。
import { safeFetch } from './safe-fetch.js';
import { filterByRating } from './image-rating.js';

const IMG_ORIGIN = 'https://img.pixivdaily.com';
const TAG_SEARCH = (kw) => `https://bobopic.com/tag/${encodeURIComponent(kw)}/`;
const DAILY_RANKING = (date) => `https://bobopic.com/daily${date ? `?date=${encodeURIComponent(date)}` : ''}`;
const PIXIV_PROXY = (id) => `https://pixiv.re/${id}.png`;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** bobopic 的 alt 文本里常见的 HTML 实体（标题里 &#039; 很常见）。 */
export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/**
 * 解析 bobopic 页面里的作品条目。两种页面形态：
 * - 标签页：alt="初音未来,助手席图片 - 标题 | 1K分辨率 1076x1522"
 * - 日榜页：alt="标题_PID:149947935"
 * 作品 id 一律以缩略图 URL 里的数字为准（比 alt 可靠）。
 * 解析不出上述形态的 alt（例如相关文章缩略图）直接跳过。
 */
export function parseBobopicImages(html, { source = 'tag' } = {}) {
  const items = [];
  const seen = new Set();
  for (const tag of String(html ?? '').match(/<img\b[^>]*>/gi) ?? []) {
    const src = /src="([^"]+)"/i.exec(tag)?.[1] ?? '';
    const matched = /^https:\/\/img\.pixivdaily\.com\/[a-z0-9]+\/(\d+)\.(?:jpe?g|png|webp)/i.exec(src);
    if (!matched) continue;
    const id = matched[1];
    if (seen.has(id)) continue;
    const parsed = parseAlt(decodeEntities(/alt="([^"]*)"/i.exec(tag)?.[1] ?? ''));
    if (!parsed) continue;
    seen.add(id);
    items.push({
      id,
      url: PIXIV_PROXY(id),
      thumbUrl: src,
      title: parsed.title,
      tags: parsed.tags,
      width: parsed.width,
      height: parsed.height,
      provider: 'pixiv',
      source,
      detailUrl: `https://www.pixiv.net/artworks/${id}`
    });
  }
  return items;
}

function parseAlt(alt) {
  const text = String(alt ?? '').trim();
  if (!text) return null;
  const pid = /_PID:(\d+)\s*$/.exec(text);
  if (pid) return { title: text.slice(0, pid.index).trim(), tags: [], width: 0, height: 0 };
  // 标签页模板 bobopic 换过一次，两种都得认：
  //   旧：初音未来图片 - メイドさん | 高清分辨率 960x1280
  //   新：永雏塔菲,大腿,脚底,脚指图片|尺寸1863x2795
  // 用「图片 后面跟着 |」当分界线：相关文章缩略图的 alt（[pixiv]…共108张图片）没有这个 |，
  // 照样被跳过。尺寸从 | 之后的文本里取第一处 WxH（前缀是「尺寸」还是「N K分辨率」都行）。
  const parts = /^(?<tags>.*?)图片(?:\s*-\s*(?<title>.*?))?\s*\|\s*(?<rest>.+)$/.exec(text);
  if (!parts?.groups) return null;
  const dims = /(?<w>\d{2,5})\s*[x×]\s*(?<h>\d{2,5})/.exec(parts.groups.rest);
  if (!dims) return null;
  return {
    tags: parts.groups.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    title: String(parts.groups.title ?? '').trim(),
    width: Number(dims.groups.w) || 0,
    height: Number(dims.groups.h) || 0
  };
}

/** 关键词 → 作品 id 列表。同时支持直接给 pixiv 作品 id / 作品链接（省一次抓取）。 */
export function artworkIdFromInput(input) {
  const text = String(input ?? '').trim();
  if (/^\d{5,12}$/.test(text)) return text;
  const m = /(?:artworks?\/|illust_id=|pixiv\.re\/)(\d{5,12})/i.exec(text);
  return m ? m[1] : '';
}

/**
 * 从 **pixiv.re / i.pixiv.re 的图片直链**里取作品 id（只认这种直链，别拿它当通用 id 解析器——
 * pixiv.net 链接、裸数字都用 artworkIdFromInput）。返回 '' 表示不是这种直链。
 * 桥接用它决定「要不要走原图回退链」：这类链接慢/爱超时，失败时能换别的源把原图捞回来。
 */
export function pixivProxyIdFromUrl(input) {
  const m = /^https?:\/\/(?:i\.)?pixiv\.re\/(\d{5,12})(?:\.\w+)?(?:[?#].*)?$/i.exec(String(input ?? '').trim());
  return m ? m[1] : '';
}

/**
 * 从**任意** pixiv 系图片地址里认作品 id：pixiv.re 代理、i.pximg.net 原图/缩略图、
 * img.pixivdaily.com 缩略图、pixiv 作品页链接都认。认不出返回 ''。
 * 用途：防重发——同一张图换个镜像/换个尺寸（原图 vs 缩略图）必须算「同一张」。
 */
export function pixivArtworkIdFromAnyUrl(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';
  const proxy = pixivProxyIdFromUrl(text);
  if (proxy) return proxy;
  // 末尾可能带尺寸后缀（img.pixivdaily.com 的 `-220`）或 query。
  // 同一作品可能是 `149763736_p0.png`、`149763736_p0_square1200.jpg`、`115570927.jpg-220`。
  const byPath = /\/(\d{5,12})(?:_[A-Za-z0-9]+)*\.(?:jpe?g|png|webp)(?:-\d+)?(?:[?#]|$)/i.exec(text);
  if (byPath) return byPath[1];
  const byArtwork = /artworks?\/(\d{5,12})/i.exec(text);
  return byArtwork ? byArtwork[1] : '';
}

/** bobopic 的缩略图直链（740px 左右、几十 KB）：原图超时/超体积时的最后兜底。 */
export function pixivThumbUrl(id) {
  return `${IMG_ORIGIN}/small/${String(id ?? '').trim()}.jpg`;
}

/**
 * 按关键词在 bobopic 标签页搜图。
 * @param {string} keyword 中文标签词（bobopic 用的就是中文标签，例如「初音未来」「原神」）
 */
export async function searchPixivByTag(keyword, { limit = 6, rating = 'safe', words, fetchImpl = safeFetch } = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) throw new Error('关键词不能为空');
  const directId = artworkIdFromInput(kw);
  if (directId) {
    const item = { id: directId, url: PIXIV_PROXY(directId), thumbUrl: `${IMG_ORIGIN}/small/${directId}.jpg`, title: '', tags: [], width: 0, height: 0, provider: 'pixiv', source: 'id', detailUrl: `https://www.pixiv.net/artworks/${directId}` };
    const filtered = filterByRating([item], rating, words);
    return { mode: 'id', query: kw, pageUrl: '', ...filtered, keptCount: filtered.items.length, items: filtered.items.slice(0, limit) };
  }
  const pageUrl = TAG_SEARCH(kw);
  const res = await fetchImpl(pageUrl, 400000, { headers: { 'user-agent': UA } });
  if (res.statusCode !== 200) throw new Error(`标签页抓取失败：HTTP ${res.statusCode}`);
  const all = parseBobopicImages(res.body, { source: 'tag' });
  if (!all.length) throw new Error(`没找到标签「${kw}」的图（bobopic 的标签是中文，可换更常见的称呼试试）`);
  const filtered = filterByRating(all, rating, words);
  return { mode: 'tag', query: kw, pageUrl, ...filtered, keptCount: filtered.items.length, items: filtered.items.slice(0, limit) };
}

/** 上海时区的 YYYY-MM-DD（offsetDays 为负表示往前推几天）。 */
export function shanghaiDate(offsetDays = 0, now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(now + offsetDays * 86400000));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * pixiv 综合日榜（全年龄榜）取图。
 * 不传 date 时从「今天」往前试最多 3 天：榜单是每天中午前后才更新，
 * 当天的页面在更新前是个空壳（实测 `/daily` 不带 date 或日期未更新时 0 张图）。
 */
export async function pixivDailyRanking({ date = '', limit = 6, rating = 'safe', words, fetchImpl = safeFetch } = {}) {
  const candidates = date ? [String(date)] : [0, 1, 2].map((d) => shanghaiDate(-d));
  const tried = [];
  for (const day of candidates) {
    const pageUrl = DAILY_RANKING(day);
    const res = await fetchImpl(pageUrl, 400000, { headers: { 'user-agent': UA } });
    if (res.statusCode !== 200) { tried.push(`${day}: HTTP ${res.statusCode}`); continue; }
    const all = parseBobopicImages(res.body, { source: 'daily' });
    if (!all.length) { tried.push(`${day}: 0 条`); continue; }
    const filtered = filterByRating(all, rating, words);
    return {
      mode: 'daily', query: '', date: day, pageUrl, ...filtered,
      keptCount: filtered.items.length, items: filtered.items.slice(0, limit)
    };
  }
  throw new Error(`日榜页没解析到作品（试过 ${tried.join('、')}；可能是当天榜单还没出，或页面结构变了）`);
}

// ── 真实 pixiv（走代理 + 可选登录 cookie）────────────────────────────────────
// bobopic 只是第三方镜像，标签页只有个位数的作品、且完全不含 R-18。本机有代理时，
// 直接打 pixiv 自己的 ajax 接口：搜索字段全（xRestrict / tags / 作者 / 宽高），
// R-18 只在**带登录 cookie** 时才返回（实测未登录时 mode=r18 与 mode=all 结果完全相同）。
// 代理与 cookie 都由管理员配在 config.json，AI/群友碰不到。

const PIXIV_WEB = 'https://www.pixiv.net';

/** 搜索结果条目 → 统一结构（原图直链要再查一次详情：i.pximg 的路径里带日期，拼不出来）。 */
function pixivWebItem(raw) {
  const x = Number(raw?.xRestrict) || 0;
  return {
    id: String(raw?.id ?? ''),
    title: String(raw?.title ?? ''),
    tags: Array.isArray(raw?.tags) ? raw.tags.map(String) : [],
    thumbUrl: String(raw?.url ?? ''),
    url: '',
    detailUrl: `${PIXIV_WEB}/artworks/${raw?.id ?? ''}`,
    width: Number(raw?.width) || 0,
    height: Number(raw?.height) || 0,
    userId: String(raw?.userId ?? ''),
    userName: String(raw?.userName ?? ''),
    pageCount: Number(raw?.pageCount) || 1,
    xRestrict: x,
    // xRestrict: 0=全年龄 1=R-18 2=R-18G。1 交给 r18 档，2 永远拦。
    ...(x >= 2 ? { rating: 'explicit', ratingReason: 'pixiv xRestrict=2（R-18G）' } : {}),
    ...(x === 1 ? { rating: 'r18', ratingReason: 'pixiv xRestrict=1（R-18）' } : {}),
    provider: 'pixiv',
    source: 'web'
  };
}

/**
 * 归一化管理员填的 pixiv cookie。
 * 实测最容易踩的坑：控制台/配置里只填了 **值**（`26362806_xxx`），直接当 Cookie 头发出去
 * 是非法头（没有 `name=value`），pixiv 会当未登录处理 → R-18 静默变成全年龄。
 * 这里统一补上 `PHPSESSID=`；也接受整行 `Cookie: a=b; c=d`（顺手剥掉前缀）。
 */
export function normalizePixivCookie(raw) {
  const v = String(raw ?? '').replace(/[\r\n]/g, ' ').trim().replace(/^cookie\s*:\s*/i, '').trim();
  if (!v) return '';
  return v.includes('=') ? v : `PHPSESSID=${v}`;
}

function pixivHeaders(cookie) {
  const headers = { 'user-agent': UA, referer: `${PIXIV_WEB}/` };
  const normalized = normalizePixivCookie(cookie);
  if (normalized) headers.cookie = normalized;
  return headers;
}

/**
 * 真实 pixiv 关键词搜索。
 * @param {string} word 关键词（中日英文都可）
 * @param {{mode?:'safe'|'all'|'r18', limit?:number, rating?:string, words?:object, cookie?:string, proxy?:string, fetchImpl?:Function}} [opts]
 */
export async function searchPixivWeb(word, { mode = 'all', limit = 8, rating = 'safe', words, cookie = '', proxy = '', fetchImpl = safeFetch } = {}) {
  const kw = String(word ?? '').trim();
  if (!kw) throw new Error('关键词不能为空');
  const pixivMode = mode === 'r18' || mode === 'safe' ? mode : 'all';
  const q = encodeURIComponent(kw);
  const url = `${PIXIV_WEB}/ajax/search/artworks/${q}?word=${q}&mode=${pixivMode}&p=1&lang=zh`;
  const res = await fetchImpl(url, 800000, { headers: pixivHeaders(cookie), proxy, timeoutMs: 30000 });
  if (res.statusCode !== 200) throw new Error(`pixiv 搜索失败：HTTP ${res.statusCode}`);
  let data;
  try { data = JSON.parse(res.body); } catch { throw new Error('pixiv 搜索返回的不是 JSON（可能被风控页拦了）'); }
  if (data.error) throw new Error(`pixiv 搜索报错：${data.message || '未知'}`);
  // pixiv 有时把列表放在 illustManga，有时放在 illust（不同查询/风控路径），两个都认。
  const listNode = data?.body?.illustManga ?? data?.body?.illust ?? {};
  const raw = listNode.data ?? [];
  const items = raw.map(pixivWebItem).filter((it) => it.id);
  const filtered = filterByRating(items, rating, words);
  return {
    mode: 'web',
    query: kw,
    pixivMode,
    pageUrl: `${PIXIV_WEB}/tags/${q}/artworks`,
    ...filtered,
    // 注意顺序：filterByRating 也返回一个 total（=本页解析条数），这里要用 pixiv 报的总数覆盖它。
    total: Number(listNode.total) || items.length,
    keptCount: filtered.items.length,
    items: filtered.items.slice(0, limit)
  };
}

/**
 * 按作品 id 取原图直链（`i.pximg.net`，必须带 `Referer: https://www.pixiv.net/`，否则 403）。
 * R-18 作品的详情在未登录时可能拿不到，此时抛错，调用方回退到 pixiv.re / bobopic。
 */
export async function pixivIllustOriginal(id, { cookie = '', proxy = '', fetchImpl = safeFetch } = {}) {
  const pid = String(id ?? '').trim();
  if (!/^\d{5,12}$/.test(pid)) throw new Error(`作品 id 不合法：${pid}`);
  const url = `${PIXIV_WEB}/ajax/illust/${pid}?lang=zh`;
  const res = await fetchImpl(url, 400000, { headers: pixivHeaders(cookie), proxy, timeoutMs: 30000 });
  if (res.statusCode !== 200) throw new Error(`pixiv 作品详情失败：HTTP ${res.statusCode}`);
  let data;
  try { data = JSON.parse(res.body); } catch { throw new Error('pixiv 作品详情返回的不是 JSON'); }
  if (data.error) throw new Error(`pixiv 作品详情报错：${data.message || '未知'}`);
  const body = data.body || {};
  const original = String(body.urls?.original || '');
  if (!original) throw new Error('pixiv 作品详情里没有原图地址');
  return {
    id: String(body.illustId ?? pid),
    original,
    large: String(body.urls?.regular || ''),
    xRestrict: Number(body.xRestrict) || 0,
    tags: (body.tags?.tags ?? []).map((t) => String(t?.tag ?? '')).filter(Boolean)
  };
}

/** pixiv 原图是否走代理/带 cookie：按 hostname 判断，供桥接决定抓图参数。 */
export function isPixivHost(hostname) {
  const host = String(hostname ?? '').toLowerCase();
  return host === 'pixiv.net' || host.endsWith('.pixiv.net')
    || host === 'pximg.net' || host.endsWith('.pximg.net')
    || host === 'pixiv.re' || host.endsWith('.pixiv.re');
}
