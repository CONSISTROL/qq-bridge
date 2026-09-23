// HTML → 纯文本 / 元信息抽取（web_fetch 用）。
//
// 背景：`web_fetch` 原来只回原始 HTML，模型得自己啃标签 —— 正常页面看不干净，
// 遇到**前端渲染（SPA）**页面则只看到一坨 `<div id="app"></div>`，既看不出「为什么没正文」，
// 也不知道下一步该怎么办（实测 AI 会回「我点进去了但抓不到正文」然后卡住）。
//
// 这里做三件事，都是纯函数、可离线单测：
// 1) `extractHtmlText`：剥离 script/style 等非正文节点，压成可读文本；
// 2) `extractHtmlMeta`：抽 <title> / description / og:description / JSON-LD 的摘要，
//    SPA 页面往往没有正文，但这些元信息通常还在；
// 3) `detectRenderHint`：识别「几乎是空壳」的页面，明确告诉模型这是前端渲染，
//    并给出可行的替代路径，而不是让它反复重试。

const BLOCK_TAGS = /<\/?(?:p|div|br|li|ul|ol|tr|td|th|table|section|article|header|footer|h[1-6]|blockquote|pre|figure|figcaption|dd|dt|dl|main|aside|nav|form|label|option|select|button|hr)[^>]*>/gi;
const DROP_BLOCKS = /<(script|style|noscript|template|svg|iframe|canvas|audio|video|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;

const ENTITIES = {
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–',
  middot: '·', times: '×', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™'
};

/** 解开 HTML 实体（命名 + 十进制 + 十六进制）。 */
export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => ENTITIES[String(name).toLowerCase()] ?? m);
}

/** 剥离标签后压成可读文本（保留段落换行，压缩连续空行）。 */
export function extractHtmlText(html, { max = 12000 } = {}) {
  let s = String(html ?? '');
  // 先干掉 head 里那些不该出现在正文里的东西（title/meta 由 extractHtmlMeta 单独抽）
  s = s.replace(DROP_BLOCKS, ' ');
  s = s.replace(COMMENT, ' ');
  s = s.replace(BLOCK_TAGS, '\n');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  s = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (s.length > max) s = `${s.slice(0, max)}…`;
  return s;
}

/** 抽 <title> 与常见 description/og 元信息。 */
export function extractHtmlMeta(html) {
  const s = String(html ?? '');
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1] ?? '').trim();
  const metaOf = (patterns) => {
    for (const re of patterns) {
      const m = re.exec(s);
      const value = decodeEntities(m?.[1] ?? '').replace(/\s+/g, ' ').trim();
      if (value) return value;
    }
    return '';
  };
  const description = metaOf([
    /<meta[^>]+(?:property|name)=["']og:description["'][^>]*content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']og:description["']/i,
    /<meta[^>]+(?:property|name)=["']description["'][^>]*content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']description["']/i,
    /<meta[^>]+(?:property|name)=["']twitter:description["'][^>]*content=["']([^"']*)["']/i,
    /<meta[^>]+(?:property|name)=["']keywords["'][^>]*content=["']([^"']*)["']/i
  ]);
  return { title, description };
}

/**
 * 抽 JSON-LD（application/ld+json）里的结构化摘要。
 * SPA 页面经常没有正文，但会带 JSON-LD：headline/description/articleBody 往往能救一命。
 */
export function extractJsonLd(html, { max = 2000 } = {}) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html ?? ''))) !== null) {
    let obj;
    try { obj = JSON.parse(decodeEntities(m[1].trim())); } catch { continue; }
    const list = Array.isArray(obj) ? obj : [obj];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const headline = String(item.headline ?? item.name ?? '').trim();
      const description = String(item.description ?? '').trim();
      const body = String(item.articleBody ?? '').trim();
      if (headline) out.push(`标题：${headline}`);
      if (description) out.push(`摘要：${description}`);
      if (body) out.push(`正文：${body.slice(0, max)}`);
    }
  }
  return out.join('\n').slice(0, max);
}

/** 判断响应是不是 HTML（content-type 优先，其次看内容特征）。 */
export function looksLikeHtml(contentType, body) {
  const ct = String(contentType ?? '').toLowerCase();
  if (ct.includes('html')) return true;
  if (ct && !ct.includes('html') && (ct.includes('json') || ct.includes('text/plain'))) return false;
  return /<!doctype\s+html|<html[\s>]/i.test(String(body ?? ''));
}

/** 正文少于此长度时，才进一步看有没有前端渲染特征。 */
export const MIN_USABLE_TEXT = 80;

