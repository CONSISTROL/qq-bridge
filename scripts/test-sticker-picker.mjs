// 表情包「时机判断 + 选图」回归测试（纯函数 + 可选在线兜底）。
//
// 覆盖：
//   1. tokenize / detectIntents / looksSerious / mentionsSelf 的识别
//   2. normalizePickItem / scoreStickerItem / pickStickers 的打分与排序
//   3. evaluateMoment 的时机门（冷却、每轮上限、严肃语境、信号）
//   4. buildOnlineQuery 的风格偏置
//   5. buildPickPlan 的完整决策
//
// 在线部分（--online）会真的走 B 站搜图 + safeFetchBuffer，默认跳过。
import {
  tokenize,
  detectIntents,
  looksSerious,
  mentionsSelf,
  normalizePickItem,
  itemText,
  scoreStickerItem,
  pickStickers,
  evaluateMoment,
  buildOnlineQuery,
  buildPickPlan,
  STYLE_KEYWORDS
} from '../src/sticker-picker.js';
import { buildStickerMomentHint } from '../src/sticker-lib.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

// ── 1. 文本理解 ────────────────────────────────────────────────────────────
console.log('\n[1] 语境识别');
ok('tokenize 中文 bigram', tokenize('笑死我了').includes('笑死') && tokenize('笑死我了').includes('死我'));
ok('tokenize 英文词', tokenize('LOL what a day').includes('lol') && tokenize('LOL what a day').includes('what'));
ok('tokenize 去标点', !tokenize('你好，世界！').includes('，'));
eq('detectIntents 笑点', detectIntents('哈哈哈哈哈笑死我了'), ['laugh']);
ok('detectIntents 返回 id 字符串', detectIntents('笑死').every((x) => typeof x === 'string'));
ok('detectIntents 多意图', detectIntents('笑死，这也太离谱了吧').includes('laugh') && detectIntents('笑死，这也太离谱了吧').includes('speechless'));
ok('detectIntents 怼人', detectIntents('就这？你也太菜了').includes('tease'));
ok('detectIntents 自己人设', detectIntents('deepseek 你又开始胡说八道了').includes('ai'));
eq('detectIntents 空文本', detectIntents(''), []);
ok('looksSerious 命中', looksSerious('他奶奶住院了，最近在跑医院'));
ok('looksSerious 不误伤', !looksSerious('今天打游戏赢麻了'));
// 2026-10-15 复盘：考试/面试/离职这类日常话题不该整轮禁掉表情（"加油/抱抱"正是这种场合）
ok('考试不再算严肃', !looksSerious('明天要考试了好紧张'));
ok('面试不再算严肃', !looksSerious('下午有个面试'));
ok('裁员不再算严肃', !looksSerious('我们组裁员了'));
ok('真正沉重的话题仍然拦', looksSerious('他家里老人去世了'));
ok('mentionsSelf 命中', mentionsSelf('小鲸鱼今天怎么这么安静'));
ok('mentionsSelf 不误伤', !mentionsSelf('今天天气不错'));

// ── 2. 候选归一化与打分 ───────────────────────────────────────────────────
console.log('\n[2] 候选归一化与打分');
const qqRaw = { id: '2840404638_0_0_0_AAA', desc: '白毛生气脸，怼人用', localNote: '适合炸毛、怼人', tags: ['生气', '怼人'], useCount: 3, lastUsedAt: Date.now() - 3 * 3600_000 };
const libRaw = { file: 'style-comment-abc123.png', title: '猫猫无语表情包', source: 'style', origin: '二次元表情包', width: 300, height: 300, bytes: 51200 };
const qqItem = normalizePickItem(qqRaw, 'qq');
const libItem = normalizePickItem(libRaw, 'library');
eq('QQ 候选 channel', qqItem.channel, 'sticker');
eq('图库候选 channel', libItem.channel, 'image');
eq('图库候选 ref=纯文件名', libItem.ref, 'style-comment-abc123.png');
ok('缺 id 的 QQ 候选被丢弃', normalizePickItem({ desc: 'x' }, 'qq') === null);
ok('缺 file 的图库候选被丢弃', normalizePickItem({ title: 'x' }, 'library') === null);
ok('itemText 汇总备注+标签', itemText(qqItem).includes('怼人') && itemText(qqItem).includes('生气'));

