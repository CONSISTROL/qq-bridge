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
import { parseBobopicImages, searchPixivByTag, pixivDailyRanking, artworkIdFromInput, decodeEntities, pixivProxyIdFromUrl, pixivThumbUrl, searchPixivWeb, pixivIllustOriginal, isPixivHost, normalizePixivCookie, pixivArtworkIdFromAnyUrl } from '../src/pixiv-search.js';
import { parseProxy } from '../src/safe-fetch.js';
import { classifyImageItem, filterByRating, normalizeImageRating, imageRatingAllowed, explicitTagVerdict, MILD_TAGS, TOLERATED_TAGS, normalizeRatingWords, normalizeWordList, DEFAULT_RATING_WORDS, RATING_WORD_LIMIT, EXPLICIT_TAGS, EXPLICIT_TITLE_RE } from '../src/image-rating.js';

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
// bobopic 2026-09 换过标签页模板：尺寸从「| 2K分辨率 WxH」变成「|尺寸WxH」。
// 之前只认旧写法，导致「永雏塔菲」这种整页新模板的标签只解析出 1 条（旧模板的那条）。
const NEW_TAG_HTML = `
<img src="https://img.pixivdaily.com/small/115570927.jpg-220" alt="永雏塔菲,大腿,脚底,脚指图片|尺寸1863x2795">
<img src="https://img.pixivdaily.com/small/108940727.jpg-220" alt="永雏塔菲,舞台,可爱,虚拟主播图片|尺寸2480x3508">
<img src="https://img.pixivdaily.com/small/99107618.jpg-220" alt="永雏塔菲,黑丝袜,黑丝,女孩图片|尺寸2480x3508">
<img src="https://img.pixivdaily.com/small/96972053.jpg-220" alt="个人势虚拟偶像永雏塔菲插画壁纸图片">
<img src="https://img.pixivdaily.com/small/149947935.jpg-150150" alt="[pixiv]2026-09-22第1617期，27张1K等共108张图片">
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
const newItems = parseBobopicImages(NEW_TAG_HTML, { source: 'tag' });
ok(newItems.length === 3, '新模板 alt（图片|尺寸WxH）能解析（跳过无尺寸的壁纸条目与文章缩略图）', `实际 ${newItems.length}`);
const taffy = newItems.find((i) => i.id === '115570927');
ok(taffy?.tags.join(',') === '永雏塔菲,大腿,脚底,脚指' && taffy.width === 1863 && taffy.height === 2795 && taffy.title === '',
  '新模板的标签/尺寸解析正确', JSON.stringify(taffy));
ok(filterByRating(newItems, 'mild').items.length === 3 && filterByRating(newItems, 'safe').items.length === 1,
  '新模板解析出的图仍走年龄分级（mild 放行 大腿/黑丝 两张，safe 只留 1 张全年龄）', JSON.stringify(filterByRating(newItems, 'safe').dropped));
ok(decodeEntities('a&#x27;b&#39;c&amp;d&lt;e&gt;') === "a'b'c&d<e>", 'decodeEntities 覆盖十六/十进制实体');

console.log('## 年龄分级');
ok(normalizeImageRating('mild') === 'mild', "'mild' 原样保留");
ok(normalizeImageRating('r18') === 'r18' && normalizeImageRating('R18') === 'r18', "'r18' 大小写都认（第三档）");
ok(normalizeImageRating('explicit') === 'safe' && normalizeImageRating(undefined) === 'safe' && normalizeImageRating('nonsense') === 'safe',
  '未知/越界值一律收紧为 safe');
// 档位是阈值：safe ⊂ mild ⊂ r18；explicit 永远不放行。
ok(imageRatingAllowed('safe', 'safe') && !imageRatingAllowed('mild', 'safe') && !imageRatingAllowed('r18', 'safe'), 'safe 档只放全年龄');
ok(imageRatingAllowed('safe', 'mild') && imageRatingAllowed('mild', 'mild') && !imageRatingAllowed('r18', 'mild'), 'mild 档放全年龄+擦边，仍拦 R-18');
ok(imageRatingAllowed('safe', 'r18') && imageRatingAllowed('mild', 'r18') && imageRatingAllowed('r18', 'r18'), 'r18 档三档都放行');
ok(!imageRatingAllowed('explicit', 'r18') && !imageRatingAllowed('explicit', 'mild'), 'explicit 任何档位都不放行');
ok(imageRatingAllowed('未知档位', 'safe'), '来源给了未知档位时按 safe 处理（收紧）');
ok(classifyImageItem({ tags: ['初音未来'] }).rating === 'safe', '普通标签判为 safe');
ok(classifyImageItem({ tags: ['大腿'] }).rating === 'mild', '擦边标签判为 mild');
ok(EXPLICIT_TAGS.length === 0, '内置标签级限制级词表为空（有意：标签级拦截走可配的 explicitExtra）');
ok(EXPLICIT_TITLE_RE === '', '内置标题兜底为空（有意：explicit 只认 explicitExtra）');
ok(classifyImageItem({ tags: ['R-18', '全裸'] }).rating !== 'explicit', '不配 explicitExtra 时，标签本身不判 explicit');
ok(classifyImageItem({ tags: ['R-18'] }, normalizeRatingWords({ explicitExtra: ['r-18'] })).rating === 'explicit', '管理员配了 explicitExtra 后标签级限制级拦截生效');
ok(classifyImageItem({ tags: ['大腿'], title: 'えっちな絵' }).rating === 'mild', '标题兜底清空后，露骨标题不再自动判 explicit（按标签判 mild）');
ok(classifyImageItem({ tags: ['大腿'], title: 'えっちな絵' }, normalizeRatingWords({ explicitExtra: ['えっち'] })).rating !== 'explicit',
  '标题不参与 explicitExtra 匹配（只按标签），想拦标题得换个词表机制');
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
ok(classifyImageItem({ tags: ['r-18'] }, normalizeRatingWords({ tolerated: ['r-18'], mild: ['r-18'], explicitExtra: ['r-18'] })).rating === 'explicit',
  'explicitExtra 删不掉：写进 tolerated/mild 也照样判 explicit');
ok(classifyImageItem({ tags: ['r-18'] }, normalizeRatingWords({ tolerated: ['r-18'], mild: ['r-18'] })).rating === 'safe',
  '内置表为空时，只写 tolerated/mild 不会凭空产生 explicit');
ok(classifyImageItem({ tags: ['初音未来'] }, normalizeRatingWords({ tolerated: ['初音未来'] })).rating === 'safe',
  'tolerated 只影响擦边判定，不会把普通词变成 explicit');
ok(filterByRating([{ id: 'a', tags: ['大腿'] }, { id: 'b', tags: ['水着'] }], 'safe', normalizeRatingWords({ mild: [] })).items.length === 2,
  '显式空 mild = 不按词过滤擦边（explicitExtra 仍然拦）');
const customSearched = await searchPixivByTag('初音未来', { limit: 5, rating: 'safe', words: normalizeRatingWords({ mild: ['初音未来'] }), fetchImpl: async () => ({ statusCode: 200, body: TAG_HTML }) });
ok(customSearched.dropped.byRating === 1 && customSearched.items.length === 4,
  '搜图链路把 words 传进了过滤（把「初音未来」设为擦边词 → 带该标签的那张被滤，其余照常返回）',
  JSON.stringify({ dropped: customSearched.dropped, kept: customSearched.items.length }));

console.log('## 过滤统计');
const safeFiltered = filterByRating(tagItems, 'safe');
ok(safeFiltered.items.length === 4 && safeFiltered.dropped.byRating === 1 && safeFiltered.dropped.explicit === 0,
  'safe 档：只滤掉 1 张擦边（标题兜底已清空，R-18 标题那张不再算 explicit）', JSON.stringify({ kept: safeFiltered.items.length, ...safeFiltered.dropped }));
const mildFiltered = filterByRating(tagItems, 'mild');
ok(mildFiltered.items.length === 5 && mildFiltered.dropped.explicit === 0 && mildFiltered.dropped.byRating === 0,
  'mild 档：全放行（没有 explicitExtra 时 explicit 为 0）', JSON.stringify({ kept: mildFiltered.items.length, ...mildFiltered.dropped }));
ok(safeFiltered.items.every((i) => i.rating && i.ratingReason), '过滤结果带 rating/ratingReason 供回执说明');

console.log('## 输入形态');
ok(artworkIdFromInput('149946957') === '149946957', '纯数字作品 id');
ok(artworkIdFromInput('https://www.pixiv.net/artworks/149946957') === '149946957', 'pixiv 作品页链接');
ok(artworkIdFromInput('https://pixiv.re/149946957.png') === '149946957', 'pixiv.re 直链');
ok(artworkIdFromInput('初音未来') === '', '普通关键词不误判成 id');

console.log('## 原图回退链的地址解析');
ok(pixivProxyIdFromUrl('https://pixiv.re/91401787.png') === '91401787', 'pixiv.re 直链取 id');
ok(pixivProxyIdFromUrl('https://i.pixiv.re/91401787.png') === '91401787', 'i.pixiv.re 也认');
ok(pixivProxyIdFromUrl('https://pixiv.re/91401787.png?x=1') === '91401787', '带 query 也认');
ok(pixivProxyIdFromUrl('https://pixiv.re/91401787') === '91401787', '不带扩展名也认');
ok(pixivProxyIdFromUrl('https://img.pixivdaily.com/small/91401787.jpg') === '', '别的图床不触发回退链');
ok(pixivProxyIdFromUrl('https://www.pixiv.net/artworks/91401787') === '', 'pixiv 作品页不是直链，不触发');
ok(pixivProxyIdFromUrl('91401787') === '', '裸数字不触发（那是 query 的用法）');
ok(pixivProxyIdFromUrl('https://evil.com/pixiv.re/91401787.png') === '', '不是 pixiv.re 域不认');
ok(pixivThumbUrl('91401787') === 'https://img.pixivdaily.com/small/91401787.jpg', '缩略图兜底地址拼得对');

console.log('## 防重发用的「作品身份」识别');
ok(pixivArtworkIdFromAnyUrl('https://pixiv.re/91401787.png') === '91401787', 'pixiv.re 代理');
ok(pixivArtworkIdFromAnyUrl('https://i.pximg.net/img-original/img/2026/09/17/12/51/18/149763736_p0.png') === '149763736', 'i.pximg 原图（带日期路径与 _p0）');
ok(pixivArtworkIdFromAnyUrl('https://i.pximg.net/c/250x250_80_a2/img-master/img/a/149763736_p0_square1200.jpg') === '149763736', 'i.pximg 方形缩略图');
ok(pixivArtworkIdFromAnyUrl('https://img.pixivdaily.com/small/115570927.jpg-220') === '115570927', 'pixivdaily 缩略图（带 -220 尺寸后缀）');
ok(pixivArtworkIdFromAnyUrl('https://www.pixiv.net/artworks/91401787') === '91401787', '作品页链接');
ok(pixivArtworkIdFromAnyUrl('https://i0.hdslb.com/bfs/new_dyn/x.jpg') === '', 'B 站图不误判成 pixiv 作品');
ok(pixivArtworkIdFromAnyUrl('') === '', '空值安全');

console.log('## 搜索编排（注入 fetch，不联网）');
const fakeFetch = (html, status = 200) => async () => ({ statusCode: status, body: html, url: 'https://bobopic.com/tag/x/', truncated: false });
const searched = await searchPixivByTag('初音未来', { limit: 2, rating: 'safe', fetchImpl: fakeFetch(TAG_HTML) });
ok(searched.mode === 'tag' && searched.pageUrl.includes('/tag/'), '标签搜索带 mode/pageUrl');
ok(searched.items.length === 2 && searched.total === 5, 'limit 生效且 total 反映解析总数', JSON.stringify({ got: searched.items.length, total: searched.total }));
ok(searched.keptCount === 4, 'keptCount 是分级过滤后的总数、不受 limit 影响', String(searched.keptCount));
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

console.log('## 真实 pixiv（注入 fetch，不联网）');
const PIXIV_FIXTURE = JSON.stringify({
  error: false,
  body: {
    illustManga: {
      total: 322,
      data: [
        { id: '149763736', title: '塔菲的日常随拍喵', xRestrict: 0, tags: ['永雏塔菲', '可爱'], url: 'https://i.pximg.net/c/250x250_80_a2/img-master/img/a_p0_square1200.jpg', userId: '1', userName: '和依', width: 941, height: 1672, pageCount: 1 },
        { id: '111887747', title: 'xRestrict=1 的作品', xRestrict: 1, tags: ['永雏塔菲'], url: 'https://i.pximg.net/c/250x250_80_a2/img-master/img/b_p0_square1200.jpg', width: 829, height: 1200, pageCount: 1 },
        { id: '222222222', title: 'xRestrict=2 的作品', xRestrict: 2, tags: ['永雏塔菲'], url: 'https://i.pximg.net/c/250x250_80_a2/img-master/img/c_p0_square1200.jpg', width: 800, height: 800, pageCount: 1 }
      ]
    }
  }
});
const webCalls = [];
const webFetch = (body) => async (url, max, opts) => { webCalls.push({ url: String(url), opts }); return { statusCode: 200, body, url: String(url) }; };
const webSafe = await searchPixivWeb('永雏塔菲', { mode: 'all', limit: 8, rating: 'safe', cookie: 'PHPSESSID=fixture', proxy: 'http://127.0.0.1:7897', fetchImpl: webFetch(PIXIV_FIXTURE) });
ok(webSafe.mode === 'web' && webSafe.total === 322 && webSafe.pixivMode === 'all', 'web 搜索带回 mode/total/pixivMode', JSON.stringify({ total: webSafe.total, kept: webSafe.keptCount }));
ok(webSafe.items.length === 1 && webSafe.items[0].id === '149763736', 'safe 档只留 xRestrict=0（R-18/R-18G 全滤）', `kept=${webSafe.items.length}`);
ok(webSafe.dropped.byRating === 1 && webSafe.dropped.explicit === 1, 'xRestrict=1 记 byRating、=2 记 explicit', JSON.stringify(webSafe.dropped));
const webR18 = await searchPixivWeb('永雏塔菲', { mode: 'r18', limit: 8, rating: 'r18', fetchImpl: webFetch(PIXIV_FIXTURE) });
ok(webR18.pixivMode === 'r18' && webR18.items.length === 2 && webR18.items[1].rating === 'r18',
  'r18 档：xRestrict=1 放行、=2 仍拦', JSON.stringify(webR18.items.map((i) => [i.id, i.rating])));
ok(webR18.items.every((i) => i.provider === 'pixiv' && i.source === 'web' && i.url === '' && i.thumbUrl.startsWith('https://i.pximg.net/')),
  'web 条目只带缩略图，原图 url 留给 attachPixivOriginals 兜（桥接会补）');
const firstCall = webCalls[0];
ok(firstCall.opts.proxy === 'http://127.0.0.1:7897' && firstCall.opts.headers.cookie === 'PHPSESSID=fixture' && firstCall.opts.headers.referer === 'https://www.pixiv.net/',
  '搜索请求带上了代理 / cookie / pixiv Referer');
ok(/\/ajax\/search\/artworks\//.test(firstCall.url) && /mode=all/.test(firstCall.url), '打的是 pixiv 官方 ajax 搜索接口', firstCall.url.slice(0, 80));
const detail = await pixivIllustOriginal('91401787', { proxy: 'p', cookie: 'c', fetchImpl: async () => ({ statusCode: 200, body: JSON.stringify({ error: false, body: { illustId: '91401787', xRestrict: 0, urls: { original: 'https://i.pximg.net/img-original/img/2021/07/21/22/53/00/91401787_p0.png', regular: 'https://i.pximg.net/img-master/x_p0_master1200.jpg' }, tags: { tags: [{ tag: '永雏塔菲' }] } } }) }) });
ok(detail.original.endsWith('_p0.png') && detail.tags.join(',') === '永雏塔菲' && detail.xRestrict === 0, '作品详情解析出原图地址/标签/xRestrict');
let detailThrew = '';
try { await pixivIllustOriginal('abc', {}); } catch (error) { detailThrew = String(error.message); }
ok(/id 不合法/.test(detailThrew), '非法 id 直接报错，不发请求', detailThrew);
ok(isPixivHost('i.pximg.net') && isPixivHost('www.pixiv.net') && isPixivHost('pixiv.re') && isPixivHost('i.pixiv.re'), 'pixiv 系域名识别');
ok(!isPixivHost('img.pixivdaily.com') && !isPixivHost('evilpximg.net') && !isPixivHost(''), '非 pixiv 域名不误判（不会白走代理）');

console.log('## pixiv cookie 归一化');
ok(normalizePixivCookie('26362806_abc') === 'PHPSESSID=26362806_abc', '只填值 → 自动补 PHPSESSID=（实测最容易踩的坑）');
ok(normalizePixivCookie('PHPSESSID=26362806_abc') === 'PHPSESSID=26362806_abc', '已经是 name=value → 原样保留');
ok(normalizePixivCookie('Cookie: PHPSESSID=x; devide_token=y') === 'PHPSESSID=x; devide_token=y', '整行 Cookie: 前缀被剥掉，其余照留');
ok(normalizePixivCookie('') === '' && normalizePixivCookie(undefined) === '', '空值就是不带 cookie');
ok(!normalizePixivCookie('a=b\r\nInjected: 1').includes('\n'), '换行被压掉（防 header 注入）');

console.log('## 代理配置解析');
ok(parseProxy('') === null && parseProxy(undefined) === null, '空配置 = 直连');
const parsedProxy = parseProxy('http://127.0.0.1:7897');
ok(parsedProxy?.host === '127.0.0.1' && parsedProxy?.port === 7897, 'http 代理地址解析出 host/port');
let proxyThrew = '';
try { parseProxy('socks5://127.0.0.1:7897'); } catch (error) { proxyThrew = String(error.message); }
ok(/只支持 http:\/\/ 代理/.test(proxyThrew), 'socks 明确拒绝而不是悄悄降级', proxyThrew);

console.log('## 接线存在性');
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
const consoleView = fs.readFileSync(path.join(ROOT, 'public', 'console', 'views', 'social2.js'), 'utf8');
ok(/searchPixivByTag/.test(bridge) && /pixivDailyRanking/.test(bridge), 'bridge 引用了 pixiv 搜索模块');
ok(/pixivProxyIdFromUrl/.test(bridge) && /pixivThumbUrl/.test(bridge), 'bridge 用 pixiv 直链解析 + 缩略图兜底');
ok(/fetchBobopicPixivOriginal/.test(bridge), 'bridge 有 bobopic 原图通道');
ok(/timeoutMs: 45000/.test(bridge), 'pixiv.re 原图尝试放宽到 45s（默认 20s 拉不完）');
const safeFetchSrc = fs.readFileSync(path.join(ROOT, 'src', 'safe-fetch.js'), 'utf8');
ok(/function requestTimeout\(options\)/.test(safeFetchSrc) && /options\?\.timeoutMs/.test(safeFetchSrc), 'safe-fetch 支持按调用传 timeoutMs');
// 真实 pixiv 源 + 代理
ok(/searchPixivWeb/.test(bridge) && /pixivIllustOriginal/.test(bridge), 'bridge 接了真实 pixiv 源');
ok(/attachPixivOriginals/.test(bridge), 'web 搜索结果会补原图直链（i.pximg 路径带日期，拼不出来）');
ok(/pixivCfg\.enabled && pixivCfg\.proxy/.test(bridge), '只有配了代理才走真实 pixiv，否则退回 bobopic');
ok(/isPixivHost/.test(bridge) && /proxy: pixivProxy/.test(bridge), 'pixiv 抓图带 pixiv Referer + 代理');
ok(/'https:\/\/i\.pximg\.net'/.test(bridge), '默认白名单含 i.pximg.net');
ok(/pixiv: \{\s*enabled: false/.test(bridge), 'image.pixiv 有默认配置（默认关）');
ok(/parseProxy\(options\.proxy\)/.test(safeFetchSrc), 'safe-fetch 会解析 options.proxy');
ok(/ALLOWED_IMAGE_HEADERS = new Set\(\['referer', 'user-agent', 'cookie'\]\)/.test(safeFetchSrc), 'safe-fetch 放行 cookie（仅第一跳）');
const imageAllowSrc = fs.readFileSync(path.join(ROOT, 'src', 'image-allow.js'), 'utf8');
ok(/'https:\/\/i\.pximg\.net'/.test(imageAllowSrc), 'DEFAULT_REFERER_ALLOW 含 i.pximg.net');
ok(/value: 'r18'/.test(consoleView) && /pixiv\.proxy/.test(consoleView) && /pixiv\.cookie/.test(consoleView), '控制台有 r18 档 + pixiv 代理/cookie 字段');
ok(/r18=允许 R-18/.test(mcp), 'MCP 工具描述写明了 r18 档');
ok(/pixivCfg\.cookie \? '\+登录' : ''/.test(bridge), '回执里会写明是否带登录');
// 防重发 + pixiv 白名单兜底
ok(/function imageIdentityKey\(source, name = ''\)/.test(bridge) && /function recentSentImageKeys\(key, windowMs/.test(bridge), 'bridge 有防重发的身份/集合助手');
ok(/recentSentImageKeys\(key, repeatWindow\).has\(identity\)/.test(bridge), 'qq_send_image 会拒绝最近发过的图');
ok(/items = items\.filter\(\(it\) => !sent\.has\(imageIdentityKey/.test(bridge), '搜图结果会滤掉最近发过的图');
ok(/repeatGuardMs: 6 \* 60 \* 60 \* 1000/.test(bridge), 'repeatGuardMs 默认 6 小时（0=关闭）');
ok(/pixivTrusted/.test(bridge) && /!pixivTrusted/.test(bridge), 'pixiv 源开着时 i.pximg 直链不受过期 refererAllow 影响');
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
