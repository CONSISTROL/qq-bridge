// QQ 卡片消息解析：把 `json` / `xml` / `share` 消息段渲染成 AI 能读的一句话。
//
// 背景：卡片消息（分享链接、小程序、音乐、群邀请、打卡…）在 OneBot 里是
//   { type: 'json', data: { data: '<json 字符串>' } }
//   { type: 'xml',  data: { data: '<xml 字符串>' } }
//   { type: 'share', data: { url, title, content } }
// 桥接原来只输出 `[卡片消息]`，AI 完全看不到标题/摘要/链接，只能回「我读不到里面写了啥」。
//
// 设计原则：
// - **只做提取，不执行**：产出纯文本，URL 只是文本，不抓取、不跳转；
// - 卡片内容是**对方可控**的，进 prompt 前必须：截断长度、压掉换行/控制字符，
//   避免一张卡片顶掉整段上下文（历史消息只存 200 字）；
// - 解析失败要明确说「解析失败」，不要假装读到了内容。

export const CARD_TITLE_MAX = 60;
export const CARD_DESC_MAX = 90;
export const CARD_URL_MAX = 400;
export const CARD_SOURCE_MAX = 24;
/**
 * 卡片摘要总长上限。
 * 这里必须**放得下一条完整链接**：链接被截断（`...share?h_camp…`）对 AI 等于没有，
 * 它会直接回「我打不开，你把完整链接发我」。所以摘要优先保 标题 + 完整 URL，
 * 摘要文字最后才考虑；真正超长（>400 字）的 URL 仍会被截断并带 `…`，
 * 但那时完整值一定能在消息对象的结构化 `card.url` 字段里拿到。
 */
export const CARD_SUMMARY_MAX = 320;
/** 结构化 card 字段里 URL/预览图允许的最大长度（远大于摘要，保证完整）。 */
export const CARD_STORE_URL_MAX = 1200;

/** 压掉换行/控制字符并截断（卡片里经常带 \n、&#10;，还有 U+2028/U+2029 这类行分隔符）。 */
export function cleanCardText(value, max = CARD_DESC_MAX) {
  return String(value ?? '')
    // C0/C1 控制字符 + 零宽字符 + U+2028/2029 行分隔符（它们看着像换行，会破坏单行摘要）
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

/** 解开 XML 实体（含 &#10; / &#x27; 这类数字引用）。 */
export function decodeXmlEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-z]+);/gi, (m, name) => XML_ENTITIES[String(name).toLowerCase()] ?? m);
}

/** 从 XML 里取第一个非空标签文本（支持 CDATA）。 */
export function pickXmlTag(xml, tags) {
  for (const tag of tags) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
    const m = re.exec(String(xml ?? ''));
    if (!m) continue;
    let raw = m[1];
    // <![CDATA[ ... ]]> 里的内容不再做实体解码
    const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
    const value = cdata ? cdata[1] : decodeXmlEntities(raw.replace(/<[^>]*>/g, ''));
    const clean = cleanCardText(value, 400);
    if (clean) return clean;
  }
  return '';
}

/** 卡片来源标签：把 OneBot 的 app id 变成人话。 */
export function cardSourceLabel(app, view) {
  const a = String(app ?? '').toLowerCase();
  const v = String(view ?? '').toLowerCase();
  if (a.includes('structmsg')) {
    if (v.includes('music')) return '音乐';
    if (v.includes('news')) return '分享';
    if (v.includes('video')) return '视频';
    return '分享';
  }
  if (a.includes('miniapp')) return '小程序';
  if (a.includes('music')) return '音乐';
  if (a.includes('checkin') || a.includes('sign')) return '打卡';
  if (a.includes('troop') || a.includes('group')) return '群卡片';
  if (a.includes('file') || a.includes('folder')) return '文件卡片';
  if (a.includes('live') || a.includes('room')) return '直播间';
  if (a.includes('gift')) return '礼物';
  if (!a && v) return '卡片';
  return '卡片';
}

