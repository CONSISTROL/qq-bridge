// 卡片消息解析自检（纯离线，不需要 QQ / 桥接在跑）。
//
// 回归背景：`segmentsToText` 原来把卡片硬编码成 `[卡片消息]`，AI 只能回
// 「你发的是张卡片，我这边读不到里面写了啥」。这里守住四件事：
//   1) 真实 QQ 卡片（json）能解析出标题/摘要/链接；
//   2) xml / share / 小程序 / 音乐等形态都能读；
//   3) 卡片内容是对可控文本：必须截断、压掉控制字符，不能顶爆 200 字的历史消息；
//   4) 解析失败要明说失败，不能假装读到了内容。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseJsonCard,
  parseXmlCard,
  parseShareCard,
  cardSegmentToText,
  formatCardSummary,
  cardSourceLabel,
  xmlCardSourceLabel,
  decodeXmlEntities,
  cleanCardText,
  cardPreviewUrl,
  extractCardFromSegments,
  normalizeCardForStore,
  CARD_SUMMARY_MAX,
  CARD_STORE_URL_MAX
} from '../src/card-parse.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

// 真实样本：2026-09-23 私聊里收到的小黑盒分享卡片（由 OneBot get_msg 原样取出）。
const REAL_CARD_JSON = `{"app":"com.tencent.tuwen.lua","bizsrc":"qqconnect.sdkshare","config":{"ctime":1790146995,"forward":1,"token":"ee40f60aab6e54ad948574cf1b5d9bb9","type":"normal"},"extra":{"app_type":1,"appid":1105910806,"msg_seq":7688622800398170823,"uin":10001},"meta":{"news":{"app_type":1,"appid":1105910806,"ctime":1790146995,"desc":"下载小黑盒查看更多精彩内容","jumpUrl":"https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_camp=link&h_session_id=UKyWyJ6FrOvbQsM9&h_src=YXBwX3NoYXJl&link_id=260c727ab720&new_post_share_style_v2=0","preview":"https://qq.ugcimg.cn/v1/ejrjt9tmsgau797pbp871orv1f9jbn3vcbkjqibirqevpj0v9mbrcs8l1c14h4p8c8rfdnnbi5elkhk4u4p6vcmqju7l8sklricd9nuohot48rmac0ogk4plucm5glm8/939ucqlhmb34eckft50lf03ct2ciocab5n7agtqfrh4ds6qtgkv0","tag":"小黑盒","tagIcon":"https://open.gtimg.cn/open/app_icon/05/91/08/06/1105910806_100_m.png?t=1789367028","title":"姿态975万余额曝光后背景被挖，蓝天幼儿园毕业，小时候上..…","uin":10001}},"prompt":"[分享]姿态975万余额曝光后背景被挖，蓝天幼儿园毕业，小时候上..…","ver":"0.0.0.1","view":"news"}`;

console.log('## 真实卡片（OneBot get_msg 取回的原样 payload）');
{
  const card = parseJsonCard(REAL_CARD_JSON);
  ok(Boolean(card), '能解析真实卡片');
  ok(card?.source === '小黑盒', `来源取到 tag：${card?.source}`, JSON.stringify(card));
  ok(String(card?.title || '').includes('姿态'), '标题解析正确', card?.title);
  ok(String(card?.url || '').startsWith('https://api.xiaoheihe.cn/'), '链接解析正确', card?.url);
  ok(String(card?.app || '') === 'com.tencent.tuwen.lua', 'app 字段保留', card?.app);
  ok(String(card?.preview || '').startsWith('https://'), '预览图 URL 被提取（当前不自动下载）', card?.preview);

  const text = cardSegmentToText({ type: 'json', data: { data: REAL_CARD_JSON } });
  ok(text.startsWith('[卡片·小黑盒]'), '渲染成 [卡片·来源] 开头', text);
  ok(text.includes('姿态'), '渲染里带标题', text);
  ok(text.includes('链接：https://'), '渲染里带链接', text);
  ok(text.length <= CARD_SUMMARY_MAX, `渲染长度受控（${text.length} <= ${CARD_SUMMARY_MAX}）`, text);
  ok(!text.includes('\n'), '渲染是单行（不会破坏消息流）');
}

