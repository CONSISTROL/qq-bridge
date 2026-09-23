// 图片年龄分级：把「AI 能不能返回这张图」变成一个可配置的档位，而不是散落在各处的 if。
//
// 设计边界（重要，别当成 bug）：
// - 三档：`safe`（全年龄，默认）、`mild`（允许轻度擦边：水着/黑丝/大腿/巨乳这类标签）、
//   `r18`（允许 R-18，只有真实 pixiv 源能给出这一档）。档位是阈值：mild 也放行 safe，
//   r18 放行 safe+mild。
// - 词表可配：`socialV2.image.ratingWords`（控制台「图片 / 表情来源（含搜图分级）」里改）
//   · mild       —— 算擦边、safe 档滤掉的词（可增删）
//   · tolerated  —— 明确划为全年龄的词，优先于 mild（可增删）
//   · explicitExtra —— 限制级词（可增删）
// - 判定依据是图源给的标签/标题（bobopic 的 alt 文本），属于启发式：
//   宁可多滤（safe 档会误杀一些正常图），也不放过；没有标签的来源只能按来源兜底。
//   2026-09 按实际误杀情况放宽过一次：把一批构图/场景/玩梗标签移到 TOLERATED_TAGS（见下），
//   它们不再算擦边。
//
// 术语：itemRating = 这张图被判定的档位（'safe' | 'mild' | 'r18' | 'explicit'）；
//       configured = 管理员在 config.json 里设的档位（'safe' | 'mild' | 'r18'）。
// 'r18' 只由**真实 pixiv 源**给出（xRestrict=1），bobopic 那条链路给不出来。

/** 可配置的档位（值越大越宽松）。explicit 不在其中，它永远被拒。 */
export const IMAGE_RATINGS = Object.freeze(['safe', 'mild', 'r18']);
export const DEFAULT_IMAGE_RATING = 'safe';

/** 各档位的宽松度排序（判「这张图能不能过」用）。 */
const RATING_RANK = Object.freeze({ safe: 0, mild: 1, r18: 2 });

/** 归一化管理员配置：只认 'mild' / 'r18'，其他一律退回 'safe'（配置写错时收紧而不是放宽）。 */
export function normalizeImageRating(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === 'mild' || v === 'r18' ? v : DEFAULT_IMAGE_RATING;
}

/**
 * 内置的标签级限制级词表。**当前是有意为空的**（2026-09 策略）：标签级 explicit 拦截
 * 完全由管理员的 `ratingWords.explicitExtra` 决定，写进 tolerated/mild 也删不掉它。
 */
export const EXPLICIT_TAGS = Object.freeze([]);

/**
 * 「曾经算擦边、现在划到 safe」的标签白名单（默认值，可在控制台改）。
 * 这些词在 pixiv 上是**构图 / 场景 / 玩梗**标签（「寝」「お風呂」「俯视」），
 * 整标签命中就判擦边会大面积误杀正经插画。
 * 注意：限制级（EXPLICIT_TAGS）不在此列。
 */
export const DEFAULT_TOLERATED_TAGS = Object.freeze([
  '水泳', 'お風呂', '風呂', '寝', '趴', '俯视', 'lsp', '福利', '素足', '裸足', '紧身', 'むね'
]);

/** 轻度擦边标签的默认值：safe 档剔除，mild 档放行。 */
export const DEFAULT_MILD_TAGS = Object.freeze([
  '巨乳', '爆乳', '美乳', '微乳', '貧乳', '水着', '競泳水着', 'ビキニ', '泳装', '比基尼',
  '下着', 'ランジェリー', 'ブラジャー', 'パンツ', 'ぱんつ', '内衣', '黑丝', '白丝', 'ストッキング',
  'ニーソ', 'ニーソックス', '大腿', '太もも', 'ふともも', '腿', 'お尻', '尻', '谷間', '胸',
  'セクシー', '性感', '魅惑', '魅魔', 'サキュバス', '誘惑', '見せパン', '絶対領域', '露背',
  'チラリ', 'チラ見せ',
  '黑丝袜', '白丝袜', '网袜', '丝袜', '乳', '乳摇', '抖胸'
]);

/** 旧名字，保持向后兼容（测试与文档里引用的是这两个）。 */
export const MILD_TAGS = DEFAULT_MILD_TAGS;
export const TOLERATED_TAGS = DEFAULT_TOLERATED_TAGS;

/** 词表上限：防止有人把整本字典塞进 config.json。 */
export const RATING_WORD_LIMIT = 300;
export const RATING_WORD_MAX_LEN = 40;

/** 去空、trim、小写、去重、限长限量。 */
export function normalizeWordList(list, { limit = RATING_WORD_LIMIT, maxLen = RATING_WORD_MAX_LEN } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const word = String(raw ?? '').trim().toLowerCase().slice(0, maxLen);
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 把 `config.socialV2.image.ratingWords` 归一化成运行时词表。
 * 语义：**没配（非数组）用默认值；配了就用你配的（显式空数组 = 这个词表为空）**。
 */
export function normalizeRatingWords(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pick = (key, fallback) => (Array.isArray(src[key]) ? normalizeWordList(src[key]) : [...fallback]);
  return {
    mild: pick('mild', DEFAULT_MILD_TAGS),
    tolerated: pick('tolerated', DEFAULT_TOLERATED_TAGS),
    explicitExtra: pick('explicitExtra', [])
  };
}

/** 默认词表（未配置时使用）。 */
export const DEFAULT_RATING_WORDS = Object.freeze(normalizeRatingWords(null));

/**
 * 标题里的明确色情特征。**2026-09-24 起有意为空字符串**：不做标题兜底，
 * explicit 只认 `explicitExtra`（标签级）。用 `''` 而不是空正则——`new RegExp('')` 会匹配一切。
 * 想恢复标题兜底，把下面这行换成历史正则即可：
 *   /(r-?18|18禁|成人向|エロ|えっち|エッチ|全裸|ヌード|性行為|セックス|中出|おっぱい|裸|露出|痴女)/i
 */
export const EXPLICIT_TITLE_RE = '';

/** 把标签串（逗号分隔）切成小写 token 数组。 */
export function splitTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(/[,，、|]/);
  return list.map((t) => String(t ?? '').trim().toLowerCase()).filter(Boolean);
}

