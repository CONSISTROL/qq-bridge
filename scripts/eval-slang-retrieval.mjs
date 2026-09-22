// 黑话检索评测：拿 evidence 里的真实群消息当查询集，量「该词条有没有被选进注入表」。
//
// 为什么这个评测必须有：
//   向量检索的效果不能靠感觉。没有基线数字，就无法判断上 RAG 到底值不值得，
//   也调不了 minCosine / topK 这些参数。这套评测集是从库里现成的真实消息来的，
//   零额外标注成本。
//
// 三组对比：
//   baseline    —— 当前实现在跑的「全库按出现次数取 top-8」，与查询无关
//   vector+key  —— 向量检索 + 会话维度加权（线上就是这套）
//   vector-only —— 纯语义、不给会话信息（用来分离「语义」和「会话维度」各自的贡献）
//
// 用法：
//   node scripts/eval-slang-retrieval.mjs
//   node scripts/eval-slang-retrieval.mjs --topk=8 --rebuild
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EmbeddingClient } from '../src/embedding-client.js';
import {
  loadVectorStore, saveVectorStore, buildIndex, selectForInjection,
  scoreEntries, nearDuplicates, entryText
} from '../src/slang-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLANG = path.join(ROOT, 'state', 'slang.json');
const VECFILE = path.join(ROOT, 'state', 'slang-vectors.json');

