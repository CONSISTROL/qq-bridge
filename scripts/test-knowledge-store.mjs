// 群知识库自检（纯函数层）。
// 覆盖：指纹归一、near-duplicate 命中、别名命中、命中计数与 askers、重复问提醒阈值、
//       注入表渲染、落盘往返、原型污染防护、容量上限。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KNOWLEDGE_STATUS,
  KNOWLEDGE_STATUSES,
  isActiveStatus,
  KNOWLEDGE_KINDS,
  questionFingerprint,
  questionSimilarity,
  normalizeKnowledgeEntry,
  createKnowledgeEntry,
  findKnowledgeMatch,
  recordHit,
  shouldRemindRepeat,
  formatKnowledgeTable,
  buildKnowledgeContext,
  asIndexEntry,
  loadKnowledge,
  saveKnowledge,
} from '../src/knowledge-store.js';

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) { ok(a === b, `${label}（期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}）`); }

console.log('— 问题指纹 —');
eq(questionFingerprint('DeepSeek 什么时候开源的？'), questionFingerprint('deepseek什么时候开源'), '大小写/标点/空白不影响指纹');
eq(questionFingerprint('这个怎么弄？'), questionFingerprint('这个怎么弄'), '尾部问号被剥离');
ok(questionFingerprint('群里能发广告吗') === questionFingerprint('群里能发广告吗？'), '疑问语气词“吗”被剥离后一致');
ok(questionFingerprint('请问管理员是谁') === questionFingerprint('管理员是谁'), '前缀“请问”被剥离');
ok(questionFingerprint('') === '', '空输入返回空指纹');
ok(questionFingerprint('AB') === questionFingerprint('ab'), '英文大小写归一');

console.log('— 相似度 —');
ok(questionSimilarity('群里能不能发广告', '群里能不能发广告呀') > 0.8, '同一问句多打语气词 → 相似度很高');
ok(questionSimilarity('今天股市怎么样', '今天大盘怎么样') > 0.6, '只差一个词（股市↔大盘）→ 编辑距离兜住');
ok(questionSimilarity('群里能不能发广告', '今天股市怎么样') < 0.2, '无关问题相似度低');
ok(questionSimilarity('群里管理员是谁', '管理员是谁') >= 0.6, '冗余前缀不影响判断');
ok(questionSimilarity('群里管理员是哪一位呀', '管理员是谁') < 0.62, '字面差太远的不硬并（交给向量检索）');
eq(questionSimilarity('', 'abc'), 0, '空串相似度为 0');

console.log('— 去重命中 —');
const store = [];
// 显式 confirmed：createKnowledgeEntry 默认落候选（等人工确认），
// 而这一组测试考察的是「已生效条目」的检索/渲染，所以状态要写明。
const e1 = createKnowledgeEntry({
  question: 'DeepSeek 是什么时候开源的？',
  answer: '2023 年 11 月发布并开源。',
  kind: KNOWLEDGE_KINDS.FACT,
  asker: '甲',
  sources: ['https://example.com/ds'],
  status: KNOWLEDGE_STATUS.CONFIRMED,
});
store.push(e1);
eq(e1.hitCount, 1, '新建条目初始 hitCount=1');
ok(e1.askers.includes('甲'), '首个提问者写入 askers');
ok(e1.tags.includes(KNOWLEDGE_KINDS.FACT), 'kind 自动并入 tags');

const m1 = findKnowledgeMatch(store, 'deepseek 什么时候开源的');
eq(m1?.match, 'fingerprint', '同一问题不同标点/大小写/句末“的” → 指纹命中');
const m2 = findKnowledgeMatch(store, 'DeepSeek 是什么时候开源的呢？');
ok(m2 && m2.entry.id === e1.id, '换问法（呢/标点）仍能命中同一条');