/** 从 meta 里挑出真正装内容的那个子对象。 */
function pickMeta(meta, view) {
  if (!meta || typeof meta !== 'object') return null;
  const wanted = String(view ?? '').trim();
  if (wanted && meta[wanted] && typeof meta[wanted] === 'object') return meta[wanted];
  for (const value of Object.values(meta)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return null;
}

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

/**
 * 解析 `json` 段的 data 字符串。
 * 兼容 app 差异：structmsg（分享/新闻/音乐）、miniapp_01（小程序）等。
 * 返回 { source, app, view, title, desc, url, preview, prompt }；解析不出来返回 null。
 */
export function parseJsonCard(raw) {
  let obj;
  try {
    obj = JSON.parse(String(raw ?? ''));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const view = String(obj.view ?? '');
  const meta = pickMeta(obj.meta, view);
  const detail = meta?.detail_1 && typeof meta.detail_1 === 'object' ? meta.detail_1 : null;
  const bag = detail ? { ...meta, ...detail } : (meta ?? {});
  const prompt = cleanCardText(obj.prompt, 120);
  const title = cleanCardText(firstString(bag, ['title', 'name', 'nickname']) || prompt, CARD_TITLE_MAX);
  const desc = cleanCardText(firstString(bag, ['desc', 'summary', 'description', 'content', 'brief']), CARD_DESC_MAX);
  // 解析阶段**不按摘要长度截断**：完整链接要留给结构化 card.url，摘要自己再收窄。
  const url = cleanCardText(firstString(bag, ['jumpUrl', 'qqdocurl', 'url', 'sourceUrl', 'webUrl', 'jump_url']), CARD_STORE_URL_MAX);
  const preview = cleanCardText(firstString(bag, ['preview', 'icon', 'thumb']), CARD_STORE_URL_MAX);
  const tag = cleanCardText(firstString(bag, ['tag', 'source', 'appName', 'from']), CARD_SOURCE_MAX);
  const source = tag || cardSourceLabel(obj.app, view);
  if (!title && !desc && !url) return null;
  return { source, app: String(obj.app ?? ''), view, title, desc, url, preview, prompt };
}

/** 从 XML 卡片内容里猜来源（xml 卡片没有 app 字段，只能靠特征词）。 */
export function xmlCardSourceLabel(xml, title = '') {
  const t = `${String(xml ?? '')} ${String(title ?? '')}`;
  if (/群邀请|加入群聊|邀请你加入|groupinvite/i.test(t)) return '群邀请';
  if (/文件|folder|fileid/i.test(t)) return '文件卡片';
  if (/红包|转账|redpacket|lucky/i.test(t)) return '红包';
  if (/投票|vote/i.test(t)) return '投票';
  if (/音乐|music|song/i.test(t)) return '音乐';
  if (/直播|live/i.test(t)) return '直播间';
  return '';
}

/** 解析 `xml` 段的 data 字符串（老式卡片，字段都在标签里）。 */
export function parseXmlCard(raw) {
  const xml = String(raw ?? '');
  if (!xml.trim()) return null;
  const title = pickXmlTag(xml, ['title']);
  const desc = cleanCardText(pickXmlTag(xml, ['summary', 'desc', 'description', 'brief']), CARD_DESC_MAX);
  const url = cleanCardText(pickXmlTag(xml, ['url', 'jumpUrl', 'qqdocurl', 'sourceUrl']), CARD_STORE_URL_MAX);
  const preview = cleanCardText(pickXmlTag(xml, ['preview', 'thumb', 'picture']), CARD_STORE_URL_MAX);
  const tag = cleanCardText(pickXmlTag(xml, ['tag', 'sourcename', 'appname']), CARD_SOURCE_MAX);
  const source = tag || xmlCardSourceLabel(xml, title);
  if (!title && !desc && !url) return null;
  return { source, app: '', view: '', title, desc, url, preview, prompt: '' };
}

/** 把 `share` 段（{url,title,content}）归一成同样的结构。 */
export function parseShareCard(data) {
  const d = data && typeof data === 'object' ? data : {};
  const title = cleanCardText(d.title, CARD_TITLE_MAX);
  const desc = cleanCardText(d.content, CARD_DESC_MAX);
  const url = cleanCardText(d.url, CARD_STORE_URL_MAX);
  if (!title && !desc && !url) return null;
  return { source: '链接分享', app: '', view: '', title, desc, url, preview: '', prompt: '' };
}

const CARD_PART_TITLE_MAX = 56;
const CARD_PART_DESC_MAX = 70;
const CARD_PART_URL_MAX = 60;

/** 超长部分截断并加省略号——URL 被砍掉一半却看不出截断，比直接标出来更糟。 */
function fitPart(text, cap) {
  const s = String(text ?? '');
  if (s.length <= cap) return s;
  return `${s.slice(0, Math.max(1, cap - 1))}…`;
}

/**
 * 生成给 AI 看的一句话摘要。
 * 形如：`[卡片·小黑盒] 标题；链接：https://...；摘要`
 *
 * **URL 优先级高于摘要文字**：实测把链接截断成 `...?h_camp…` 之后，AI 会直接判定
 * 「打不开，你把完整链接发我」——那这句摘要就等于白给。所以顺序是：
 *   ① 标题 + 完整链接 + 摘要 → ② 标题 + 完整链接 → ③ 标题 + 截断链接 → ④ 只要标题
 * 只有连第 ③ 步都放不下时才会丢内容；无论如何，消息对象上的 `card.url` 始终是完整链接。
 */
export function formatCardSummary(card, { max = CARD_SUMMARY_MAX } = {}) {
  if (!card) return '[卡片消息（解析失败）]';
  // 认不出来源时就写 [卡片]，不要出现 [卡片·卡片] 这种重复。
  const label = card.source && card.source !== '卡片' ? `·${card.source}` : '';
  const head = `[卡片${label}]`;
  const title = fitPart(cleanCardText(card.title, CARD_TITLE_MAX), CARD_PART_TITLE_MAX);
  const desc = card.desc && card.desc !== card.title
    ? fitPart(cleanCardText(card.desc, CARD_DESC_MAX), CARD_PART_DESC_MAX)
    : '';
  // 完整链接（上限给足，放不下时下面还有截断版兜底）
  const fullUrl = card.url ? `链接：${cleanCardText(card.url, CARD_URL_MAX)}` : '';
  const fitUrl = fullUrl ? fitPart(fullUrl, CARD_PART_URL_MAX) : '';

  const budget = Math.max(0, max - head.length - 1);
  const candidates = [
    [title, fullUrl, desc],   // 最理想：什么都在
    [title, fullUrl],         // 丢掉摘要，保完整链接
    [title, fitUrl, desc],    // 链接太长，只能截断（并有 card.url 兜底）
    [title, fitUrl],
    [title]
  ];
  for (const parts of candidates) {
    const text = parts.filter(Boolean).join('；');
    if (text.length <= budget) return `${head} ${text}`.trim();
  }
  // 连标题都超预算（几乎不可能）：硬截断，避免把单条消息撑爆。
  return `${head} ${fitPart(title, Math.max(1, budget))}`.trim();
}

/** 只清控制字符、不截断（结构化字段要完整链接）。 */
function stripControlChars(value) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]+/g, '')
    .trim();
}

