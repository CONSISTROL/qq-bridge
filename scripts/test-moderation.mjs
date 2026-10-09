// 入站内容策略自检（src/content-filter.js + 提示词层策略）。
//
// 覆盖：
//   ① 纯函数层：默认词表为空（ACG 标签不被拦）、显式词表才拦、regex/substring、
//      extraPatterns 追加、显式空数组 = 不拦、冷却、回复文本；
//   ② 策略层（改 prompt 防回归）：`萝莉`/`合法萝莉`/`loli` 这类 ACG 体裁词**不能**出现在
//      默认词表里；preset（qq-chat-v2）与桥接每轮注入的提示词里**不能**再出现
//      「这套就是不碰 / 不搜不发 / 未成年色情」之类的 AI 内容审查话术。
//
//   node scripts/test-moderation.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MODERATION,
  normalizeModeration,
  checkContent,
  createContentGate
} from '../src/content-filter.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label}（期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}）`); }

// ── ① 纯函数层 ────────────────────────────────────────────────────────────────
console.log('[1] 默认词表与显式词表');
ok(Array.isArray(DEFAULT_MODERATION.patterns), 'DEFAULT_MODERATION.patterns 是数组');
eq(DEFAULT_MODERATION.patterns.length, 0, '默认词表为空（不替管理员做内容审查）');

const defaultGate = createContentGate(undefined);
for (const text of ['来张随机的合法萝莉色图', '来点萝莉图', '来个 loli 插画', '来张小正太的图', '来张可莉的图', '来张合法萝莉色图 谢谢']) {
  ok(checkContent(text, defaultGate.config).blocked === false, `默认不拦：${text}`);
}

const gate = createContentGate({ patterns: ['R18G', '幼交'] });
ok(gate.config.patterns.length === 2, '显式词表按管理员配置生效');
eq(checkContent('来点 R18G 的图', gate.config).blocked, true, '命中无歧义越线词 → 拦');
eq(checkContent('来点 r18g 的图', gate.config).matched, 'R18G', 'substring 匹配不区分大小写并回报命中词');
eq(checkContent('来张合法萝莉色图', gate.config).blocked, false, 'ACG 词不在显式词表里 → 不拦');

// 显式空数组 = 不拦（区别于 undefined = 用默认表）
eq(normalizeModeration({ patterns: [] }).patterns.length, 0, '显式空数组 = 词表为空');
eq(normalizeModeration({ patterns: ['x'], extraPatterns: ['y', 'x'] }).patterns.join(','), 'x,y', 'extraPatterns 追加且去重');
eq(normalizeModeration({ matching: 'bogus' }).matching, 'substring', '非法 matching 回退 substring');
eq(normalizeModeration({ action: 'bogus' }).action, 'reply', '非法 action 回退 reply');

// regex 模式：写错的正则跳过、不误杀
const reGate = createContentGate({ matching: 'regex', patterns: ['^.*R-?18G.*$', '([bad'] });
eq(checkContent('来点r18g', reGate.config).blocked, true, 'regex 命中');
eq(checkContent('来点合法萝莉', reGate.config).blocked, false, 'regex 写错不会误杀');

// 冷却：同一会话同一命中词在冷却期内第二次不再回固定话。
// 用真实时间起步（t 必须落在「现在」附近，否则会被当成一次早已过期的命中）。
let now = Date.now();
const coolGate = createContentGate({ patterns: ['R18G'], cooldownMs: 60000 }, { now: () => now });
const first = coolGate.check('R18G', { key: 'private:1' });
const second = coolGate.check('R18G', { key: 'private:1' });
const other = coolGate.check('R18G', { key: 'private:2' });
eq(first.reply, DEFAULT_MODERATION.replyText, '首次命中回固定话');
eq(first.throttled, undefined, '首次命中不算冷却');
eq(second.reply, '', '冷却期内第二次不回固定话');
eq(second.throttled, true, '冷却期标记 throttled');
eq(other.reply, DEFAULT_MODERATION.replyText, '冷却按会话隔离');
eq(other.throttled, undefined, '另一个会话不算冷却');
now += 61000;
eq(coolGate.check('R18G', { key: 'private:1' }).reply, DEFAULT_MODERATION.replyText, '冷却到期后恢复');

// ── ② 策略层：ACG 词不得进默认词表 / 提示词里不得有审查话术 ─────────────────────
console.log('[2] 策略回归（ACG 标签不被当越线）');
const ACG_TAGS = ['萝莉', '合法萝莉', 'ロリ', 'loli', '正太', 'shota'];
for (const tag of ACG_TAGS) {
  const inDefault = DEFAULT_MODERATION.patterns.some((p) => String(p).toLowerCase().includes(tag.toLowerCase()));
  ok(!inDefault, `默认词表不含 ${tag}`);
}

const presetPath = path.join(ROOT, 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml');
const preset = fs.readFileSync(presetPath, 'utf8');
for (const banned of ['这套就是不碰', '不搜、不发', '【硬底线】']) {
  ok(!preset.includes(banned), `preset 不再有审查话术：「${banned}」`);
}
for (const wanted of ['合法萝莉', '不做内容审查', 'ACG']) {
  ok(preset.includes(wanted), `preset 含新策略关键词：「${wanted}」`);
}

const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
const injected = bridgeSrc.slice(bridgeSrc.indexOf('【要图请求'), bridgeSrc.indexOf('【要图请求') + 2000);
ok(injected.includes('合法萝莉'), '桥接每轮注入的【要图请求】里点名了「合法萝莉」');
ok(injected.includes('不做任何年龄/合规判断') || injected.includes('不做内容审查'), '注入文本明确不做年龄/合规判断');
ok(!injected.includes('别把二次元萝莉当真人'), '注入文本去掉了旧的「当真人」措辞');

const toolSrc = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe.js'), 'utf8');
ok(toolSrc.includes('合法萝莉'), 'qq_search_images 工具描述里点名「合法萝莉」是有效标签');
ok(!toolSrc.includes('这套就是不碰'), '工具描述里没有审查话术');

console.log(`\n${fail === 0 ? '✅' : '❌'} moderation: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