const e2 = createKnowledgeEntry({ question: '管理员是谁', answer: '10001', kind: KNOWLEDGE_KINDS.PERSON, aliases: ['群主是谁'], status: KNOWLEDGE_STATUS.CONFIRMED });
store.push(e2);
eq(findKnowledgeMatch(store, '群主是谁？')?.match, 'alias', '别名命中');

const m3 = findKnowledgeMatch(store, '群里管理员是谁');
ok(m3?.entry?.id === e2.id, '字面高度相似 → similar 命中同一条');

console.log('— 命中计数 —');
const before = e1.hitCount;
recordHit(e1, { key: 'group:1', asker: '乙', text: 'ds 啥时开源的' });
eq(e1.hitCount, before + 1, 'recordHit 递增计数');
ok(e1.askers.includes('乙'), 'recordHit 追加新提问者');
eq(e1.askers.length, 2, 'askers 去重后为 2');
recordHit(e1, { key: 'group:1', asker: '乙', text: 'ds 啥时开源的' });
eq(e1.askers.length, 2, '同一人重复提问不重复计入 askers');
eq(e1.hitCount, before + 2, '但 hitCount 仍累加');

console.log('— 重复问提醒阈值 —');
ok(shouldRemindRepeat(e1, 3, 2) === true, '3 次 × 2 人 → 触发提醒');
const single = createKnowledgeEntry({ question: '只有我一个人问', answer: 'x', asker: '甲' });
recordHit(single, { asker: '甲' });
recordHit(single, { asker: '甲' });
ok(shouldRemindRepeat(single, 3, 2) === false, '同一个人问 3 次不触发（不算群级 FAQ）');

console.log('— 注入表渲染 —');
const block = formatKnowledgeTable([e1, e2], { remindThreshold: 3 });
ok(block.includes('【群知识库】'), '渲染带表头');
ok(block.includes('[事实]'), '渲染带类型标签');
ok(block.includes('已被问过'), '达到阈值时附重复问提醒');
ok(block.includes('来源：'), '带来源');
const noRemind = formatKnowledgeTable([e2], { remindThreshold: 3 });
ok(!noRemind.includes('已被问过'), '未达阈值不附提醒');
ok(formatKnowledgeTable([], {}) === '', '空列表渲染为空串');

const fallback = buildKnowledgeContext(store, 6, { remindThreshold: 3 });
ok(fallback.includes('事实') && fallback.includes('人物'), '兜底路径按命中次数渲染多条');
ok(!fallback.includes('<script'), '渲染做了 HTML 转义防护');
const xss = normalizeKnowledgeEntry({ question: '<img src=x onerror=1>', answer: '<b>bold</b>' });
ok(!formatKnowledgeTable([xss], {}).includes('<img'), '注入型内容被转义');

console.log('— 索引适配器 —');
const idx = asIndexEntry(e1);
eq(idx.content, e1.question, 'asIndexEntry: question→content');
eq(idx.meaning, e1.answer, 'asIndexEntry: answer→meaning');

console.log('— 落盘往返 —');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
const file = path.join(tmpDir, 'knowledge.json');
saveKnowledge(file, store);
const reloaded = loadKnowledge(file);
eq(reloaded.length, store.length, '读写往返条数一致');
eq(reloaded[0].question, e1.question, '往返后问题一致');
eq(reloaded[0].hitCount, e1.hitCount, '往返后计数保留');
ok((fs.statSync(file).mode & 0o777) === 0o600, '落盘权限 0600');
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('— 修订计数 —');
{
  const e = createKnowledgeEntry({ question: '版本号是多少', answer: 'v1', kind: KNOWLEDGE_KINDS.FACT });
  eq(e.revision, 0, '新条目修订次数为 0');
  const bumped = normalizeKnowledgeEntry({ ...e, revision: (e.revision || 0) + 1, answer: 'v2' });
  eq(bumped.revision, 1, '修订次数可累加');
  eq(normalizeKnowledgeEntry({ question: 'q', answer: 'a', revision: -3 }).revision, 0, '负数修订被夹到 0');
  const file2 = path.join(os.tmpdir(), `kb-rev-${Date.now()}.json`);
  saveKnowledge(file2, [bumped]);
  eq(loadKnowledge(file2)[0].revision, 1, '修订次数能持久化往返');
  fs.rmSync(file2, { force: true });
}