console.log('## 各种卡片形态');
{
  const news = { type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.structmsg', view: 'news', meta: { news: { title: '某篇文章', desc: '摘要一句话', jumpUrl: 'https://example.com/a' } } }) } };
  ok(cardSegmentToText(news).includes('某篇文章') && cardSegmentToText(news).includes('摘要一句话'), 'structmsg/news 卡片', cardSegmentToText(news));

  const mini = { type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.miniapp_01', view: 'viewMultiMsg', meta: { detail_1: { title: '来玩小游戏', desc: '点击进入', qqdocurl: 'https://example.qq.com/x' } } }) } };
  const miniText = cardSegmentToText(mini);
  ok(miniText.includes('小程序') && miniText.includes('来玩小游戏') && miniText.includes('https://example.qq.com/x'), '小程序卡片（meta.detail_1 + qqdocurl）', miniText);

  const music = { type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.music.lua', meta: { music: { title: '某首歌', desc: '某歌手' } } }) } };
  ok(cardSegmentToText(music).includes('音乐') && cardSegmentToText(music).includes('某首歌'), '音乐卡片', cardSegmentToText(music));

  const xml = { type: 'xml', data: { data: '<?xml version="1.0"?><msg serviceID="1"><item><title>群邀请：测试群</title><summary>点击加入群聊&#10;群号 123456</summary><url>https://qm.qq.com/cgi-bin/qm/qr?k=abc</url></item></msg>' } };
  const xmlText = cardSegmentToText(xml);
  ok(xmlText.includes('群邀请') && xmlText.includes('测试群'), 'xml 邀请卡片（含来源猜测）', xmlText);
  ok(xmlText.includes('群号 123456') && !xmlText.includes('&#10;'), 'xml 实体被解开、换行压平', xmlText);

  const share = { type: 'share', data: { url: 'https://www.bilibili.com/video/BV1xx', title: '【梗图】离谱', content: 'UP主：某某' } };
  const shareText = cardSegmentToText(share);
  ok(shareText.includes('链接分享') && shareText.includes('【梗图】离谱') && shareText.includes('BV1xx'), 'share 段（原来会掉进 default）', shareText);

  ok(cardSourceLabel('com.tencent.structmsg', 'news') === '分享', 'cardSourceLabel: structmsg/news');
  ok(cardSourceLabel('com.tencent.music.lua', '') === '音乐', 'cardSourceLabel: music');
  ok(xmlCardSourceLabel('<msg><title>红包来了</title></msg>') === '红包', 'xmlCardSourceLabel: 红包');
}

console.log('## 失败与降级');
{
  ok(parseJsonCard('{不是 json') === null, '坏 json 返回 null');
  ok(cardSegmentToText({ type: 'json', data: { data: '{不是 json' } }) === '[卡片消息（json 解析失败）]', '坏 json 明说解析失败');
  ok(cardSegmentToText({ type: 'xml', data: { data: '' } }) === '[卡片消息（xml 解析失败）]', '空 xml 明说解析失败');
  ok(parseJsonCard(JSON.stringify({ app: 'x', meta: {} })) === null, '没有任何可用字段时返回 null');
  ok(formatCardSummary(null) === '[卡片消息（解析失败）]', 'null 卡片有兜底文案');
  ok(cardSegmentToText({ type: 'json', data: {} }).includes('解析失败'), 'data 缺失时不抛错');
  const unknown = cardSegmentToText({ type: 'xml', data: { data: '<msg><item><title>某个东西</title></item></msg>' } });
  ok(unknown === '[卡片] 某个东西', '认不出来源时写 [卡片] 而不是 [卡片·卡片]', unknown);
  ok(cardPreviewUrl({ type: 'json', data: { data: '{bad' } }) === '', '坏卡片取预览图返回空串');
}

console.log('## 长度与脏字符（对方可控内容）');
{
  const long = JSON.stringify({ app: 'com.tencent.structmsg', view: 'news', meta: { news: { title: '标'.repeat(500), desc: '描'.repeat(500), jumpUrl: 'https://e.example/' + 'p'.repeat(500) } } });
  const text = cardSegmentToText({ type: 'json', data: { data: long } });
  ok(text.length <= CARD_SUMMARY_MAX, `超长卡片被压到 ${CARD_SUMMARY_MAX} 字内（实际 ${text.length}）`);
  ok(text.includes('…'), '被截断的部分有省略号');

  const dirty = JSON.stringify({ app: 'com.tencent.structmsg', view: 'news', meta: { news: { title: 'a\u0000b\u2028c', desc: 'x\ny\tz' } } });
  const dirtyText = cardSegmentToText({ type: 'json', data: { data: dirty } });
  ok(!/[\u0000-\u001f\u2028]/.test(dirtyText), '控制字符/换行被清掉', JSON.stringify(dirtyText));
  ok(cleanCardText('a\nb\t\tc', 200) === 'a b c', 'cleanCardText 压平空白');

  // 摘要不再受 200 字束缚：链接被截断等于没有（AI 会回「我打不开」），
  // 所以摘要上限必须放得下一条真实链接；含卡片的消息在 bridge 里用更大的 text 上限。
  ok(CARD_SUMMARY_MAX >= 300, `摘要上限 ${CARD_SUMMARY_MAX} 足够放下完整链接`);
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  ok(/const textLimit = card \? CARD_TEXT_LIMIT : 200/.test(bridge), 'bridge 对含卡片的消息放宽 text/plain 截断上限');
  ok(/CARD_TEXT_LIMIT = CARD_SUMMARY_MAX \+ 80/.test(bridge), 'CARD_TEXT_LIMIT 由 CARD_SUMMARY_MAX 推导，不会小于摘要');
  ok(decodeXmlEntities('a&amp;b&#10;c&lt;d') === 'a&b\nc<d', 'decodeXmlEntities 处理命名与数字实体');
}

console.log('## 完整链接（本次修复的核心）');
{
  // 真实卡片：摘要里必须出现**完整**链接，而不是 ...?h_camp…
  const text = cardSegmentToText({ type: 'json', data: { data: REAL_CARD_JSON } });
  const realUrl = JSON.parse(REAL_CARD_JSON).meta.news.jumpUrl;
  ok(text.includes(realUrl), '摘要里带完整链接（不再截断）', text.slice(-90));
  ok(!/\?h_camp…/.test(text), '不再出现 ...h_camp… 这种被砍断的链接');
  ok(text.length <= CARD_SUMMARY_MAX, `摘要长度 ${text.length} <= ${CARD_SUMMARY_MAX}`);

  // 结构化字段：即使 URL 长到摘要放不下，card.url 也必须完整
  const card = extractCardFromSegments([{ type: 'json', data: { data: REAL_CARD_JSON } }]);
  ok(card && card.url === realUrl, '结构化 card.url 与原始链接逐字相等', card?.url);
  ok(card?.source === '小黑盒' && String(card?.title || '').includes('姿态'), '结构化 card 带来源与标题');
  ok(String(card?.preview || '').startsWith('https://'), '结构化 card 带预览图 URL');

  const hugeUrl = 'https://e.example/' + 'p'.repeat(2000);
  const huge = normalizeCardForStore(parseJsonCard(JSON.stringify({ app: 'com.tencent.structmsg', view: 'news', meta: { news: { title: 't', jumpUrl: hugeUrl } } })), 'json');
  ok(huge.url.length === CARD_STORE_URL_MAX && hugeUrl.startsWith(huge.url), `超长链接按 ${CARD_STORE_URL_MAX} 上限保留（远超摘要）`);
  ok(extractCardFromSegments([{ type: 'text', data: { text: 'hi' } }]) === null, '非卡片消息返回 null');
  ok(extractCardFromSegments([]) === null && extractCardFromSegments(null) === null, '空/非法输入不抛错');
}

console.log('## 合并转发里的卡片');
{
  const forward = await import('../src/forward.js');
  const card = JSON.stringify({ app: 'com.tencent.structmsg', view: 'news', meta: { news: { title: '转发里的卡片', desc: '摘要', jumpUrl: 'https://e.example/a' } } });
  const res = forward.formatForwardResponse({ messages: [{ sender: { nickname: '老王' }, content: [{ type: 'json', data: { data: card } }] }] });
  const text = res?.messages?.[0]?.text ?? '';
  ok(text.includes('转发里的卡片') && text.includes('https://e.example/a'), '合并转发里的 json 卡片可读', text);
  ok(!text.includes('[卡片消息]'), '不再是 [卡片消息] 占位符', text);
}

console.log('## 桥接接线');
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  ok(/case 'json':[\s\S]{0,80}case 'xml':[\s\S]{0,80}case 'share':/.test(bridge), 'segmentsToText 里 json/xml/share 一起处理');
  ok(bridge.includes('cardSegmentToText(seg)'), 'segmentsToText 调用 cardSegmentToText');
  ok(!/case 'json': out\.push\('\[卡片消息\]'\)/.test(bridge), '旧的 [卡片消息] 硬编码已移除');
  const fwd = fs.readFileSync(path.join(ROOT, 'src', 'forward.js'), 'utf8');
  ok(fwd.includes("from './card-parse.js'"), 'forward.js 复用同一个卡片解析器');
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  ok(mcp.includes('qq_get_message_detail'), 'AI 仍可用 qq_get_message_detail 看卡片详情');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