const scoreArgs = { now: Date.now(), recentIds: [] };
const s1 = scoreStickerItem(qqItem, { ...scoreArgs, contextTokens: new Set(tokenize('你这也太菜了，不服')), needTokens: new Set(tokenize('生气 炸毛 怼人')), intents: [{ id: 'tease', need: '生气 炸毛 怼人' }] });
const s2 = scoreStickerItem(detectStickerNoText(), { ...scoreArgs, contextTokens: new Set(tokenize('你这也太菜了')), needTokens: new Set(tokenize('生气 炸毛 怼人')), intents: [{ id: 'tease', need: '生气 炸毛 怼人' }] });
function detectStickerNoText() {
  return normalizePickItem({ id: 'no-text-sticker', desc: '', localNote: '', tags: [], lastUsedAt: qqRaw.lastUsedAt, useCount: 0 }, 'qq');
}
ok('命中语境的表情得分更高', s1.score > s2.score, `${s1.score} vs ${s2.score}`);
ok('被匹配上的备注/标签计入 relevance', s1.breakdown.relevance > s2.breakdown.relevance, `${s1.breakdown.relevance} vs ${s2.breakdown.relevance}`);
const s3 = scoreStickerItem(qqItem, { ...scoreArgs, recentIds: [qqItem.id], contextTokens: new Set(), needTokens: new Set() });
ok('刚发过的表情被降权', s3.breakdown.recentPenalty === 25);
const fresh = normalizePickItem({ id: 'fresh', desc: '怼人', tags: ['怼人'] }, 'qq');
const used = normalizePickItem({ id: 'used', desc: '怼人', tags: ['怼人'], useCount: 9, lastUsedAt: Date.now() }, 'qq');
ok('没用过的比用烂的分高', scoreStickerItem(fresh, scoreArgs).score > scoreStickerItem(used, scoreArgs).score);
const selfItem = normalizePickItem({ id: 'whale', localNote: '我的Q版形象小鲸鱼讨饭' }, 'qq');
ok('提到自己时给二创加成', scoreStickerItem(selfItem, { ...scoreArgs, preferSelf: true }).breakdown.selfBonus === 6);

console.log('\n[3] 排序');
const pool = [
  normalizePickItem({ id: 'a', desc: '白毛生气脸，怼人用', tags: ['生气', '怼人'] }, 'qq'),
  normalizePickItem({ id: 'b', desc: '摸摸头安慰', tags: ['安慰', '抱抱'] }, 'qq'),
  normalizePickItem({ id: 'c', desc: '大笑到拍桌', tags: ['大笑', '绷不住'] }, 'qq'),
  normalizePickItem({ file: 'cat.png', title: '无语猫猫表情包' }, 'library')
];
const picked = pickStickers(pool, '哈哈哈哈哈笑死我了，这也太离谱');
eq('命中笑点的排第一', picked.candidates[0].id, 'c');
ok('返回意图标签', picked.intents.includes('laugh'));
const picked2 = pickStickers(pool, '抱抱，别难过了');
eq('安慰语境换人排第一', picked2.candidates[0].id, 'b');
const limited = pickStickers(pool, '随便', { limit: 2 });
eq('limit 生效', limited.candidates.length, 2);

// ── 4. 时机门 ─────────────────────────────────────────────────────────────
console.log('\n[4] 时机门');
const now = Date.now();
const baseState = { recentMessages: [], lastIncomingAt: now - 60000 };
const cfg = { enabled: true, minIntervalMs: 90000, maxPerTurn: 1 };

const m1 = evaluateMoment(baseState, { cfg, now, context: '哈哈哈哈笑死我了' });
ok('情绪语境=合适', m1.allowed === true && m1.level === 'good', JSON.stringify(m1));

const m2 = evaluateMoment(baseState, { cfg, now, context: '他奶奶住院了，最近在跑医院' });
ok('严肃语境=拦住', m2.allowed === false && m2.level === 'no', m2.reason);
// 严肃判定只看最后一条进来的消息：窗口里早先那条严肃的不该继续拦（那是上一轮的事）
const m2b = evaluateMoment(baseState, { cfg, now, context: '他奶奶住院了，随便聊聊；哈哈这也太离谱了', lastIncomingText: '哈哈这也太离谱了' });
ok('严肃判定只看最后一条', m2b.allowed === true, m2b.reason);
const m2c = evaluateMoment(baseState, { cfg, now, context: '哈哈这也太离谱了', lastIncomingText: '他奶奶住院了' });
ok('最后一条严肃就拦住', m2c.allowed === false, m2c.reason);

const m3 = evaluateMoment({ ...baseState, recentMessages: [{ kind: 'sticker', isSelf: true, time: now - 10000 }], lastStickerAt: now - 10000 }, { cfg, now, context: '哈哈' });
ok('冷却期内=拦住', m3.allowed === false && m3.cooldownLeftMs > 0, m3.reason);

// 上一次发表情之后群里又来新消息（新的一轮）→ 冷却也过了，就该放行
const m4 = evaluateMoment({
  recentMessages: [{ kind: 'sticker', isSelf: true, time: now - 20000 }],
  lastStickerAt: now - 20000,
  lastIncomingAt: now - 10000
}, { cfg: { ...cfg, minIntervalMs: 5000 }, now, context: '哈哈' });
ok('超过冷却且进入新一轮=放行', m4.allowed === true, m4.reason);

// 本轮内（最后一条别人的消息之后）已经发过一张 → 即便冷却过了也不该再发
const m5 = evaluateMoment({
  recentMessages: [{ kind: 'sticker', isSelf: true, time: now - 30000 }],
  lastStickerAt: now - 30000,
  lastIncomingAt: now - 60000
}, { cfg: { ...cfg, minIntervalMs: 5000 }, now, context: '哈哈' });
ok('本轮已发过一张=拦住', m5.allowed === false && m5.stickersThisTurn >= 1, m5.reason);

