// 本地向量检索（RAG）回归测试。
//
// 分两部分：
//   A. 离线纯逻辑（不需要模型）：哈希/余弦/重建计划/会话维度/资格线/相对判据/补位/渲染
//   B. 在线端到端（需要 models/ 下的模型，缺了就跳过）：真的编码 + 真的语义区分度
//
// 用法：node scripts/test-rag-retrieval.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  entryHash, entryText, cosine, planRebuild, deriveByKey, scoreEntries,
  selectForInjection, nearDuplicates, loadVectorStore, saveVectorStore, buildIndex,
  DEFAULT_MIN_COSINE, VECTOR_MODEL
} from '../src/slang-index.js';
import { normalizeSlangEntry, formatSlangTable } from '../src/slang-learner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

console.log('RAG 回归测试\n── A. 离线纯逻辑 ──');

// ── 数据模型 ──────────────────────────────────────────────────────────
ok('normalizeSlangEntry 回填 aliases/tags（老数据无迁移脚本也能用）', () => {
  const e = normalizeSlangEntry({ content: '测试词', meaning: '释义' });
  assert.deepEqual(e.aliases, []);
  assert.deepEqual(e.tags, []);
  const e2 = normalizeSlangEntry({ content: 'x', aliases: ['别名', '别名', ''], tags: ['lol'] });
  assert.deepEqual(e2.aliases, ['别名'], '应去重去空');
  assert.deepEqual(e2.tags, ['lol']);
});

ok('entryText 拼上释义（释义是检索质量的主要来源）', () => {
  assert.equal(entryText({ content: '哈基米', meaning: '猫的代称', usage: '玩梗' }), '哈基米：猫的代称：玩梗');
});

// ── 哈希与重建计划 ────────────────────────────────────────────────────
ok('释义变了 → 哈希变 → 计划重建', () => {
  const a = { id: '1', content: 'a', meaning: '旧' };
  const b = { id: '1', content: 'a', meaning: '新' };
  assert.notEqual(entryHash(a), entryHash(b));
  const store = { model: VECTOR_MODEL, dim: 2, builtAt: '', vectors: { 1: { h: entryHash(a), v: [1, 0] } } };
  assert.equal(planRebuild([a], store).toEmbed.length, 0, '没变不该重建');
  assert.equal(planRebuild([b], store).toEmbed.length, 1, '变了必须重建');
});

ok('无释义的条目不进索引；删掉的条目变成孤儿被清理', () => {
  const noMeaning = { id: '2', content: 'x', meaning: '' };
  const store = { model: VECTOR_MODEL, dim: 2, builtAt: '', vectors: { gone: { h: 'x', v: [1, 0] } } };
  const plan = planRebuild([noMeaning], store);
  assert.equal(plan.toEmbed.length, 0);
  assert.deepEqual(plan.orphans, ['gone']);
});

ok('换了模型 → 整个索引作废（避免不同模型的向量互算余弦）', () => {
  const f = '/tmp/rag-test-vectors.json';
  fs.writeFileSync(f, JSON.stringify({ model: 'other-model', dim: 2, vectors: { a: { h: 'x', v: [1, 0] } } }));
  const store = loadVectorStore(f);
  assert.equal(Object.keys(store.vectors).length, 0);
  fs.unlinkSync(f);
});

// ── 会话维度 ──────────────────────────────────────────────────────────
ok('deriveByKey 从 evidence 推出每个会话的次数与最近时间', () => {
  const e = {
    evidence: [
      { key: 'group:1', time: 100 },
      { key: 'group:1', time: 300 },
      { key: 'group:2', time: 200 },
      { time: 999 }            // 没有 key 的（AI 提交但未归属）应被忽略
    ]
  };
  const by = deriveByKey(e);
  assert.equal(by['group:1'].count, 2);
  assert.equal(by['group:1'].lastAt, 300);
  assert.equal(by['group:2'].count, 1);
});

ok('会话维度参与打分：本群出现过的词分数更高', () => {
  const entries = [{ id: 'a', content: 'A', meaning: 'm', count: 1, evidence: [{ key: 'g', time: Date.now() }] }];
  const store = { model: VECTOR_MODEL, dim: 2, vectors: { a: { h: entryHash(entries[0]), v: [1, 0] } } };
  const args = { queryVec: [1, 0], entries, store, minCosine: 0 };
  const inConv = scoreEntries({ ...args, key: 'g' })[0];
  const outConv = scoreEntries({ ...args, key: 'other' })[0];
  assert.ok(inConv.score > outConv.score, `本群(${inConv.score}) 应高于外部(${outConv.score})`);
  assert.equal(inConv.conv, 1);
  assert.equal(outConv.conv, 0);
});

// ── 资格线与相对判据 ──────────────────────────────────────────────────
const mkStore = (pairs) => ({
  model: VECTOR_MODEL, dim: 2, builtAt: '',
  vectors: Object.fromEntries(pairs.map(([id, v]) => [id, { h: 'h' + id, v }]))
});
const mkEntries = (...ids) => ids.map((id) => ({ id, content: id, meaning: 'm', count: 1 }));
const vec = (cos) => [cos, Math.sqrt(Math.max(0, 1 - cos * cos))]; // 与 [1,0] 的余弦 = cos

ok('资格线：低于 minCosine 的条目一个都不进（会话维度不再豁免）', () => {
  const entries = mkEntries('hi', 'lo');
  const store = mkStore([['hi', vec(0.9)], ['lo', vec(0.2)]]);
  const r = scoreEntries({ queryVec: [1, 0], entries, store, key: 'g', minCosine: 0.5 });
  assert.deepEqual(r.map((x) => x.entry.id), ['hi']);
});

