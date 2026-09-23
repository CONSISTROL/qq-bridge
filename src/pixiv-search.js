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
  const m = /^(?<tags>.*?)图片(?:\s*-\s*(?<title>.*?))?\s*\|\s*(?<res>[^|]*?)分辨率\s*(?<w>\d+)x(?<h>\d+)\s*$/.exec(text);
  if (m?.groups) {
    return {
      tags: m.groups.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      title: String(m.groups.title ?? '').trim(),
      width: Number(m.groups.w) || 0,
      height: Number(m.groups.h) || 0
    };
  }
  return null;
}

/** 关键词 → 作品 id 列表。同时支持直接给 pixiv 作品 id / 作品链接（省一次抓取）。 */
export function artworkIdFromInput(input) {
  const text = String(input ?? '').trim();
  if (/^\d{5,12}$/.test(text)) return text;
  const m = /(?:artworks?\/|illust_id=|pixiv\.re\/)(\d{5,12})/i.exec(text);
  return m ? m[1] : '';
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
