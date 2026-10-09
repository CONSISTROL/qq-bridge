// 主题探索（自主扩展学习）的纯逻辑单测：提示词、JSON 容错解析、队列预算/去重、持久化归一。
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../src/topic-explore.js';

// 纯函数单测：不碰桥接、不碰网络、不碰真实状态目录。
void path; void fileURLToPath;
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✅', name); } catch (e) { fail++; console.log('  ❌', name, '—', e.message); } };

console.log('## 规范化与去重');
t('别名/大小写/标点归一为同一个 key', () => {
  assert.equal(E.normalizeTopicKey('MyGO!!!!!'), 'mygo');
  assert.equal(E.normalizeTopicKey('mygo'), 'mygo');
  assert.equal(E.normalizeTopicKey(' my go '), 'mygo');
  assert.equal(E.normalizeTopicKey('ＭｙＧＯ'), 'mygo', '全角也要归一');
});
t('关联主题与已访问去重', () => {
  const r = E.normalizeRelatedTopics([{name:'MyGO!!!!!'},{name:'Ave Mujica'},{name:'ave mujica'},{name:''}], { excludeKeys:['mygo'] });
  assert.equal(r.length, 1); assert.equal(r[0].name, 'Ave Mujica');
});

console.log('## 解析容错');
t('裸 JSON', () => {
  const p = E.parseTopicResearchJson('{"topic":{"name":"MyGO!!!!!"},"terms":[{"content":"春日影","meaning":"..."}],"related":[{"name":"Ave Mujica"}]}');
  assert.equal(p.topic.name, 'MyGO!!!!!'); assert.equal(p.topic.key, 'mygo');
  assert.equal(p.terms.length, 1); assert.equal(p.related[0].name, 'Ave Mujica');
});
t('```json 围栏 + 前后夹带人话', () => {
  const text = '好的，我查到了：\n```json\n{"topic":{"name":"mygo","summary":"乐队企划"},"terms":[]}\n```\n需要我继续挖吗？';
  const p = E.parseTopicResearchJson(text);
  assert.equal(p.topic.name, 'mygo'); assert.equal(p.topic.summary, '乐队企划');
});
t('解析失败返回 null（不许编造）', () => {
  assert.equal(E.parseTopicResearchJson('抱歉我没查到'), null);
  assert.equal(E.parseTopicResearchJson(''), null);
  assert.equal(E.parseTopicResearchJson('{"topic":{}}'), null, '没有主题名视为无效');
});
t('只有非 http(s) 的 sources 会被丢掉', () => {
  const p = E.parseTopicResearchJson('{"topic":{"name":"x"},"terms":[{"content":"a","sources":["javascript:alert(1)","https://zh.moegirl.org.cn/x","ftp://x"]}]}');
  assert.deepEqual(p.terms[0].sources, ['https://zh.moegirl.org.cn/x']);
});
t('terms/related 数量封顶', () => {
  const many = Array.from({length:40},(_,i)=>({content:'t'+i}));
  const p = E.parseTopicResearchJson(JSON.stringify({topic:{name:'x'},terms:many,related:many.map((_,i)=>({name:'r'+i}))}));
  assert.ok(p.terms.length <= E.MAX_TERMS_PER_TOPIC, 'terms 上限');
  assert.ok(p.related.length <= E.MAX_RELATED_PER_TOPIC, 'related 上限');
});