ok('相对判据：只保留离 top-1 不超过 relativeMargin 的条目', () => {
  const entries = mkEntries('top', 'near', 'far');
  const store = mkStore([['top', vec(0.9)], ['near', vec(0.85)], ['far', vec(0.6)]]);
  const { picked } = selectForInjection({
    queryVec: [1, 0], entries, store, key: 'g', max: 8, minFill: 0, minCosine: 0.5, relativeMargin: 0.08
  });
  assert.deepEqual(picked.map((p) => p.entry.id), ['top', 'near'], 'far(0.6) 应被 margin 挡掉');
});

ok('minFill 补位：相关条目不够时用本群高频补齐，且不重复', () => {
  const entries = [
    { id: 'hit', content: 'hit', meaning: 'm', count: 1, evidence: [{ key: 'g', time: Date.now() }] },
    { id: 'freq', content: 'freq', meaning: 'm', count: 9, evidence: [{ key: 'g', time: Date.now() }] }
  ];
  const store = mkStore([['hit', vec(0.9)], ['freq', vec(0.05)]]);
  const { picked } = selectForInjection({
    queryVec: [1, 0], entries, store, key: 'g', max: 8, minFill: 2, minCosine: 0.5
  });
  assert.deepEqual(picked.map((p) => p.entry.id), ['hit', 'freq']);
  assert.ok(picked[1].filler, '第二条应是补位');
  assert.equal(new Set(picked.map((p) => p.entry.id)).size, picked.length, '不能重复');
});

ok('无释义条目不参与（否则会注入空条目）', () => {
  const entries = [{ id: 'x', content: 'x', meaning: '', count: 1 }];
  const store = mkStore([['x', vec(0.99)]]);
  // planRebuild 会把它排除，所以索引里不该有它
  assert.equal(planRebuild(entries, store).toEmbed.length, 0);
});

ok('formatSlangTable 渲染格式稳定（提示词只有一份渲染逻辑）', () => {
  const s = formatSlangTable([{ content: '哈基米', meaning: '猫的代称', usage: '玩梗', example: '这不是猫' }]);
  assert.match(s, /【群聊黑话表】/);
  assert.match(s, /- 哈基米：猫的代称（用法：玩梗）（例：这不是猫）/);
  assert.equal(formatSlangTable([]), '');
});

ok('nearDuplicates 找出近义对（用于控制台人工审核）', () => {
  const entries = mkEntries('色图', '涩图', '量子速读');
  const store = mkStore([['色图', vec(1)], ['涩图', vec(0.95)], ['量子速读', vec(0.1)]]);
  const pairs = nearDuplicates({ entries, store, threshold: 0.9 });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].sim.toFixed(2), '0.95');
});

// ── B. 在线端到端 ─────────────────────────────────────────────────────
console.log('\n── B. 在线端到端（需要本地模型）──');
const modelDir = path.join(ROOT, 'models', VECTOR_MODEL, 'onnx', 'model_quantized.onnx');
if (!fs.existsSync(modelDir)) {
  console.log('  ⏭  跳过：本地模型不存在，先运行 node scripts/fetch-embed-model.mjs');
} else {
  const { EmbeddingClient } = await import('../src/embedding-client.js');
  const client = new EmbeddingClient({ timeoutMs: 5000, log: () => {} });
  try {
    await client.start();
    console.log(`  ✓ embedder 就绪 dim=${client.info.dim} 常驻=${client.info.mem?.rssMB}MB`);
    pass++;

    const [v1, v2, v3] = await client.embed(['哈基米', '哈鸡米', '恒生科技指数今天走势']);
    const near = cosine(v1, v2);
    const far = cosine(v1, v3);
    ok(`变体归一：哈基米~哈鸡米(${near.toFixed(3)}) 明显高于 哈基米~无关(${far.toFixed(3)})`, () => {
      assert.ok(near > far + 0.2, `差距不够大：${near.toFixed(3)} vs ${far.toFixed(3)}`);
      assert.ok(near >= 0.5, `变体相似度应达到链接门槛 0.5，实际 ${near.toFixed(3)}`);
    });

    ok('向量已归一化（余弦 = 点积，且模长为 1）', () => {
      const norm = Math.sqrt(v1.reduce((s, x) => s + x * x, 0));
      assert.ok(Math.abs(norm - 1) < 0.01, `模长 ${norm}`);
    });

    const store = { model: VECTOR_MODEL, dim: 0, builtAt: '', vectors: {} };
    const entries = [
      { id: 'a', content: '电击小子', meaning: '被电到的玩笑说法' },
      { id: 'b', content: '恒生科技', meaning: '香港科技股指数' }
    ];
    const t0 = Date.now();
    const res = await buildIndex({ entries, client, store, batch: 8 });
    ok(`buildIndex 真的写入向量（${res.embedded} 条 / ${Date.now() - t0}ms）`, () => {
      assert.equal(res.embedded, 2);
      assert.equal(Object.keys(store.vectors).length, 2);
      assert.ok(store.vectors.a.v.length >= 64);
    });
    const tmp = '/tmp/rag-test-store.json';
    saveVectorStore(tmp, store);
    ok('向量库可保存并读回', () => {
      const back = loadVectorStore(tmp);
      assert.equal(Object.keys(back.vectors).length, 2);
      fs.unlinkSync(tmp);
    });
  } catch (error) {
    console.error(`  ✗ 端到端失败：${error?.message ?? error}`);
    process.exitCode = 1;
  } finally {
    client.stop();
  }
}

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : '，全部通过 ✅'}`);