const m6 = evaluateMoment(baseState, { cfg: { ...cfg, enabled: false }, now, context: '哈哈' });
ok('总开关关闭=拦住', m6.allowed === false);

const m7 = evaluateMoment({ recentMessages: [{ isSelf: false, hasMedia: true, media: [{ kind: 'face' }], time: now - 30000 }], lastIncomingAt: now - 30000 }, { cfg, now, context: '给你看个图' });
ok('对方刚发图=合适', m7.allowed === true && m7.level === 'good', m7.reason);

const m8 = evaluateMoment({ recentMessages: [{ isSelf: true, kind: 'sticker', time: now - 10000 }], lastStickerAt: now - 10000, lastIncomingAt: now - 5000 }, { cfg, now, context: '哈哈' });
eq('冷却余量可读', m8.cooldownLeftMs > 0, true);
ok('冷却秒数合理', m8.cooldownLeftMs <= 90000 && m8.cooldownLeftMs > 70000, String(m8.cooldownLeftMs));

// ── 5. 联网搜索词风格偏置 ─────────────────────────────────────────────────
console.log('\n[5] 联网搜索词');
const q1 = buildOnlineQuery({ topic: '原神新角色', intents: ['laugh'] });
ok('带话题词', q1.includes('原神新角色'), q1);
ok('带风格偏置', q1.includes('表情包') || q1.includes('二次元'), q1);
const q2 = buildOnlineQuery({ topic: '', intents: ['tease'] });
ok('无话题时用意图兜底', q2.includes('就这') || q2.includes('嘲讽'), q2);
const q3 = buildOnlineQuery({ topic: 'deepseek', intents: [], preferSelf: true });
ok('提到自己时偏 DeepSeek 二创', q3.includes('deepseek娘') || q3.includes('小鲸鱼'), q3);
ok('风格词表非空', STYLE_KEYWORDS.length >= 3);

// ── 6. 完整决策 ───────────────────────────────────────────────────────────
console.log('\n[6] buildPickPlan 完整决策');
const plan = buildPickPlan({
  qqItems: [qqRaw, { id: 'whale', localNote: '小鲸鱼讨饭表情' }],
  libraryItems: [libRaw],
  context: '哈哈笑死，猫猫也太离谱了',
  moment: m1,
  options: { cfg: { minScore: 30, includeLibrary: true, styleKeywords: STYLE_KEYWORDS }, limit: 5 }
});
eq('候选池合并', plan.poolSize, 3);
ok('decided 与分数一致', plan.decided === (plan.best && plan.best.score >= plan.minScore));
ok('阈值高时判定为不够', buildPickPlan({ qqItems: [qqRaw], libraryItems: [], context: '随便', options: { cfg: { minScore: 99 }, limit: 3 } }).decided === false);
ok('serious 语境可被识别', buildPickPlan({ qqItems: [], libraryItems: [], context: '他住院了', options: {} }).serious === true);
ok('onlineQuery 有值', typeof plan.onlineQuery === 'string' && plan.onlineQuery.length > 0, plan.onlineQuery);
ok('includeLibrary=false 时池子只剩收藏表情', buildPickPlan({ qqItems: [qqRaw], libraryItems: [libRaw], context: 'x', options: { cfg: { includeLibrary: false } } }).poolSize === 1);

// ── 4. 时机提示的措辞与「一步发送」指引（2026-10-15 新增）─────────────────
console.log('\n[4] 时机提示：行动导向 + 一步发送');
const okMoment = { allowed: true, level: 'ok', reason: '群里静了一会儿', lastStickerMinAgo: null };
const goodMoment = { allowed: true, level: 'good', reason: '语境带情绪（laugh）', lastStickerMinAgo: 30 };
const topCand = [{ id: '2840404638_0_0_0_AAA', label: '猫猫无语', score: 46 }, { id: 'lib:x.png', label: '图库图', score: 31 }];
const okLine = buildStickerMomentHint(okMoment, { top: topCand });
ok('ok 不再是「一般」而是可以发', /可以发一张/.test(okLine), okLine);
ok('给了 top1 的 id（一步发送）', okLine.includes('2840404638_0_0_0_AAA'), okLine);
ok('明确说了 qq_pick_sticker 能直接发', /qq_pick_sticker\(key=/.test(okLine) && /send=\{id:/.test(okLine), okLine);
const goodLine = buildStickerMomentHint(goodMoment, { top: topCand });
ok('good 明确说很适合发', /很适合发一张/.test(goodLine), goodLine);
const noCandLine = buildStickerMomentHint(okMoment, { top: [] });
ok('没有候选时才保留「别凭印象瞎发」', /别凭印象瞎发/.test(noCandLine), noCandLine);
ok('有候选时不再吓唬它', !/别凭印象瞎发/.test(okLine), okLine);
const blockedLine = buildStickerMomentHint({ allowed: false, reason: '冷却中' }, { top: topCand });
ok('拦截时仍然明确说不适合', /不适合/.test(blockedLine) && !/send=\{/.test(blockedLine), blockedLine);

console.log(`\n结果：${pass} 项通过 / ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
