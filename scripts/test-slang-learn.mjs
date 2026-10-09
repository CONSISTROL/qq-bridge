// 黑话学习模块新增功能自检：sources 字段、深度研究 prompt、解析。
import assert from 'node:assert/strict';
import {
  normalizeSlangEntry,
  createSlangEntry,
  parseResearchJson,
  buildResearchPrompt,
  buildSlangContext,
  looksLikeNegativeFinding,
  SLANG_STATUS,
} from '../src/slang-learner.js';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`✅ ${name}`);
}

// 1. normalize 保留合法 sources，过滤空串并限长
{
  const e = normalizeSlangEntry({
    content: 'yyds',
    sources: ['https://example.com/a', '', ' https://example.com/b '],
  });
  assert.deepEqual(e.sources, ['https://example.com/a', 'https://example.com/b']);
  ok('normalizeSlangEntry 保留/清洗 sources');
}

// 2. createSlangEntry 支持 sources
{
  const e = createSlangEntry({ content: 'xswl', sources: ['https://example.com'] });
  assert.deepEqual(e.sources, ['https://example.com']);
  ok('createSlangEntry 支持 sources');
}

// 3. parseResearchJson 解析 sources
{
  const out = parseResearchJson('[{"content":"yyds","meaning":"永远的神","sources":["https://a",""]}]');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].sources, ['https://a']);
  ok('parseResearchJson 解析 sources');
}

// 4. buildResearchPrompt 要求深度联网与 sources
{
  const prompt = buildResearchPrompt([{ content: 'yyds', evidence: [{ text: '这波 yyds' }] }]);
  assert.ok(prompt.includes('web_fetch'), 'prompt 应要求 web_fetch 抓正文');
  assert.ok(prompt.includes('"sources"'), 'prompt 应要求输出 sources');
  assert.ok(prompt.includes('深度联网考究'), 'prompt 应强调深度联网考究');
  ok('buildResearchPrompt 深度研究指令');
}

// 5. buildSlangContext 只注入已确认且有含义的词条
{
  const ctx = buildSlangContext([
    { content: 'a', meaning: '甲', status: SLANG_STATUS.CONFIRMED, count: 2 },
    { content: 'b', meaning: '', status: SLANG_STATUS.CONFIRMED, count: 1 },
    { content: 'c', meaning: '丙', status: SLANG_STATUS.CANDIDATE, count: 9 },
  ], 8);
  assert.ok(ctx.includes('a：甲'));
  assert.ok(!ctx.includes('b：'));
  assert.ok(!ctx.includes('c：丙'));
  ok('buildSlangContext 只注入已确认且有含义词条');
}

// ── 来源与痕迹字段：探索学来的词必须能和「群友说出来的词」区分开 ──────────
{
  const explored = normalizeSlangEntry({
    content: '春日影', meaning: '名场面', source: 'explore',
    exploredFrom: 'MyGO!!!!!', autoConfirmed: true, researchedAt: '2026-09-25T00:00:00.000Z'
  });
  assert.equal(explored.source, 'explore', 'source=explore 不被改写成 ai');
  assert.equal(explored.exploredFrom, 'MyGO!!!!!', 'exploredFrom 被保留');
  assert.equal(explored.autoConfirmed, true, 'autoConfirmed 被保留');
  assert.equal(explored.researchedAt, '2026-09-25T00:00:00.000Z', 'researchedAt 被保留');
  assert.equal(normalizeSlangEntry({ content: 'x', source: 'manual' }).source, 'manual');
  assert.equal(normalizeSlangEntry({ content: 'y', source: 'ai' }).source, 'ai');
  assert.equal(normalizeSlangEntry({ content: 'z', source: '随便什么' }).source, 'ai', '未知来源回落成 ai');
  ok('来源/痕迹字段：explore 与 ai、manual 互不混淆，未知值回落');
}

