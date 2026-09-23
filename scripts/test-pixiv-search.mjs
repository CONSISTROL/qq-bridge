// pixiv 搜图 + 图片年龄分级 的离线测试（不出网：页面用内联夹具，抓取用注入的假 fetch）。
//
// 覆盖：
// - bobopic 标签页/日榜页的 HTML 解析（含相关文章缩略图的跳过、HTML 实体、去重）
// - 年龄分级判定与过滤（safe / mild / explicit，以及"explicit 任何档位都不放行"）
// - artworkIdFromInput 的几种输入形态
// - searchPixivByTag / pixivDailyRanking 的编排（注入 fetch，不联网）
// - 桥接/MCP/控制台的接线存在性（防止有人把功能摘掉一半）
//
// 用法：node scripts/test-pixiv-search.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBobopicImages, searchPixivByTag, pixivDailyRanking, artworkIdFromInput, decodeEntities } from '../src/pixiv-search.js';
import { classifyImageItem, filterByRating, normalizeImageRating, imageRatingAllowed, MILD_TAGS, TOLERATED_TAGS, normalizeRatingWords, normalizeWordList, DEFAULT_RATING_WORDS, RATING_WORD_LIMIT, EXPLICIT_TAGS } from '../src/image-rating.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function ok(cond, label, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); } else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const TAG_HTML = `
<header style="background-image: url('https://img.pixivdaily.com/small/149947935.jpg');"></header>
<img src="https://img.pixivdaily.com/small/149946957.jpg-220" alt="初音未来图片 - メイドさん | 高清分辨率 960x1280">
<img src="https://img.pixivdaily.com/small/149944415.jpg-220" alt="原神图片 - ヴェスナ | 1K分辨率 1536x2048">
<img src="https://img.pixivdaily.com/small/149954471.jpg-220" alt="枫丹,大腿,女孩,芙宁娜图片 | 2K分辨率 2676x3554">
<img src="https://img.pixivdaily.com/small/149900001.jpg-220" alt="原创图片 - R-18 全裸 | 2K分辨率 2000x3000">
<img src="https://img.pixivdaily.com/small/149900002.jpg-220" alt="某图图片 - 标题 &#039;quoted&#039; &amp; more | 4K分辨率 4000x4000">
<img src="https://img.pixivdaily.com/small/149947935.jpg-150150" alt="[pixiv]2026-09-22第1617期，27张1K等共108张图片">
<img src="https://img.pixivdaily.com/small/149954471.jpg-999" alt="枫丹,大腿,女孩,芙宁娜图片 | 2K分辨率 2676x3554">
<img src="https://moxian.bobopic.com/static/img/mmore.svg" alt="翻阅更多">
`;
const DAILY_HTML = `
<img src="https://img.pixivdaily.com/small/149951572.jpg-150150" alt="今と昔_PID:149951572">
<img src="https://img.pixivdaily.com/small/149957488.jpg-150150" alt="美味しい？_PID:149957488">
`;

console.log('## 解析 bobopic 页面');
const tagItems = parseBobopicImages(TAG_HTML, { source: 'tag' });
ok(tagItems.length === 5, '标签页解析出 5 条（跳过文章缩略图/非 pixivdaily 图/重复 id）', `实际 ${tagItems.length}`);
const miku = tagItems.find((i) => i.id === '149946957');
ok(miku?.tags.join(',') === '初音未来' && miku.title === 'メイドさん' && miku.width === 960 && miku.height === 1280,
  '标签/标题/尺寸解析正确', JSON.stringify(miku));
ok(miku?.url === 'https://pixiv.re/149946957.png', 'pixiv.re 直链按 id 拼出', miku?.url);
ok(miku?.thumbUrl.startsWith('https://img.pixivdaily.com/small/149946957.jpg'), '保留缩略图直链作为兜底', miku?.thumbUrl);
ok(miku?.provider === 'pixiv' && miku?.source === 'tag', 'provider/source 标记正确');
const quoted = tagItems.find((i) => i.id === '149900002');
ok(quoted?.title === "标题 'quoted' & more", 'HTML 实体被解码', quoted?.title);
const dailyItems = parseBobopicImages(DAILY_HTML, { source: 'daily' });
ok(dailyItems.length === 2 && dailyItems[0].title === '今と昔' && dailyItems[0].tags.length === 0, '日榜页 alt（标题_PID）解析正确', JSON.stringify(dailyItems[0]));
ok(decodeEntities('a&#x27;b&#39;c&amp;d&lt;e&gt;') === "a'b'c&d<e>", 'decodeEntities 覆盖十六/十进制实体');

console.log('## 年龄分级');
ok(normalizeImageRating('mild') === 'mild', "'mild' 原样保留");
ok(normalizeImageRating('R18') === 'safe' && normalizeImageRating('explicit') === 'safe' && normalizeImageRating(undefined) === 'safe',
  '未知/越界值一律收紧为 safe（不存在 r18 档）');
ok(classifyImageItem({ tags: ['初音未来'] }).rating === 'safe', '普通标签判为 safe');
ok(classifyImageItem({ tags: ['大腿'] }).rating === 'mild', '擦边标签判为 mild');
ok(classifyImageItem({ tags: ['R-18', '全裸'] }).rating === 'explicit', '限制级标签判为 explicit');
ok(classifyImageItem({ tags: ['大腿'], title: 'えっちな絵' }).rating === 'explicit', '标题命中限制级时压过 mild 标签');
ok(classifyImageItem({ tags: [], title: '无题', source: 'daily' }).rating === 'safe', '无标签的日榜项按来源视为 safe');
ok(imageRatingAllowed('mild', 'safe') === false && imageRatingAllowed('mild', 'mild') === true, 'safe 档拒 mild，mild 档放行');
ok(imageRatingAllowed('explicit', 'safe') === false && imageRatingAllowed('explicit', 'mild') === false, 'explicit 在任何档位都不放行');

console.log('## 放宽：构图/场景标签回到 safe');
const mildSet = new Set(MILD_TAGS);
ok(TOLERATED_TAGS.every((t) => !mildSet.has(t)), 'TOLERATED_TAGS 不在擦边表里（不会两边都算）', TOLERATED_TAGS.filter((t) => mildSet.has(t)).join(','));
ok(TOLERATED_TAGS.every((t) => classifyImageItem({ tags: [t] }).rating === 'safe'), '这些标签现在判为 safe（safe 档也能返回）');
ok(TOLERATED_TAGS.some((t) => ['寝', 'お風呂', '裸足'].includes(t)), '确实包含当初误杀的典型标签（寝/お風呂/裸足）');
ok(classifyImageItem({ tags: ['大腿'] }).rating === 'mild' && classifyImageItem({ tags: ['水着'] }).rating === 'mild' && classifyImageItem({ tags: ['巨乳'] }).rating === 'mild',
  '真正的擦边标签（大腿/水着/巨乳）仍然判 mild');
ok(filterByRating(TOLERATED_TAGS.map((t, i) => ({ id: `t${i}`, tags: [t] })), 'safe').items.length === TOLERATED_TAGS.length,
  `safe 档不再滤掉这 ${TOLERATED_TAGS.length} 个标签`);

console.log('## 词表可配（socialV2.image.ratingWords）');
ok(DEFAULT_RATING_WORDS.mild.length === MILD_TAGS.length && DEFAULT_RATING_WORDS.tolerated.length === TOLERATED_TAGS.length,
  '默认词表 = 内置词表（配置没写时用默认）', JSON.stringify({ mild: DEFAULT_RATING_WORDS.mild.length, tolerated: DEFAULT_RATING_WORDS.tolerated.length }));
ok(normalizeRatingWords(undefined).mild.length === MILD_TAGS.length, '字段缺失 → 回退默认（不是空表）');
ok(normalizeWordList(['  大腿 ', '大腿', '', 'AB', 'x'.repeat(80)]).join('|') === `大腿|ab|${'x'.repeat(40)}`,
  '词表归一化：trim + 小写 + 去重 + 限长 40');
ok(normalizeWordList(Array.from({ length: 500 }, (_, i) => `w${i}`)).length === RATING_WORD_LIMIT, `词表限量 ${RATING_WORD_LIMIT}（防止塞整本字典）`);
const customWords = normalizeRatingWords({ mild: ['自己加的擦边词'], tolerated: ['大腿'], explicitExtra: ['群里黑话'] });
ok(classifyImageItem({ tags: ['自己加的擦边词'] }, customWords).rating === 'mild', '自定义擦边词生效');
ok(classifyImageItem({ tags: ['大腿'] }, customWords).rating === 'safe', 'tolerated 覆盖默认擦边词（配了就以配置为准）');
ok(classifyImageItem({ tags: ['水着'] }, customWords).rating === 'safe', '配了 mild 就以配置为准：没列进去的默认擦边词不再算擦边');
ok(classifyImageItem({ tags: ['群里黑话'] }, customWords).rating === 'explicit', 'explicitExtra 是叠加的额外拦截词');
ok(classifyImageItem({ tags: ['r-18'] }, normalizeRatingWords({ tolerated: ['r-18'], mild: ['r-18'] })).rating === 'explicit',
  '限制级词表删不掉：写进 tolerated/mild 也照样判 explicit');
ok(classifyImageItem({ tags: ['初音未来'] }, normalizeRatingWords({ tolerated: ['初音未来'] })).rating === 'safe',
  'tolerated 只影响擦边判定，不会把普通词变成 explicit');
ok(filterByRating([{ id: 'a', tags: ['大腿'] }, { id: 'b', tags: ['水着'] }], 'safe', normalizeRatingWords({ mild: [] })).items.length === 2,
  '显式空 mild = 不按词过滤擦边（限制级仍然拦）');
const customSearched = await searchPixivByTag('初音未来', { limit: 5, rating: 'safe', words: normalizeRatingWords({ mild: ['初音未来'] }), fetchImpl: async () => ({ statusCode: 200, body: TAG_HTML }) });
ok(customSearched.dropped.byRating === 1 && customSearched.items.length === 3,
  '搜图链路把 words 传进了过滤（把「初音未来」设为擦边词 → 带该标签的那张被滤，其余照常返回）',
  JSON.stringify({ dropped: customSearched.dropped, kept: customSearched.items.length }));

console.log('## 过滤统计');
const safeFiltered = filterByRating(tagItems, 'safe');
ok(safeFiltered.items.length === 3 && safeFiltered.dropped.byRating === 1 && safeFiltered.dropped.explicit === 1,
  'safe 档：滤掉 1 张擦边 + 1 张限制级', JSON.stringify({ kept: safeFiltered.items.length, ...safeFiltered.dropped }));
const mildFiltered = filterByRating(tagItems, 'mild');
ok(mildFiltered.items.length === 4 && mildFiltered.dropped.explicit === 1 && mildFiltered.dropped.byRating === 0,
  'mild 档：只滤限制级', JSON.stringify({ kept: mildFiltered.items.length, ...mildFiltered.dropped }));
ok(safeFiltered.items.every((i) => i.rating && i.ratingReason), '过滤结果带 rating/ratingReason 供回执说明');

console.log('## 输入形态');
ok(artworkIdFromInput('149946957') === '149946957', '纯数字作品 id');
ok(artworkIdFromInput('https://www.pixiv.net/artworks/149946957') === '149946957', 'pixiv 作品页链接');
ok(artworkIdFromInput('https://pixiv.re/149946957.png') === '149946957', 'pixiv.re 直链');
ok(artworkIdFromInput('初音未来') === '', '普通关键词不误判成 id');

console.log('## 搜索编排（注入 fetch，不联网）');
const fakeFetch = (html, status = 200) => async () => ({ statusCode: status, body: html, url: 'https://bobopic.com/tag/x/', truncated: false });
const searched = await searchPixivByTag('初音未来', { limit: 2, rating: 'safe', fetchImpl: fakeFetch(TAG_HTML) });
ok(searched.mode === 'tag' && searched.pageUrl.includes('/tag/'), '标签搜索带 mode/pageUrl');
ok(searched.items.length === 2 && searched.total === 5, 'limit 生效且 total 反映解析总数', JSON.stringify({ got: searched.items.length, total: searched.total }));
ok(searched.keptCount === 3, 'keptCount 是分级过滤后的总数、不受 limit 影响', String(searched.keptCount));
ok(searched.items.every((i) => i.provider === 'pixiv' && i.url.startsWith('https://pixiv.re/')), '返回项都是 pixiv.re 直链');
const byId = await searchPixivByTag('149946957', { fetchImpl: async () => { throw new Error('不该抓页面'); } });
ok(byId.mode === 'id' && byId.items.length === 1 && byId.items[0].url === 'https://pixiv.re/149946957.png', '给 id 时直接返回，不抓页面');
const daily = await pixivDailyRanking({ limit: 5, rating: 'mild', fetchImpl: fakeFetch(DAILY_HTML) });
ok(daily.mode === 'daily' && daily.items.length === 2 && daily.rating === 'mild', '日榜搜索可用且带上 rating');
ok(/^\d{4}-\d{2}-\d{2}$/.test(daily.date), '日榜带上是哪一天的（date）', daily.date);
let calls = 0;
const fallbackDaily = await pixivDailyRanking({ fetchImpl: async () => { calls += 1; return { statusCode: 200, body: calls === 1 ? '<html>空壳</html>' : DAILY_HTML }; } });
ok(calls === 2 && fallbackDaily.items.length === 2, '当天榜单是空壳时自动往前找（不会静默返回空）', `calls=${calls}`);
let dailyThrew = '';
try { await pixivDailyRanking({ fetchImpl: fakeFetch('<html>空</html>') }); } catch (error) { dailyThrew = String(error.message); }
ok(/没解析到作品/.test(dailyThrew) && /试过/.test(dailyThrew), '连续空页时报错并列出试过的日期', dailyThrew);
let threw = '';
try { await searchPixivByTag('不存在', { fetchImpl: fakeFetch('', 404) }); } catch (error) { threw = String(error.message); }
ok(/HTTP 404/.test(threw), '页面非 200 时报错清晰', threw);
let emptyThrew = '';
try { await searchPixivByTag('不存在', { fetchImpl: fakeFetch('<img src="https://moxian.bobopic.com/x.svg">') }); } catch (error) { emptyThrew = String(error.message); }
ok(/没找到标签/.test(emptyThrew), '解析不到作品时提示换关键词', emptyThrew);

console.log('## 接线存在性');
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
const consoleView = fs.readFileSync(path.join(ROOT, 'public', 'console', 'views', 'social2.js'), 'utf8');
ok(/searchPixivByTag/.test(bridge) && /pixivDailyRanking/.test(bridge), 'bridge 引用了 pixiv 搜索模块');
ok(/normalizeImageRating\(img\.rating\)/.test(bridge), 'resolveImageConfig 会归一化 rating');
ok(/'https:\/\/img\.pixivdaily\.com'/.test(bridge), '默认白名单含 img.pixivdaily.com');
ok(/merged\.image\.rating = normalizeImageRating/.test(bridge), '控制台写 rating 时会被校验');
ok(/source: source \?\? 'auto'/.test(mcp), 'qq_search_images 会把 source 传给桥接（默认 auto）');
ok(/source: source \?\? 'auto'/.test(mcp), 'qq_search_images 默认走 auto（先 pixiv 后 B 站）');
ok(/z\.enum\(\['auto', 'bilibili', 'pixiv', 'all'\]\)/.test(mcp), 'qq_search_images 暴露 auto/pixiv/bilibili/all 四种图源');
ok(/source === 'auto' && pixivKept < Math\.min\(3, count\)/.test(bridge), 'auto 在 pixiv 只捞到零星几张时会补 B 站');
ok(/已自动回退 B 站/.test(bridge) && /已补上 B 站结果/.test(bridge), '回退/补齐都会写进 notes（不静默换源）');
ok(/const seen = new Set\(items\.map/.test(bridge), 'auto 合并两边结果时按 url 去重');
ok(/if \(source !== 'auto'\) throw error;/.test(bridge), '显式 source=pixiv 失败时不偷偷回退（如实报错）');
ok(/path: 'rating'/.test(consoleView), '控制台有图片年龄分级字段');
ok(/path: 'rating'[\s\S]{0,200}type: 'select'/.test(consoleView), '年龄分级用 select 而不是自由文本');

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