/** 常见 SPA 挂载点：内容是 JS 填进去的，HTML 里留一个空容器。 */
const APP_MOUNT_RE = /<(?:div|main|section)[^>]+id=["'](?:app|root|__next|__nuxt|app-root|appRoot|react-root|mount)["'][^>]*>\s*<\/(?:div|main|section)>/i;

/**
 * 判断页面是否「像前端渲染」。
 * 光看正文短是不够的——一篇短文章也会正文少；所以要**同时**满足：
 *   1) 可见正文 < MIN_USABLE_TEXT；
 *   2) 有前端渲染特征：存在空的 SPA 挂载点，或页面里挂了 ≥2 个 script。
 * 宁可漏报也不误报：误报会让模型放弃一个本来抓得到的页面。
 */
export function looksLikeSpaShell(body) {
  const html = String(body ?? '');
  const visible = extractHtmlText(html, { max: 4000 }).replace(/\s/g, '').length;
  if (visible >= MIN_USABLE_TEXT) return false;
  if (APP_MOUNT_RE.test(html)) return true;
  const scriptCount = (html.match(/<script\b/gi) || []).length;
  return scriptCount >= 2;
}

/**
 * 识别「反爬 / 安全验证」拦截页。
 *
 * 背景：贴吧、部分站点按 **IP 风控**，无登录态时列表页/帖子页/搜索统一返回
 * 403 + 「百度安全验证」滑块页。纯 HTTP 抓不到，换无头浏览器**也过不了滑块**
 * （实测 web_render 同样被拦）。原实现把验证页的字样当成正文喂给模型，
 * 模型只会一脸茫然地反复重试同一个 URL。
 *
 * 返回给模型看的提示（不需要提示时返回空串）。
 */
export function detectAccessHint({ statusCode, text, body, url = '' }) {
  const flat = String(text ?? '').replace(/\s/g, '');
  const head = String(body ?? '').slice(0, 8000);
  const hay = `${text ?? ''}\n${head}`;
  const looksBlocked = /百度安全验证|请完成下方验证|滑动完成拼图|访问过于频繁|请输入验证码|人机验证|机器人验证|安全验证后继续/i.test(hay)
    || /Just a moment|cf-browser-verification|Checking your browser|Attention Required.*Cloudflare/i.test(hay)
    || (Number(statusCode) === 403 && flat.length < 200 && /<html|<!doctype/i.test(head));
  if (!looksBlocked) return '';
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { /* 相对/空 URL */ }
  const isBaidu = /(^|\.)(tieba\.baidu\.com|baidu\.com)$/.test(host);
  const parts = [
    `该请求被目标站点的**反爬 / 安全验证**拦截了（HTTP ${statusCode || '?'}，拿到的是验证页而不是正文），页面里没有可用内容。`,
    '这是**按 IP 的风控**：换 web_render（无头浏览器）也过不了滑块验证（实测同样被拦），反复重试同一个 URL 只会让情况更糟。'
  ];
  const paths = [];
  if (isBaidu) {
    // 实测：热榜与热榜话题详情这两条路径不受 IP 风控影响，可以直接抓
    paths.push('贴吧**热议榜单可以直接抓**（30 条热榜话题 + 讨论量 + 摘要）：`https://tieba.baidu.com/hottopic/browse/topicList?res_type=1`');
    paths.push('从热榜点进**话题详情**也能抓，能看到该话题下相关帖子的正文/作者/来自哪个吧：`https://tieba.baidu.com/hottopic/browse/hottopic?topic_id=<热榜里的 topic_id>`（topic_id 就在 topicList 返回的链接里）');
    paths.push('但**具体某个吧的帖子列表（/f?kw=）、帖子详情（/p/）、吧内搜索**被 IP 风控拦死，需要给桥接配置贴吧登录 cookie（BDUSS）才能读');
  } else {
    paths.push('用 web_search 搜标题/关键词，从搜索摘要里拿信息');
  }
  paths.push('请对方把正文文字贴过来，或换一条可访问的来源');
  parts.push(`可以这样做：${paths.map((p, i) => `${'①②③④⑤'[i] || '•'} ${p}`).join('；')}。`);
  return parts.join('\n');
}

/**
 * 识别前端渲染页面：HTML 里几乎没有可读文本，说明正文是 JS 动态加载的。
 * 返回给模型看的提示（不需要提示时返回空串）——重点是给出**下一步能做什么**，
 * 否则模型只会反复重试同一个 URL。
 */
export function detectRenderHint({ text, contentType, body, meta = {}, jsonLd = '', renderToolAvailable = false }) {
  if (!looksLikeHtml(contentType, body)) return '';
  if (!looksLikeSpaShell(body)) return '';
  const visible = String(text ?? '').replace(/\s/g, '').length;
  const parts = [
    `该页面疑似**前端渲染（SPA）**：剥离脚本后可见正文只有 ${visible} 字，正文由 JS 动态加载，纯 HTTP 抓取拿不到。`
  ];
  const extra = [];
  if (meta.description) extra.push(`页面 meta 描述：${String(meta.description).slice(0, 200)}`);
  if (jsonLd) extra.push(`页面 JSON-LD：${String(jsonLd).slice(0, 300)}`);
  if (extra.length) parts.push(`能拿到的线索——${extra.join('；')}`);
  // 有 web_render 时它就是第一选择：真浏览器执行 JS，才能拿到 SPA 正文
  parts.push(renderToolAvailable
    ? '可以这样做：① 调用 **web_render**（无头浏览器渲染后再取正文，能读 SPA，代价是慢几秒）；② 用 web_search 搜标题/关键词拿摘要；③ 请对方截图或把正文文字复制过来。不要反复重试同一个 URL。'
    : '可以这样做：① 用 web_search 搜标题/关键词拿摘要；② 试该站点的开放 API（分享接口常返回 JSON）；③ 直接请对方截图或把正文文字复制过来。不要反复重试同一个 URL。');
  return parts.join('\n');
}