const args = new Map(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const TOPK = Math.max(1, Number(args.get('topk') || 8));
const log = (...a) => console.log(...a);

const entries = JSON.parse(fs.readFileSync(SLANG, 'utf8'));
const confirmed = entries.filter((e) => e.status === 'confirmed' && e.content && String(e.meaning || '').trim());
log(`黑话库：${entries.length} 条，其中可检索的已确认条目 ${confirmed.length} 条\n`);

// ── 评测集：从 evidence 里的真实消息构造 ──────────────────────────────
function buildEvalSet() {
  const seen = new Set();
  const rows = [];
  for (const e of confirmed) {
    for (const ev of (e.evidence || [])) {
      const q = String(ev?.text || '').trim();
      if (q.length < 2) continue;
      const dedupeKey = `${e.id}\u0001${q}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const content = String(e.content).trim();
      // 「字面命中」= 消息里真的出现了这个词（词法匹配也该找到）
      // 「非字面」= 消息里没有这个词，只能靠语义/会话维度找到 ← 这才是向量的价值所在
      const literal = q.toLowerCase().includes(content.toLowerCase());
      rows.push({ entry: e, query: q, key: String(ev.key || ''), literal });
    }
  }
  return rows;
}
const EVAL = buildEvalSet();
const literalN = EVAL.filter((r) => r.literal).length;
log(`评测集 A：${EVAL.length} 条真实消息（覆盖 ${new Set(EVAL.map((r) => r.entry.id)).size} 个词条）`);
log(`  字面命中 ${literalN} 条 / 非字面 ${EVAL.length - literalN} 条`);
if (EVAL.length - literalN === 0) {
  log('  ⚠️  全部是字面命中：这一组只能证明「向量排序优于按频次取前 8」，');
  log('     不能证明它优于词法匹配（词法在字面集上同样能到 100%）。语义收益看下面评测集 B。');
}

// 评测集 B：手写的「非字面」查询——消息里不出现目标词，只能靠语义找。
// 这是向量唯一不可替代的场景；样本少且带主观性，只作方向性参考。
// expect 里任何一条命中即算对（同一个意思常有多个词条）。
const CURATED = [
  { q: '他名字念起来像日语里那个下流的词', expect: ['欧金金'] },
  { q: '翻书翻得飞快，等于没看', expect: ['量子速读'] },
  { q: '被笔记本外壳电了一下，麻了', expect: ['电击小子'] },
  { q: '港股科技板块今天表现怎么样', expect: ['恒生科技'] },
  { q: '短期均线穿过长期均线了，是买点吗', expect: ['金叉'] },
  { q: '上班上到整个人都麻了', expect: ['班味'] },
  { q: '来点擦边的二次元图', expect: ['涩图', '色图', '黄图'] },
  { q: '我家猫猫头特别圆', expect: ['哈基米', '圆头耄耋'] },
  { q: 'LOL 上单谁对线最凶', expect: ['ig theshy', 'blg bin'] },
  { q: '只有机器人管理员才有权限开这个', expect: ['owner', '群主'] },
  { q: '阴阳怪气地夸人，满嘴跑火', expect: ['小嘴抹了蜜', '嘴欠型'] },
  { q: '这些玩法过时了没人用了', expect: ['退环境'] },
  { q: '直播间都在复读主播那句外号', expect: ['炫狗'] },
  { q: '把上下文压缩一下省点 token', expect: ['压缩上下文'] },
];
function buildCurated() {
  const byContent = new Map(confirmed.map((e) => [String(e.content).trim().toLowerCase(), e]));
  const rows = [];
  for (const c of CURATED) {
    const targets = c.expect.map((x) => byContent.get(x.toLowerCase())).filter(Boolean);
    if (!targets.length) continue;
    rows.push({ query: c.q, targets, ids: new Set(targets.map((t) => t.id)) });
  }
  return rows;
}
const CUR = buildCurated();
log(`\n评测集 B：${CUR.length} 条手写非字面查询（消息里不含目标词）`);


// ── baseline：当前实现（按出现次数取 top-8，与查询无关） ───────────────
const baselinePool = confirmed
  .slice()
  .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
  .slice(0, TOPK);
const baselineIds = new Set(baselinePool.map((e) => e.id));

// ── 起 embedder、建索引 ───────────────────────────────────────────────
const client = new EmbeddingClient({ log: (m) => log(m), timeoutMs: 3000 });
const started = Date.now();
await client.start();
const info = client.info;
log(`\nembedder：dim=${info.dim} 加载=${info.loadMs}ms 常驻=${info.mem?.rssMB}MB 峰值=${info.mem?.peakMB}MB`);

const store = loadVectorStore(VECFILE);
if (args.get('rebuild') === 'true') store.vectors = {};
const t0 = Date.now();
const built = await buildIndex({
  entries: confirmed, client, store, batch: 8,
  onProgress: (d, t) => { if (d === t || d % 24 === 0) log(`  编码 ${d}/${t}`); }
});
saveVectorStore(VECFILE, store);
const probe = await client.probe();
log(`索引：本次编码 ${built.embedded} 条，清理孤儿 ${built.orphans} 条，库内共 ${built.total} 条向量`
  + `（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
log(`      维度 ${store.dim}，文件 ${(fs.statSync(VECFILE).size / 1024).toFixed(0)}KB，`
  + `embedder 峰值 ${probe?.mem?.peakMB ?? '?'}MB`);

// ── 逐条评测 ──────────────────────────────────────────────────────────
log('\n计算查询向量…');
const queryVecs = [];
const uniqQueries = [...new Set(EVAL.map((r) => r.query))];
const qvMap = new Map();
for (let i = 0; i < uniqQueries.length; i += 16) {
  const chunk = uniqQueries.slice(i, i + 16);
  const vs = await client.embed(chunk);
  chunk.forEach((q, k) => qvMap.set(q, vs[k]));
}
for (const r of EVAL) queryVecs.push(qvMap.get(r.query));

const literalIdx = EVAL.map((r, i) => (r.literal ? i : -1)).filter((i) => i >= 0);
const nonLiteralIdx = EVAL.map((r, i) => (r.literal ? -1 : i)).filter((i) => i >= 0);
function evaluateWithSubsets(pickFn) {
  const flags = EVAL.map((row, i) => pickFn(row, queryVecs[i]).has(row.entry.id));
  const at = (idx) => (idx.length ? idx.filter((i) => flags[i]).length / idx.length : 0);
  return { all: flags.filter(Boolean).length / EVAL.length, literal: at(literalIdx), nonLiteral: at(nonLiteralIdx) };
}

const rBaseline = evaluateWithSubsets(() => baselineIds);
const rVectorKey = evaluateWithSubsets((row, qv) => new Set(
  selectForInjection({ queryVec: qv, entries: confirmed, store, key: row.key, max: TOPK }).picked.map((p) => p.entry.id)
));
const rVectorOnly = evaluateWithSubsets((row, qv) => new Set(
  selectForInjection({ queryVec: qv, entries: confirmed, store, key: '', max: TOPK, minFill: 0 }).picked.map((p) => p.entry.id)
));

const pct = (x) => `${(x * 100).toFixed(1)}%`;
log(`\n${'='.repeat(64)}`);
log(`召回率（该词条是否被选进注入的 ${TOPK} 条）`);
log(`${'='.repeat(64)}`);
log(`${'方案'.padEnd(16)} ${'总体'.padEnd(10)} ${'字面'.padEnd(10)} 非字面`);
log(`${'-'.repeat(64)}`);
log(`${'baseline'.padEnd(16)} ${pct(rBaseline.all).padEnd(10)} ${pct(rBaseline.literal).padEnd(10)} ${pct(rBaseline.nonLiteral)}`);
log(`${'vector-only'.padEnd(16)} ${pct(rVectorOnly.all).padEnd(10)} ${pct(rVectorOnly.literal).padEnd(10)} ${pct(rVectorOnly.nonLiteral)}`);
log(`${'vector+key'.padEnd(16)} ${pct(rVectorKey.all).padEnd(10)} ${pct(rVectorKey.literal).padEnd(10)} ${pct(rVectorKey.nonLiteral)}`);

log(`\nbaseline 固定注入的 ${TOPK} 条：${baselinePool.map((e) => e.content).join('、')}`);
log(`（这 ${TOPK} 条与查询无关，所以「非字面」那一列必然是 0）`);

// ── 评测集 B：非字面查询，三方对比（基线 / 词法 / 向量）────────────────
const curVecs = [];
for (let i = 0; i < CUR.length; i += 16) {
  const chunk = CUR.slice(i, i + 16);
  const vs = await client.embed(chunk.map((c) => c.query));
  curVecs.push(...vs);
}
const evalStrategy = (fn) => {
  let hit = 0;
  const detail = [];
  CUR.forEach((c, i) => {
    const ok = fn(c, curVecs[i]);
    if (ok) hit++;
    else detail.push(c.query);
  });
  return { rate: hit / CUR.length, hit, detail };
};
const sBaseline = evalStrategy(() => false); // 固定 8 条里不可能包含目标词（这些词条 count 全是 1）
const sLexical = evalStrategy((c) => {
  const q = c.query.toLowerCase();
  return confirmed.some((e) => e.id && c.ids.has(e.id)
    && (q.includes(String(e.content).toLowerCase())
      || (e.aliases || []).some((a) => q.includes(String(a).toLowerCase()))));
});
const sVector = evalStrategy((c, qv) => {
  const picked = new Set(selectForInjection({ queryVec: qv, entries: confirmed, store, key: '', max: TOPK, minFill: 0 }).picked.map((p) => p.entry.id));
  return [...c.ids].some((id) => picked.has(id));
});

log(`\n${'='.repeat(64)}`);
log(`评测集 B 结果（非字面查询，消息里不含目标词）`);
log(`${'='.repeat(64)}`);
log(`  基线（固定 8 条）  ${sBaseline.hit}/${CUR.length}`);
log(`  词法（子串匹配）   ${sLexical.hit}/${CUR.length}   ← 目标词不在消息里，词法天然找不到`);
log(`  向量（语义检索）   ${sVector.hit}/${CUR.length}`);
if (sVector.detail.length) {
  log(`  向量未命中：`);
  for (const q of sVector.detail) log(`    - ${q}`);
}

// ── 具体样例：新旧选词并排 ────────────────────────────────────────────
log(`\n${'='.repeat(64)}`);
log('选词样例对比（查询 → 向量选了谁）');
log(`${'='.repeat(64)}`);
const samples = EVAL.filter((r) => r.literal).slice(0, 6);
for (const row of samples) {
  const i = EVAL.indexOf(row);
  const ranked = scoreEntries({ queryVec: queryVecs[i], entries: confirmed, store, key: row.key }).slice(0, 4);
  log(`\n「${row.query.slice(0, 40)}」  期望词条：${row.entry.content}`);
  for (const r of ranked) {
    const mark = r.entry.id === row.entry.id ? '✅' : '  ';
    log(`  ${mark} ${r.sem.toFixed(3)} sem  conv=${r.conv}  score=${r.score.toFixed(3)}  ${r.entry.content}`);
  }
}

// ── 近义聚类（给控制台审核用） ────────────────────────────────────────
const dup = nearDuplicates({ entries: confirmed, store, threshold: 0.62, limit: 8 });
log(`\n${'='.repeat(64)}`);
log(`近义聚类（余弦 ≥0.62，共 ${dup.length} 对，展示前 8）`);
log(`${'='.repeat(64)}`);
for (const p of dup) log(`  ${p.sim.toFixed(3)}  ${p.a.content}  ~  ${p.b.content}`);

client.stop();