// ── 研究结论标记：别把「研究过没定论」和「没研究过」混为一谈 ────────────────
// 线上问题：让 AI 研究「根本就没有这种」，结果界面上一直显示「待研究」。
// 根因是 runSlangResearch 在 confirmed!==true 时直接 continue，跳过了
// lastInferenceCount / researchedAt 的更新 —— 于是
//   ① 自动研究的触发条件 count > lastInferenceCount 永远成立，同一个词被反复重研；
//   ② 界面分不出「没研究过」和「研究过没结论」，只能一律显示「待研究」。
{
  const unknown = normalizeSlangEntry({ content: '根本就没有这种', source: 'manual', count: 1, lastInferenceCount: 1, researchedAt: '2026-09-25T10:08:57.000Z', researchVerdict: 'unknown' });
  assert.equal(unknown.researchVerdict, 'unknown', 'researchVerdict=unknown 被保留');
  assert.equal(unknown.lastInferenceCount, 1, 'lastInferenceCount 被保留（否则会无限重研）');
  assert.equal(unknown.researchedAt, '2026-09-25T10:08:57.000Z');
  assert.equal(normalizeSlangEntry({ content: 'x', researchVerdict: 'confirmed' }).researchVerdict, 'confirmed');
  assert.equal(normalizeSlangEntry({ content: 'x' }).researchVerdict, '', '缺省为空（= 没研究过）');
  assert.equal(normalizeSlangEntry({ content: 'x', researchVerdict: '胡写' }).researchVerdict, '', '未知值回落空');
  // 没有任何释义时 meaning 必须保持空——不能因为研究过就编一个
  assert.equal(unknown.meaning, '', '研究过但无定论时不许编造释义');
  // 触发条件模拟：研究后不应再满足「需要研究」
  const needResearch = (e) => (Number(e.count) || 0) > (Number(e.lastInferenceCount) || 0);
  assert.equal(needResearch(unknown), false, '研究过之后不再满足重研条件');
  assert.equal(needResearch({ count: 2, lastInferenceCount: 1 }), true, '有了新的群聊证据（count 增加）才再研究一次');
  ok('研究结论标记：unknown 可持久化且能止住「无限重研」');
}

// ── 否定结论不能当释义 ────────────────────────────────────────────────────
// 线上问题：让 AI 研究「你只是怕了」，B站明明有（7.9 万播放的视频 + 高赞评论就是这个词），
// 但研究只用了 Bing + 萌娘百科，于是模型回了「未确认（未发现它被收录为固定网络梗）…」，
// 这句话被当成 meaning 写进词库并转正 —— 既污染提示词（等于告诉 AI「这词没含义」），
// 又把真正的释义永久挡住。现在两个防线：① 研究时桥接先喂 B站 证据；② 否定结论一律不算释义。
{
  for (const bad of [
    '未确认（未发现它被收录为固定网络梗）。字面含义是激将…',
    '未发现相关收录',
    '没有收录或出处记录',
    '查无此梗',
    '不确定它是不是网络用语'
  ]) {
    assert.equal(looksLikeNegativeFinding(bad), true, `应判为否定结论：${bad.slice(0, 20)}`);
  }
  for (const good of [
    '激将法最典型的句式：不去反驳对方的理由，而是把原因归结为「你怕了」',
    '《BanG Dream!》企划下的乐队；中文圈也叫「邦邦」',
    ''
  ]) {
    assert.equal(looksLikeNegativeFinding(good), false, `不该误判：${good.slice(0, 20)}`);
  }
  // B站证据要真的进提示词
  const prompt = buildResearchPrompt(
    [{ content: '你只是怕了', evidence: [{ text: '别找理由了' }] }],
    { biliEvidence: { '你只是怕了': '视频《什么叫根本就没有这种生活，你只是怕了》（播放 79405）\n评论（335 赞）：你只是怕了[doge]' } }
  );
  assert.match(prompt, /【B站证据/, '带 B站证据段');
  assert.match(prompt, /播放 79405/, '带真实播放量');
  assert.match(prompt, /只活在 B站/, '点明「Bing 查不到不等于不是梗」');
  assert.match(prompt, /不要把「未确认／未发现收录」这类\*\*否定结论写进 meaning\*\*/, '明确禁止把否定结论当释义');
  // 没有证据时不硬塞这个段落
  assert.ok(!/【B站证据/.test(buildResearchPrompt([{ content: 'x' }])), '没证据就不加段');
  ok('B站证据进提示词 + 否定结论不当释义');
}

console.log(`\n🎉 黑话学习新增逻辑测试通过（${passed} 项）`);