console.log('— 三种状态 —');
{
  eq(isActiveStatus(KNOWLEDGE_STATUS.CONFIRMED), true, 'confirmed 才算生效');
  eq(isActiveStatus(KNOWLEDGE_STATUS.CANDIDATE), false, 'candidate 不生效');
  eq(isActiveStatus(KNOWLEDGE_STATUS.ARCHIVED), false, 'archived 不生效');
  eq(isActiveStatus(undefined), false, '未定义状态不生效');
  // 状态三元组齐全（候选/确认/停用），与黑话库同一套语义
  eq(KNOWLEDGE_STATUSES.length, 3, '共三种状态');
  ok(KNOWLEDGE_STATUSES.includes('candidate') && KNOWLEDGE_STATUSES.includes('confirmed') && KNOWLEDGE_STATUSES.includes('archived'), '三种状态齐全');
  // 缺 status / 非法 status 的条目默认落候选：宁可等人工确认，也不要默默生效
  eq(normalizeKnowledgeEntry({ question: 'q', answer: 'a' }).status, KNOWLEDGE_STATUS.CANDIDATE, '缺 status 默认候选');
  eq(normalizeKnowledgeEntry({ question: 'q', answer: 'a', status: 'bogus' }).status, KNOWLEDGE_STATUS.CANDIDATE, '非法 status 落候选');
  eq(normalizeKnowledgeEntry({ question: 'q', answer: 'a', status: 'archived' }).status, KNOWLEDGE_STATUS.ARCHIVED, 'archived 保留');
  // 注入渲染与兜底路径都只认已生效
  const cand = createKnowledgeEntry({ question: '候选不该被注入', answer: 'x', status: KNOWLEDGE_STATUS.CANDIDATE });
  const conf = createKnowledgeEntry({ question: '已生效可以被注入', answer: 'y', status: KNOWLEDGE_STATUS.CONFIRMED });
  const ctx = buildKnowledgeContext([cand, conf], 10, {});
  ok(ctx.includes('已生效可以被注入') && !ctx.includes('候选不该被注入'), ctx);
}

console.log('— 防御性 —');
ok(normalizeKnowledgeEntry(null).question === '', 'null 输入不抛错');
eq(normalizeKnowledgeEntry({ question: 'q', answer: 'a', hitCount: -5 }).hitCount, 0, '负数计数被夹到 0');
ok(normalizeKnowledgeEntry({ question: 'q', answer: 'a', tags: ['fact', 'fact'] }).tags.length >= 1, '标签去重');
ok(normalizeKnowledgeEntry({ question: 'q', answer: 'a', kind: 'evil' }).kind === KNOWLEDGE_KINDS.FACT, '未知 kind 回落 fact');
eq(normalizeKnowledgeEntry({ question: 'q'.repeat(500), answer: 'a' }).question.length, 200, '超长问题被截断');
eq(normalizeKnowledgeEntry({ question: 'q', answer: 'a'.repeat(5000) }).answer.length, 2000, '超长答案被截断');
// 原型污染：__proto__ 作为 key 不应改变 Object.prototype
const proto = normalizeKnowledgeEntry({ question: '__proto__', answer: 'polluted' });
ok({}.polluted === undefined && proto.answer === 'polluted', '__proto__ 不会污染原型');
eq(findKnowledgeMatch([], '随便问问'), null, '空库查找返回 null');
eq(findKnowledgeMatch(store, '')?.match, undefined, '空问题不命中');

console.log('');
console.log(fail === 0 ? `全部通过：${pass} 项` : `通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