/**
 * 判定单张图的档位。
 * @param {{tags?:string[],title?:string,source?:string}} item
 * @param {{mild?:string[],tolerated?:string[],explicitExtra?:string[]}} [words] 运行时可配词表（缺省用默认）
 * @returns {{rating:'safe'|'mild'|'explicit', reason:string}}
 */
export function classifyImageItem({ tags = [], title = '', source = 'tag' } = {}, words) {
  const lists = words ?? DEFAULT_RATING_WORDS;
  const tokens = splitTags(tags);
  // 限制级 = 内置词表（当前为空）∪ 管理员补充词；tolerated / mild 都删不掉它们。
  const explicitSet = new Set([...EXPLICIT_TAGS.map((t) => t.toLowerCase()), ...(lists.explicitExtra ?? [])]);
  const toleratedSet = new Set(lists.tolerated ?? []);
  const mildSet = new Set(lists.mild ?? []);
  const hit = tokens.find((t) => explicitSet.has(t));
  if (hit) return { rating: 'explicit', reason: `标签命中限制级：${hit}` };
  if (EXPLICIT_TITLE_RE && EXPLICIT_TITLE_RE.test(String(title))) return { rating: 'explicit', reason: '标题命中限制级特征' };
  // tolerated 优先于 mild：两个词表写重了也不会因为写歪而放行/收紧。
  const mildHit = tokens.find((t) => mildSet.has(t) && !toleratedSet.has(t));
  if (mildHit) return { rating: 'mild', reason: `标签命中擦边：${mildHit}` };
  // 没标签的来源（如综合日榜只有标题）：按来源兜底为全年龄。
  // 日榜是 pixiv 的「综合」榜，限制级作品在单独的榜里，所以这里当成 safe 是保守的近似。
  return { rating: 'safe', reason: source === 'daily' ? '无标签，按榜单来源视为全年龄' : '未命中任何敏感标签' };
}

/**
 * 标签级限制级是**硬底线**：只要标签命中 explicitExtra（或内置表），这张图直接判 explicit、
 * 任何档位都不返回。
 *
 * 为什么需要单独一个函数：图源自己给的 rating（真实 pixiv 的 `xRestrict=1` → 'r18'）在
 * `filterByRating` 里会**短路掉词表判定**。结果是「管理员加了限制级词」对真实 pixiv 结果完全
 * 不生效——实测 `ナヒーダ` 的 R-18 结果里 `ロリ` 系作品照样能发出去。这里把词表判定提到
 * 「信源自带 rating」之前，保证底线不依赖图源自觉打标。
 *
 * @returns {{rating:'explicit',reason:string}|null} 命中返回 explicit，未命中返回 null
 */
export function explicitTagVerdict(item, words) {
  const lists = words ?? DEFAULT_RATING_WORDS;
  const explicitSet = new Set([...EXPLICIT_TAGS.map((t) => t.toLowerCase()), ...(lists.explicitExtra ?? [])]);
  const hit = splitTags(item?.tags).find((t) => explicitSet.has(t));
  return hit ? { rating: 'explicit', reason: `标签命中限制级：${hit}` } : null;
}

/** 这张图在指定档位下能不能返回（档位是阈值：safe ⊂ mild ⊂ r18）。 */
export function imageRatingAllowed(itemRating, configured) {
  if (itemRating === 'explicit') return false; // 任何档位都不放行
  const level = RATING_RANK[normalizeImageRating(configured)] ?? 0;
  const item = RATING_RANK[itemRating] ?? 0; // 未知/缺省按 safe 处理
  return item <= level;
}

/** 批量过滤，并给出统计（便于日志/回执里说明"滤掉了什么"）。 */
export function filterByRating(items, configured, words) {
  const list = Array.isArray(items) ? items : [];
  const kept = [];
  const dropped = { explicit: 0, byRating: 0 };
  for (const item of list) {
    // 标签级底线优先于「图源自带的 rating」：xRestrict=1 只说明是 R-18，
    // 不代表它没踩 explicitExtra（ロリ 之类）。这一步保证词表对真实 pixiv 也生效。
    const verdict = explicitTagVerdict(item, words)
      ?? (item?.rating
        ? { rating: item.rating, reason: item.ratingReason || '' }
        : classifyImageItem(item, words));
    const enriched = { ...item, rating: verdict.rating, ratingReason: verdict.reason };
    if (verdict.rating === 'explicit') { dropped.explicit += 1; continue; }
    if (!imageRatingAllowed(verdict.rating, configured)) { dropped.byRating += 1; continue; }
    kept.push(enriched);
  }
  return { items: kept, total: list.length, dropped, rating: normalizeImageRating(configured) };
}
