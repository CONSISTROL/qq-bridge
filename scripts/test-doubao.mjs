// 豆包接入的自检脚本（纯逻辑，不需要浏览器、不需要联网）：
// 1. buildDoubaoMemePrompt：必须明确允许模型说「不知道」，并要求结构化输出
// 2. parseDoubaoAnswer：JSON / 代码块 / 纯文本 / 拒答 各种形态都要解析对
// 3. classifyEvidence：B站证据 vs 只有豆包 vs 什么都没有
// 4. decidePromotion：**只有豆包一个来源时永远不自动转正**（本次接入的核心护栏）
// 运行：node scripts/test-doubao.mjs
import {
  buildDoubaoMemePrompt,
  parseDoubaoAnswer,
  classifyEvidence,
  decidePromotion,
  describeEvidence
} from '../src/doubao-research.js';

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

console.log('\n## buildDoubaoMemePrompt');
{
  const p = buildDoubaoMemePrompt('哈基米');
  check('带上要查的词', p.includes('哈基米'));
  check('明确允许说不知道（压制幻觉的关键一句）', /只回答你确实知道的/.test(p));
  check('要求 known 字段', /"known"/.test(p));
  check('要求 confidence', /confidence/.test(p));
  check('禁止客套话/复述问题', /不要输出客套话/.test(p));
  const p2 = buildDoubaoMemePrompt('哈基米', { groupExamples: ['这猫好哈基米'] });
  check('能带上群里的真实用法', p2.includes('这猫好哈基米'));
  const p3 = buildDoubaoMemePrompt('x'.repeat(200));
  check('超长词会截断', p3.includes('x'.repeat(60)) && !p3.includes('x'.repeat(61)));
}

console.log('\n## parseDoubaoAnswer');
{
  const ok = parseDoubaoAnswer('{"known":true,"meaning":"猫的可爱称呼","usage":"夸猫","origin":"抖音","example":"哈基米哈基米","confidence":"high"}');
  check('标准 JSON 能解析', ok.known === true && ok.meaning === '猫的可爱称呼');
  check('confidence 保留', ok.confidence === 'high');
  check('usage/origin/example 都带上', ok.usage === '夸猫' && ok.origin === '抖音' && ok.example === '哈基米哈基米');

  const fenced = parseDoubaoAnswer('好的，这是结果：\n```json\n{"known":true,"meaning":"一种猫meme","confidence":"medium"}\n```\n希望有帮助');
  check('代码块包裹的 JSON 能解析', fenced.known === true && fenced.meaning === '一种猫meme');

  const no = parseDoubaoAnswer('{"known":false,"meaning":"","usage":"","origin":"","example":"","confidence":"low"}');
  check('known=false 视为不知道', no.known === false && no.reason === 'model_says_unknown');

  const emptyMeaning = parseDoubaoAnswer('{"known":true,"meaning":"","confidence":"high"}');
  check('说知道但没给释义 → 仍视为不知道', emptyMeaning.known === false);

  const refuse = parseDoubaoAnswer('抱歉，我不确定这个词是什么意思，没有见过它作为固定网络梗的使用。');
  check('纯文本拒答 → 不知道', refuse.known === false && refuse.reason === 'model_says_unknown');

  const notMeme = parseDoubaoAnswer('我不清楚，这不是一个固定的网络梗。');
  check('「不是固定梗」也算拒答', notMeme.known === false);

  check('空回答 → 不知道', parseDoubaoAnswer('').known === false);
  check('null → 不知道', parseDoubaoAnswer(null).known === false);

  const long = parseDoubaoAnswer('这个词'.repeat(300));
  check('超长无结构文本不收（多半没按要求输出）', long.known === false && long.reason === 'unstructured_long');

  const plain = parseDoubaoAnswer('指一只很受欢迎的猫，常用来表达喜欢。');
  check('短的纯文本可以收，但置信度低', plain.known === true && plain.confidence === 'low');

  const json = parseDoubaoAnswer('{"known":true,"meaning":"这是一个测试释义","confidence":"weird"}');
  check('非法 confidence 落到 medium', json.confidence === 'medium');
}

console.log('\n## classifyEvidence');
{
  check('1 条 B站评论 → strong', classifyEvidence({ biliCommentCount: 1 }) === 'strong');
  check('2 个 B站视频 → strong', classifyEvidence({ biliVideoCount: 2 }) === 'strong');
  check('1 个视频 + 0 评论 → 不算 strong', classifyEvidence({ biliVideoCount: 1 }) !== 'strong');
  check('B站评论数优先于豆包', classifyEvidence({ biliCommentCount: 1, doubaoKnown: true }) === 'strong');
  check('只有豆包 → doubao-only', classifyEvidence({ doubaoKnown: true }) === 'doubao-only');
  check('什么都没有 → weak', classifyEvidence({}) === 'weak');
  check('没有豆包、没有B站 → weak', classifyEvidence({ doubaoKnown: false }) === 'weak');
}

console.log('\n## decidePromotion（核心护栏）');
{
  // 这是本次接入最要紧的一条：模型会编，单独一路来源不能转正。
  const d = decidePromotion({ evidence: 'doubao-only', learnerConfirmed: true, hasMeaning: true, autoConfirm: true });
  check('★ 只有豆包 → 绝不自动转正', d.promote === false, JSON.stringify(d));
  check('★ verdict 标成 doubao-only', d.verdict === 'doubao-only');
  check('★ 给出可读的原因', /交叉验证/.test(d.reason));

  const strong = decidePromotion({ evidence: 'strong', learnerConfirmed: true, hasMeaning: true, autoConfirm: true });
  check('B站有独立证据 + 自动转正开启 → 转正', strong.promote === true && strong.verdict === 'confirmed');

  const noAuto = decidePromotion({ evidence: 'strong', learnerConfirmed: true, hasMeaning: true, autoConfirm: false });
  check('自动转正关闭 → 不转正（保持现状）', noAuto.promote === false && noAuto.verdict === 'confirmed');

  const unconfirmed = decidePromotion({ evidence: 'strong', learnerConfirmed: false, hasMeaning: true });
  check('研究会话没确认 → 不转正', unconfirmed.promote === false);

  const noMeaning = decidePromotion({ evidence: 'strong', learnerConfirmed: true, hasMeaning: false });
  check('没有释义 → 不转正', noMeaning.promote === false);

  const weak = decidePromotion({ evidence: 'weak', learnerConfirmed: true, hasMeaning: true, autoConfirm: true });
  check('weak 保持原有行为（自动转正开启则转正）', weak.promote === true);

  const doubaoNoAuto = decidePromotion({ evidence: 'doubao-only', learnerConfirmed: true, hasMeaning: true, autoConfirm: false });
  check('豆包 + 自动转正关闭 → 依然不转正', doubaoNoAuto.promote === false && doubaoNoAuto.verdict === 'doubao-only');
}

console.log('\n## describeEvidence');
{
  check('strong 描述', describeEvidence('strong') === 'B站有独立证据');
  check('doubao-only 描述', /未交叉验证/.test(describeEvidence('doubao-only')));
  check('weak 描述', describeEvidence('weak') === '无外部证据');
  check('未知输入不炸', typeof describeEvidence(undefined) === 'string');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