/**
 * 把解析出来的卡片归一成**存进消息对象**的结构化字段。
 * 关键：url / preview **不截断**（只限制一个很宽松的上限），
 * 这样即使摘要里的链接被省略，AI 仍能从 card.url 拿到完整可打开的链接。
 */
export function normalizeCardForStore(card, kind = '') {
  if (!card) return null;
  return {
    kind: String(kind || 'json'),
    source: cleanCardText(card.source, CARD_SOURCE_MAX),
    title: cleanCardText(card.title, 200),
    desc: cleanCardText(card.desc, CARD_DESC_MAX),
    url: stripControlChars(card.url).slice(0, CARD_STORE_URL_MAX),
    preview: stripControlChars(card.preview).slice(0, CARD_STORE_URL_MAX)
  };
}

/**
 * 从消息段里提取第一张卡片的完整结构化信息。
 * 供消息存储 / 引用解析使用（`qq_get_unread_messages` / `qq_get_recent_messages` /
 * `qq_get_message_detail` 返回的消息对象里会带 `card`）。
 */
export function extractCardFromSegments(segments) {
  for (const seg of segments ?? []) {
    const type = String(seg?.type ?? '');
    const d = seg?.data ?? {};
    let card = null;
    if (type === 'json') card = parseJsonCard(d.data);
    else if (type === 'xml') card = parseXmlCard(d.data);
    else if (type === 'share') card = parseShareCard(d);
    if (card) return normalizeCardForStore(card, type);
  }
  return null;
}

/**
 * 统一入口：给 `segmentsToText` 用。
 * 传入 json/xml/share 消息段，返回可读文本；解析不出来时返回带原因的占位符。
 */
export function cardSegmentToText(seg) {
  const type = String(seg?.type ?? '');
  const d = seg?.data ?? {};
  if (type === 'share') {
    return formatCardSummary(parseShareCard(d));
  }
  if (type === 'json') {
    const card = parseJsonCard(d.data);
    return card ? formatCardSummary(card) : '[卡片消息（json 解析失败）]';
  }
  if (type === 'xml') {
    const card = parseXmlCard(d.data);
    return card ? formatCardSummary(card) : '[卡片消息（xml 解析失败）]';
  }
  return '[卡片消息]';
}

/** 卡片里可选的预览图 URL（供后续按需看图用；当前只做提取，不自动下载）。 */
export function cardPreviewUrl(seg) {
  const type = String(seg?.type ?? '');
  const d = seg?.data ?? {};
  let card = null;
  if (type === 'json') card = parseJsonCard(d.data);
  else if (type === 'xml') card = parseXmlCard(d.data);
  else if (type === 'share') card = parseShareCard(d);
  return card?.preview && /^https?:\/\//i.test(card.preview) ? card.preview : '';
}