console.log('## 队列与预算');
t('深度超限不再排队', () => {
  const job = E.createExploreJob({ seed: 'mygo', maxDepth: 1, maxTopics: 15 });
  assert.equal(E.enqueueRelatedTopics(job, [{name:'a',key:'a'}], 2).length, 0, '第 2 层不排');
  assert.equal(E.enqueueRelatedTopics(job, [{name:'a',key:'a'}], 1).length, 1, '第 1 层可排');
});
t('主题总数上限卡死（含已访问 + 队列）', () => {
  const job = E.createExploreJob({ seed: 'mygo', maxDepth: 2, maxTopics: 3 });
  E.enqueueRelatedTopics(job, [{name:'a',key:'a'},{name:'b',key:'b'},{name:'c',key:'c'},{name:'d',key:'d'}], 1);
  // 种子里还躺在队列里（没被消费），所以不变式是「已访问 + 队列 ≤ maxTopics」：
  // 种子 1 + 新增 2 = 3。
  assert.equal(job.queue.length, 3, '种子占 1 个额度，队列只能再装 2 个');
  assert.ok(job.visited.length + job.queue.length <= job.maxTopics, '总量不超上限');
});
t('队列内不重复排队', () => {
  const job = E.createExploreJob({ seed: 's', maxDepth: 2, maxTopics: 15 });
  E.enqueueRelatedTopics(job, [{name:'a',key:'a'}], 1);
  E.enqueueRelatedTopics(job, [{name:'A!!!',key:'a'}], 1);
  assert.equal(job.queue.filter(x=>x.key==='a').length, 1);
});
t('已访问的不会再排队', () => {
  const job = E.createExploreJob({ seed: 's', maxDepth: 2, maxTopics: 15 });
  E.markTopicVisited(job, { name:'a', key:'a', depth:1, topic:{name:'a'}, terms:[], related:[] });
  assert.equal(E.enqueueRelatedTopics(job, [{name:'a',key:'a'}], 1).length, 0);
});
t('peekNextTopic 广度优先（先浅后深）并在耗尽后返回 null', () => {
  const job = E.createExploreJob({ seed: 's', maxDepth: 2, maxTopics: 3 });
  E.enqueueRelatedTopics(job, [{name:'deep',key:'deep'}], 2);
  E.enqueueRelatedTopics(job, [{name:'shallow',key:'shallow'}], 1);
  assert.equal(E.peekNextTopic(job).key, 's');
  E.shiftTopic(job, 's'); E.markTopicVisited(job,{name:'s',key:'s',depth:0,topic:{name:'s'},terms:[],related:[]});
  assert.equal(E.peekNextTopic(job).key, 'shallow', '浅层优先于深层');
  E.shiftTopic(job,'shallow'); E.markTopicVisited(job,{name:'shallow',key:'shallow',depth:1,topic:{name:'shallow'},terms:[],related:[]});
  assert.equal(E.peekNextTopic(job).key, 'deep', 'maxTopics=3 时第 3 个额度还能用');
  E.shiftTopic(job,'deep'); E.markTopicVisited(job,{name:'deep',key:'deep',depth:2,topic:{name:'deep'},terms:[],related:[]});
  assert.equal(E.peekNextTopic(job), null, '到 maxTopics 后没有下一个');
  assert.equal(E.jobExhausted(job), true);
});

console.log('## 提示词');
t('提示词带主题、输出契约、来源要求、去重清单', () => {
  const p = E.buildTopicResearchPrompt({ name:'mygo', depth:0, seed:'mygo', knownTerms:['春日影','为什么要演奏春日影'] });
  assert.match(p, /【本次要摸的主题】mygo/);
  assert.match(p, /"content": "梗\/黑话的原文/);
  assert.match(p, /真的抓取过/);
  assert.match(p, /已知词条：.*春日影/);
  assert.match(p, /最多 12 条/);
});
t('第 2 层会说明来源与层级', () => {
  const p = E.buildTopicResearchPrompt({ name:'Ave Mujica', why:'同企划姊妹乐队', depth:1, seed:'mygo' });
  assert.match(p, /它是怎么被关联进来的】同企划姊妹乐队/);
  assert.match(p, /第 1 层关联/);
});

console.log('## 持久化归一');
t('损坏/旧版 job 能安全归一', () => {
  const j = E.normalizeJob({ id:'x', seed:'mygo', status:'weird', maxDepth:'2', maxTopics:'15',
    queue:[{name:'a',depth:'1'},{bad:1}], visited:[{key:'k',name:'n'}], stats:{terms:'3'}, log:[{text:'hi'}] });
  assert.equal(j.status, 'pending', '未知状态回落');
  assert.equal(j.maxDepth, 2); assert.equal(j.queue.length, 1); assert.equal(j.visited.length, 1);
  assert.equal(j.stats.terms, 3); assert.equal(j.log.length, 1);
  assert.equal(E.normalizeJob(null), null);
  assert.equal(E.normalizeJob({seed:''}), null);
});
t('进度行可读', () => {
  const job = E.createExploreJob({ seed:'mygo', maxTopics:15 });
  E.markTopicVisited(job,{name:'MyGO!!!!!',key:'mygo',depth:0,topic:{name:'MyGO!!!!!'},terms:[{content:'a',confirmed:true}],related:[]});
  assert.match(E.formatJobProgress(job), /mygo：pending｜已探 1\/15 个主题｜梗 1 条（确认 1）/);
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
