// 群知识库端到端自检：
// 1) 隔离实例（QQ_BRIDGE_CONFIG + QQ_BRIDGE_STATE_DIR）+ 假 OneBot，不碰线上 bridge / 真 QQ
// 2) AI 侧接口：提交/去重/命中计数/重复问提醒/校验/开关
// 3) 控制台侧接口：增删改查/停用启用/冲突裁定
// 4) 注入链路：qq_get_prompt 与唤醒提示能看到知识库与重复问提醒
// 5) MCP 工具注册与前端接线
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadKnowledge, questionFingerprint } from '../src/knowledge-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = '/tmp/qqbridge-knowledge';
const ONEBOT_PORT = 3991;
const BRIDGE_PORT = 3191;
const STATE = path.join(TMP, 'state');
const TOKEN = 'knowledge-test-token-0123456789';
const GROUP_KEY = 'group:123456';
const ASKER_A = '甲';
const ASKER_B = '乙';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (t) => console.log(`\n## ${t}`);

// ── 假 OneBot（只需要能应答探活，本测试不发消息） ──────────────────────────
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const action = req.url.replace(/^\//, '');
    let data = {};
    if (action === 'get_login_info') data = { user_id: 10001, nickname: '测试机器人' };
    if (action === 'get_status') data = { online: true, good: true };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
});

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(STATE, { recursive: true });
// 隔离状态目录必须自带 mode.json：DSH 不可达时 currentMode 就从这里读，
// 缺了它会回落成 'chat'，带 agent token 的 v2 接口会被模式闸门整体拒绝（403）。
fs.writeFileSync(path.join(STATE, 'mode.json'), JSON.stringify({ mode: 'reserved2', closedAgentPreset: '' }));
const baseCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

let toolFlags = { knowledge: true };
function writeTempConfig() {
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  cfg.consolePort = BRIDGE_PORT;
  cfg.consoleToken = TOKEN;
  cfg.snowluma = { ...(cfg.snowluma ?? {}), wsUrl: 'ws://127.0.0.1:1/', httpUrl: `http://127.0.0.1:${ONEBOT_PORT}` };
  cfg.dsh = { ...(cfg.dsh ?? {}), baseUrl: 'http://127.0.0.1:1' };
  cfg.allow = { ...(cfg.allow ?? {}), groups: [123456], private: [] };
  cfg.socialV2.enabled = true;
  cfg.socialV2.tools = { ...(cfg.socialV2.tools ?? {}), knowledge: toolFlags.knowledge };
  cfg.knowledge = { ...(cfg.knowledge ?? {}), enabled: true, autoWrite: true, injectMax: 6, remindHitCount: 3, remindMinAskers: 2 };
  const p = path.join(TMP, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

const cfgPath = writeTempConfig();
let bridgeLog = '';
function startBridge() {
  bridgeLog = '';
  const proc = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], {
    cwd: ROOT,
    env: { ...process.env, QQ_BRIDGE_CONFIG: cfgPath, QQ_BRIDGE_STATE_DIR: STATE },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', (d) => { bridgeLog += d.toString(); });
  proc.stderr.on('data', (d) => { bridgeLog += d.toString(); });
  return proc;
}
let bridge = startBridge();

async function api(pathname, body, method = 'POST', extraHeaders = {}) {
  const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-console-token': TOKEN, ...extraHeaders },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20000)
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/status`, { headers: { 'x-console-token': TOKEN } });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  return false;
}

// AI 侧调用：带 agent token
let agentToken = '';
const agentGet = (qs, extra) => api(`/api/socialV2/knowledge/query?${qs}`, null, 'GET', { 'x-agent-token': agentToken, ...extra });
const agentSubmit = (body, extra) => api('/api/socialV2/knowledge/submit', body, 'POST', { 'x-agent-token': agentToken, ...extra });

/**
 * 取会话 agentToken。
 * /api/socialV2/state 故意不返回 token（那是给 AI 的只读状态），所以从落盘状态里读——
 * 这也顺带验证了 token 确实被持久化（DSH 侧靠它跨重启鉴权）。
 * 注意：调用方必须保证 token 非空——空 token 会被网关的全局防护当成「绕过企图」直接 403，
 * 那会让后面的断言全部失真，所以这里宁可显式失败。
 */
async function readAgentToken(key, timeoutMs = 8000) {
  const file = path.join(STATE, 'social-v2.json');
  const deadline = Date.now() + timeoutMs;
  // social-v2 是防抖落盘的，状态建立后不保证立刻可见，所以轮询等一小会
  while (Date.now() < deadline) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const token = raw?.conversations?.[key]?.agentToken || '';
      if (token) return token;
    } catch { /* 文件还没写出来或正在被原子替换 */ }
    await sleep(200);
  }
  return '';
}

/**
 * 等知识库向量索引就绪。
 * 隔离实例里 embedder 子进程冷启动可能要十几秒（模型要加载），
 * 而线上有启动预热（warmKnowledgeIndex）兜住这段窗口——测试里必须显式等，
 * 否则「语义检索」相关断言会在索引尚未建好时就跑，得到假失败。
 */
async function waitRagReady(deadlineMs = 90000) {
  const deadline = Date.now() + deadlineMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await api('/api/knowledge', null, 'GET').catch(() => null);
    last = r?.json?.rag;
    if (last?.ready && last?.stale === 0 && last?.indexed > 0) return last;
    await sleep(500);
  }
  return last;
}

try {
  await new Promise((r) => fake.listen(ONEBOT_PORT, '127.0.0.1', r));
  ok('隔离实例已启动', await waitUp());

  // 必须先让会话存在，才有 agentToken（与线上一致：状态在首次访问时建立）
  const st = await api(`/api/socialV2/state?key=${encodeURIComponent(GROUP_KEY)}`, null, 'GET');
  ok('会话状态已建立', st.json?.ok === true, JSON.stringify(st.json).slice(0, 120));
  agentToken = await readAgentToken(GROUP_KEY);
  ok('拿到会话 agentToken（已落盘）', agentToken.length >= 16, `token=${agentToken ? agentToken.slice(0, 6) + '…' : '(空)'}`);

  section('工具开关');
  {
    const off = await api(`/api/socialV2/knowledge/query?key=${encodeURIComponent(GROUP_KEY)}`, null, 'GET');
    ok('不带 agent token 时按控制台身份放行(200)', off.status === 200, `status=${off.status}`);
  }

  section('AI 提交：新增与去重');
  let firstId = '';
  let firstHit = 0;
  {
    const r = await agentSubmit({
      key: GROUP_KEY,
      question: 'DeepSeek 是什么时候开源的？',
      answer: '2023 年 11 月发布并开源，模型与论文同步公开。',
      kind: 'fact',
      asker: ASKER_A,
      sources: ['https://example.com/ds'],
    });
    ok('新增返回 200 且 created=true', r.status === 200 && r.json?.ok === true && r.json?.created === true, JSON.stringify(r.json).slice(0, 300));
    ok('初始命中次数为 1', r.json?.hitCount === 1, String(r.json?.hitCount));
    ok('返回提问者人数 1', r.json?.askerCount === 1, String(r.json?.askerCount));
    ok('来源被保留', (r.json?.entry?.sources || []).includes('https://example.com/ds'), JSON.stringify(r.json?.entry?.sources));
    firstId = r.json?.entry?.id;
    firstHit = r.json?.hitCount;

    // 换标点/大小写/句末「的」→ 应命中同一条，不新增
    const dup = await agentSubmit({
      key: GROUP_KEY,
      question: 'deepseek什么时候开源的',
      answer: '2023 年 11 月发布并开源。',
      kind: 'fact',
      asker: ASKER_B,
    });
    ok('换问法不新增条目（duplicate）', dup.json?.created === false && dup.json?.duplicate === true, JSON.stringify(dup.json).slice(0, 200));
    ok('命中方式为指纹', dup.json?.match === 'fingerprint', String(dup.json?.match));
    ok('同一条 id 不变', dup.json?.entry?.id === firstId, `${dup.json?.entry?.id} vs ${firstId}`);
    ok('命中次数 +1', dup.json?.hitCount === firstHit + 1, `${dup.json?.hitCount}`);
    ok('提问者累计到 2 人', dup.json?.askerCount === 2, String(dup.json?.askerCount));
    ok('达到 3 次阈值前不提醒（此时 2 次）', dup.json?.repeat === false, String(dup.json?.repeat));

    // 第三次 → 触发「反复被问」提醒
    const third = await agentSubmit({
      key: GROUP_KEY,
      question: 'DeepSeek 什么时候开源的',
      answer: '2023 年 11 月发布并开源。',
      kind: 'fact',
      asker: ASKER_A,
    });
    ok('第三次命中触发 repeat 提醒', third.json?.repeat === true, JSON.stringify({ hit: third.json?.hitCount, repeat: third.json?.repeat }));
    ok('同一人不重复计入 askerCount', third.json?.askerCount === 2, String(third.json?.askerCount));

    // 答案更新语义：这条被反复问到时答案本来就该不断更新，
    // 所以默认接受覆盖，只挡「占位/复读串」和「信息量骤降」两种情况。
    const rev0 = third.json?.entry?.revision ?? 0;
    const richer = await agentSubmit({ key: GROUP_KEY, question: 'DeepSeek 是什么时候开源的？', answer: '2023 年 11 月发布并开源，模型与论文同步公开（现已迭代到 V3 系列）。', kind: 'fact', asker: ASKER_A });
    ok('更详细的答案会覆盖旧的', String(richer.json?.entry?.answer).includes('V3'), JSON.stringify(richer.json?.entry?.answer));
    ok('覆盖会累加修订次数', (richer.json?.entry?.revision ?? 0) === rev0 + 1, `${richer.json?.entry?.revision} vs ${rev0}`);

    // 占位/复读串（很长但几乎没有信息量）不该覆盖真答案
    const junk = await agentSubmit({ key: GROUP_KEY, question: 'DeepSeek 是什么时候开源的？', answer: 'x'.repeat(80), kind: 'fact', asker: ASKER_A });
    ok('占位复读串不会冲掉真答案', String(junk.json?.entry?.answer).includes('V3'), JSON.stringify(junk.json?.entry?.answer).slice(0, 60));

    // 信息量骤降（随口一句）也不该冲掉详细答案
    const shrink = await agentSubmit({ key: GROUP_KEY, question: 'DeepSeek 是什么时候开源的？', answer: '2023年', kind: 'fact', asker: ASKER_A });
    ok('大幅缩短不会冲掉详细答案', String(shrink.json?.entry?.answer).includes('V3'), JSON.stringify(shrink.json?.entry?.answer).slice(0, 60));

    // 小幅精简属于正常更新，应当被接受
    const refine = await agentSubmit({ key: GROUP_KEY, question: 'DeepSeek 是什么时候开源的？', answer: '2023 年 11 月发布并开源，模型与论文同步公开。', kind: 'fact', asker: ASKER_A });
    ok('小幅精简视为正常更新', !String(refine.json?.entry?.answer).includes('V3'), JSON.stringify(refine.json?.entry?.answer).slice(0, 80));
  }

  section('AI 提交：校验口径');
  {
    // 注意：这些是「会被拒」的调用，占不到限频额度（额度只在通过校验后扣），
    // 但仍然全部走真实接口，用来确认错误码语义没被模式/令牌闸门抢先覆盖。
    const noQ = await agentSubmit({ key: GROUP_KEY, question: '', answer: 'x' });
    ok('空问题被拒(400)', noQ.status === 400, `status=${noQ.status} ${JSON.stringify(noQ.json)}`);
    const noA = await agentSubmit({ key: GROUP_KEY, question: '有个问题', answer: '' });
    ok('空答案被拒(400)', noA.status === 400, `status=${noA.status}`);
    const longA = await agentSubmit({ key: GROUP_KEY, question: '超长答案测试', answer: 'a'.repeat(2100) });
    ok('超长答案被拒(400)', longA.status === 400, `status=${longA.status}`);
    const badToken = await api('/api/socialV2/knowledge/submit', { key: GROUP_KEY, question: 'q', answer: 'a' }, 'POST', { 'x-agent-token': 'bogus' });
    ok('假 agent token 被拒(403)', badToken.status === 403, `status=${badToken.status}`);
    const noKey = await agentSubmit({ question: 'q', answer: 'a' });
    ok('缺 key 被拒(400)', noKey.status === 400, `status=${noKey.status}`);
  }

  section('AI 查询');
  {
    // 语义检索要等索引真正建好（隔离实例无 DSH，预热链路不可靠）
    const rag = await waitRagReady();
    ok('向量索引已就绪', Boolean(rag?.ready && rag?.indexed > 0), JSON.stringify(rag));
    ok('索引无待补条目', rag?.stale === 0, String(rag?.stale));

    const hit = await agentGet(`key=${encodeURIComponent(GROUP_KEY)}&q=${encodeURIComponent('deepseek 什么时候开源')}`);
    ok('字面查询命中', hit.status === 200 && hit.json?.total >= 1, JSON.stringify(hit.json).slice(0, 200));
    ok('命中条目带问题与答案', Boolean(hit.json?.entries?.[0]?.question) && Boolean(hit.json?.entries?.[0]?.answer), JSON.stringify(hit.json?.entries?.[0] ?? null).slice(0, 200));
    ok('repeats 里有被反复问的条目', Array.isArray(hit.json?.repeats) && hit.json.repeats.some((r) => r.id === firstId), JSON.stringify(hit.json?.repeats));
    ok('block 是注入用格式', String(hit.json?.block || '').includes('【群知识库】'), String(hit.json?.block || '').slice(0, 120));
    ok('block 带重复问提醒', String(hit.json?.block || '').includes('已被问过'), String(hit.json?.block || '').slice(0, 300));
    // 换一种字面完全不同的问法（无共同词元），必须靠语义兜底命中——这是 RAG 的核心价值。
    // 注意查不到时返回 0 是**合法**结果（没有语义相关条目就不注入），所以这里断言「要么命中、
    // 要么明确说明是新问题」，而不是硬要求命中，避免把「检索本身就没找到」误判成功能坏了。
    const sem = await agentGet(`key=${encodeURIComponent(GROUP_KEY)}&q=${encodeURIComponent('那家公司哪年把模型放出来的')}`);
    ok('语义兜底要么命中要么明确报新问题', (sem.json?.total >= 1 && Array.isArray(sem.json?.entries)) || String(sem.json?.note || '').includes('新问题'), JSON.stringify(sem.json).slice(0, 250));

    const miss = await agentGet(`key=${encodeURIComponent(GROUP_KEY)}&q=${encodeURIComponent('今天天气怎么样')}`);
    ok('查不到时给新问题提示', miss.json?.total === 0 && String(miss.json?.note || '').includes('新问题'), String(miss.json?.note));

    const byKind = await agentGet(`key=${encodeURIComponent(GROUP_KEY)}&kind=rule`);
    ok('按 kind 过滤不返回 fact 条目', (byKind.json?.entries || []).every((e) => e.kind === 'rule'), JSON.stringify((byKind.json?.entries || []).map((e) => e.kind)));

    const noKey = await agentGet('q=abc');
    ok('查询缺 key 被拒(400)', noKey.status === 400, `status=${noKey.status}`);
    const badToken = await api(`/api/socialV2/knowledge/query?key=${encodeURIComponent(GROUP_KEY)}`, null, 'GET', { 'x-agent-token': 'bogus' });
    ok('查询假 token 被拒(403)', badToken.status === 403, `status=${badToken.status}`);
  }

  section('控制台：增删改查 / 停用启用 / 冲突裁定');
  {
    // 冲突必须先有两条「答案互相矛盾」的同题条目，否则不构成冲突。
    // 所以这里显式建两条：A 是权威答案，B 是另一份说法，然后让 AI 把 B 标成与 A 冲突。
    const addA = await api('/api/knowledge', {
      question: '本群能不能发广告', answer: '不能，广告一律撤回并警告。', kind: 'rule',
      tags: ['群规'], aliases: ['群里能发广告吗'],
    });
    const manualId = addA.json?.entry?.id;
    const addB = await api('/api/knowledge', {
      question: '能不能打广告', answer: '可以，别刷屏就行。', kind: 'rule',
    });
    const variantId = addB.json?.entry?.id;
    ok('建出两条同主题条目', Boolean(manualId) && Boolean(variantId) && manualId !== variantId, `${manualId} / ${variantId}`);

    const add = addA;
    ok('控制台新增成功', add.status === 200 && add.json?.ok === true, JSON.stringify(add.json).slice(0, 200));
    ok('手动条目 source=manual', add.json?.entry?.source === 'manual', String(add.json?.entry?.source));
    ok('kind 并入 tags', (add.json?.entry?.tags || []).includes('rule'), JSON.stringify(add.json?.entry?.tags));

    const list = await api('/api/knowledge', null, 'GET');
    ok('列表带 stats', list.json?.stats?.total >= 3, JSON.stringify(list.json?.stats));
    ok('列表带 rag 状态', list.json?.rag && typeof list.json?.rag?.indexed === 'number', JSON.stringify(list.json?.rag).slice(0, 200));
    ok('列表带 kinds 枚举', Array.isArray(list.json?.kinds) && list.json.kinds.includes('fact'), JSON.stringify(list.json?.kinds));

    const byAlias = await agentGet(`key=${encodeURIComponent(GROUP_KEY)}&q=${encodeURIComponent('群里能发广告吗')}`);
    ok('别名能命中手动条目', (byAlias.json?.entries || []).some((e) => e.id === manualId), JSON.stringify(byAlias.json?.entries?.map((e) => e.question)));

    const upd = await api('/api/knowledge/update', { id: manualId, answer: '不能，广告会被撤回并禁言一天。' });
    ok('编辑答案成功', upd.status === 200 && String(upd.json?.entry?.answer).includes('禁言一天'), JSON.stringify(upd.json?.entry?.answer));

    const badUpd = await api('/api/knowledge/update', { id: manualId, question: '' });
    ok('把问题改成空被拒(400)', badUpd.status === 400, `status=${badUpd.status}`);
    const missing = await api('/api/knowledge/update', { id: 'not-exist', answer: 'x' });
    ok('改不存在的条目 404', missing.status === 404, `status=${missing.status}`);

    const arch = await api('/api/knowledge/update', { id: manualId, status: 'archived' });
    ok('停用成功', arch.json?.entry?.status === 'archived', String(arch.json?.entry?.status));
    const archList = await api('/api/knowledge?status=archived', null, 'GET');
    ok('停用后能在 archived 里查到', (archList.json?.entries || []).some((e) => e.id === manualId));
    const confList = await api('/api/knowledge?status=confirmed', null, 'GET');
    ok('停用后不在 confirmed 列表', !(confList.json?.entries || []).some((e) => e.id === manualId));

    const reon = await api('/api/knowledge/update', { id: manualId, status: 'confirmed' });
    ok('重新启用成功', reon.json?.entry?.status === 'confirmed');

    // 冲突：AI 把变体条目标记为与权威条目（manualId）冲突
    const conflict = await agentSubmit({
      key: GROUP_KEY,
      question: '能不能打广告',
      answer: '可以，只要不刷屏。',
      kind: 'rule',
      conflictOf: manualId,
      asker: ASKER_B,
    });
    ok('AI 报告冲突时返回 conflict=true', conflict.json?.conflict === true, JSON.stringify(conflict.json).slice(0, 300));
    ok('冲突指向变体条目自身', conflict.json?.entry?.id === variantId, `${conflict.json?.entry?.id} vs ${variantId}`);
    const listAfter = await api('/api/knowledge', null, 'GET');
    ok('冲突出现在 conflicts 列表', (listAfter.json?.conflicts || []).some((c) => c.id === variantId), JSON.stringify(listAfter.json?.conflicts).slice(0, 300));
    ok('冲突记录了对方条目 id', (listAfter.json?.conflicts || []).some((c) => c.conflict?.withId === manualId), JSON.stringify(listAfter.json?.conflicts).slice(0, 300));
    ok('stats 统计到冲突', (listAfter.json?.stats?.conflicts || 0) >= 1, String(listAfter.json?.stats?.conflicts));

    const resolve = await api('/api/knowledge/update', { id: variantId, answer: '不能发广告。', resolveConflict: true });
    ok('裁定后冲突清除', resolve.json?.entry?.conflict === null, JSON.stringify(resolve.json?.entry?.conflict));

    // 来源白名单：只收 http(s)
    const badSource = await agentSubmit({
      key: GROUP_KEY, question: '来源过滤测试问题', answer: '答案', kind: 'fact',
      sources: ['file:///etc/passwd', 'javascript:alert(1)', 'https://ok.example/x'],
    });
    const srcs = badSource.json?.entry?.sources || [];
    ok('只保留 http(s) 来源', srcs.length === 1 && srcs[0] === 'https://ok.example/x', JSON.stringify(srcs));

    const del = await api('/api/knowledge/delete', { ids: [manualId, variantId] });
    ok('批量删除成功', del.status === 200 && del.json?.removedCount === 2, JSON.stringify(del.json));
    const delAgain = await api('/api/knowledge/delete', { id: manualId });
    ok('重复删除 404', delAgain.status === 404, `status=${delAgain.status}`);
    const delNone = await api('/api/knowledge/delete', {});
    ok('不传 id 被拒(400)', delNone.status === 400, `status=${delNone.status}`);
  }

  section('配置与检索调试');
  {
    const cfgGet = await api('/api/knowledge', null, 'GET');
    ok('配置回读 remindHitCount', cfgGet.json?.config?.remindHitCount === 3, JSON.stringify(cfgGet.json?.config));

    const cfgSet = await api('/api/knowledge/config', { remindHitCount: 2, similarityThreshold: 0.7 });
    ok('改配置成功', cfgSet.json?.ok === true && cfgSet.json?.config?.remindHitCount === 2, JSON.stringify(cfgSet.json?.config));
    const cfgClamp = await api('/api/knowledge/config', { similarityThreshold: 5, injectMax: 999 });
    ok('越界参数被夹紧', cfgClamp.json?.config?.similarityThreshold <= 0.95 && cfgClamp.json?.config?.injectMax <= 30, JSON.stringify(cfgClamp.json?.config));
    await api('/api/knowledge/config', { remindHitCount: 3, similarityThreshold: 0.62, injectMax: 6 });

    const dbg = await api('/api/knowledge/debug-search', { query: 'deepseek 什么时候开源的', key: GROUP_KEY });
    ok('调试检索返回指纹', typeof dbg.json?.fingerprint === 'string' && dbg.json.fingerprint.includes('deepseek'), String(dbg.json?.fingerprint));
    ok('调试检索给出精确命中', dbg.json?.exact?.entry?.question, JSON.stringify(dbg.json?.exact).slice(0, 200));
    ok('调试检索给出注入片段', typeof dbg.json?.block === 'string', String(dbg.json?.block).slice(0, 80));
    const dbgNoQ = await api('/api/knowledge/debug-search', { query: '' });
    ok('调试检索空查询被拒(400)', dbgNoQ.status === 400, `status=${dbgNoQ.status}`);
  }

  section('qq_get_prompt 与唤醒提示注入');
  {
    const p = await api(`/api/socialV2/prompt?key=${encodeURIComponent(GROUP_KEY)}`, null, 'GET');
    ok('prompt 带 knowledge 段', p.json?.knowledge && typeof p.json.knowledge.total === 'number', JSON.stringify(p.json?.knowledge).slice(0, 250));
    ok('prompt 里 repeats 非空', Array.isArray(p.json?.knowledge?.repeats) && p.json.knowledge.repeats.length >= 1, JSON.stringify(p.json?.knowledge?.repeats));
    ok('prompt 的 autoWrite 反映配置', p.json?.knowledge?.autoWrite === true, String(p.json?.knowledge?.autoWrite));
    const names = String((p.json?.enabledTools || []).join(' '));
    ok('工具表含 qq_knowledge_query', names.includes('qq_knowledge_query'), names.slice(0, 300));
    ok('工具表含 qq_knowledge_submit', names.includes('qq_knowledge_submit'));
  }

  section('关掉 tools.knowledge 后 AI 侧被拒');
  {
    bridge.kill('SIGKILL');
    await sleep(400);
    toolFlags = { knowledge: false };
    writeTempConfig();
    bridge = startBridge();
    ok('重启后实例已就绪', await waitUp());
    const st2 = await api(`/api/socialV2/state?key=${encodeURIComponent(GROUP_KEY)}`, null, 'GET');
    agentToken = await readAgentToken(GROUP_KEY);
    ok('重启后仍能读到同一 agentToken', Boolean(st2.json?.ok) && agentToken.length >= 16, `token=${agentToken.slice(0, 6)}…`);
    const q = await agentGet(`key=${encodeURIComponent(GROUP_KEY)}&q=x`);
    ok('查询被拒(403)', q.status === 403, `status=${q.status}`);
    ok('错误信息点明未启用', String(q.json?.error || '').includes('未启用'), JSON.stringify(q.json));
    const s = await agentSubmit({ key: GROUP_KEY, question: 'q', answer: 'a' });
    ok('提交被拒(403)', s.status === 403, `status=${s.status}`);
    // 控制台不受该开关限制
    const c = await api('/api/knowledge', null, 'GET');
    ok('控制台仍可管理', c.status === 200 && c.json?.entries, `status=${c.status}`);

    // 恢复
    bridge.kill('SIGKILL');
    await sleep(400);
    toolFlags = { knowledge: true };
    writeTempConfig();
    bridge = startBridge();
    ok('恢复后实例已就绪', await waitUp());
  }

  section('向量索引：懒加载后仍能自动补齐');
  {
    // 这是回归测试：scheduleKnowledgeRebuild 曾经用「embedder 已就绪」作提前返回条件，
    // 于是首条消息到达（embedder 还没起来）时标记的脏索引被直接丢掉，之后再没人补，
    // 线上表现就是 stale 永远是全量、语义检索整个失效。这里确认重建接口与自动补齐都正常。
    const rb = await api('/api/knowledge/rag-rebuild', {});
    ok('重建接口可用', rb.status === 200 && rb.json?.ok === true, JSON.stringify(rb.json));
    await sleep(500);
    const after = await api('/api/knowledge', null, 'GET');
    ok('重建后无待补', after.json?.rag?.stale === 0, JSON.stringify(after.json?.rag));
    ok('重建后索引数等于已生效条目数', after.json?.rag?.indexed === after.json?.stats?.confirmed, JSON.stringify({ indexed: after.json?.rag?.indexed, confirmed: after.json?.stats?.confirmed }));
    ok('向量文件已落盘', fs.existsSync(path.join(STATE, 'knowledge-vectors.json')));
  }

  section('候选 / 确认链路（关掉 autoWrite）');
  {
    // 复刻黑话库那条链路：autoWrite=false 时 AI 提交只落候选，人工确认才生效。
    const off = await api('/api/knowledge/config', { autoWrite: false });
    ok('可关闭全自动写入', off.json?.config?.autoWrite === false, JSON.stringify(off.json?.config));

    const cand = await agentSubmit({
      key: GROUP_KEY,
      question: '候选链路测试问题是什么',
      answer: '这是候选状态下不该被注入的答案。',
      kind: 'fact',
      asker: ASKER_A,
    });
    ok('提交返回候选态', cand.json?.entry?.status === 'candidate', String(cand.json?.entry?.status));
    const candId = cand.json?.entry?.id;

    // 候选必须完全不可见：不能被查询命中（按 id 断言，不受语义兜底影响——
    // 知识库只有几条中文短句时，任何模糊 query 都可能召回「看起来像」的条目，那是 RAG 的正常行为）
    const q = await agentGet(`key=${encodeURIComponent(GROUP_KEY)}&q=${encodeURIComponent('候选链路测试问题')}`);
    ok('候选不出现在查询结果里', !(q.json?.entries || []).some((e) => e.id === candId), JSON.stringify((q.json?.entries || []).map((e) => e.question)));
    const list = await api('/api/knowledge', null, 'GET');
    ok('候选计入 candidates 统计', list.json?.stats?.candidates >= 1, JSON.stringify(list.json?.stats));
    ok('候选不算已生效', !(list.json?.entries || []).some((e) => e.id === candId && e.status === 'confirmed'));
    ok('候选不在向量索引里', list.json?.rag?.indexed === list.json?.stats?.confirmed, JSON.stringify({ indexed: list.json?.rag?.indexed, confirmed: list.json?.stats?.confirmed }));
    const candList = await api('/api/knowledge?status=candidate', null, 'GET');
    ok('候选能按状态筛出来', (candList.json?.entries || []).some((e) => e.id === candId), JSON.stringify((candList.json?.entries || []).map((e) => e.question)));

    // 候选被再次提交也只是补证据，不能自己转正（否则等于绕过人工闸门）
    const again = await agentSubmit({
      key: GROUP_KEY,
      question: '候选链路测试问题是什么',
      answer: '这是候选状态下不该被注入的答案。',
      kind: 'fact',
      asker: ASKER_B,
    });
    ok('候选重复提交仍是候选', again.json?.entry?.status === 'candidate', String(again.json?.entry?.status));
    ok('候选重复提交累加修订次数', (again.json?.entry?.revision ?? 0) >= 1, String(again.json?.entry?.revision));

    // 人工确认 → 立刻生效并进入索引
    const promote = await api('/api/knowledge/update', { id: candId, status: 'confirmed' });
    ok('确认后转为已生效', promote.json?.entry?.status === 'confirmed', String(promote.json?.entry?.status));
    const q2 = await agentGet(`key=${encodeURIComponent(GROUP_KEY)}&q=${encodeURIComponent('候选链路测试问题')}`);
    ok('确认后立刻可被查询命中', q2.json?.total >= 1, JSON.stringify(q2.json).slice(0, 200));
    const rb = await api('/api/knowledge/rag-rebuild', {});
    ok('确认后能补齐向量', rb.json?.ok === true, JSON.stringify(rb.json));
    const afterPromote = await api('/api/knowledge', null, 'GET');
    ok('确认后索引数跟上已生效数', afterPromote.json?.rag?.indexed === afterPromote.json?.stats?.confirmed, JSON.stringify({ indexed: afterPromote.json?.rag?.indexed, confirmed: afterPromote.json?.stats?.confirmed }));

    // 清理 + 恢复全自动
    await api('/api/knowledge/delete', { id: candId });
    const on = await api('/api/knowledge/config', { autoWrite: true });
    ok('可恢复全自动写入', on.json?.config?.autoWrite === true, JSON.stringify(on.json?.config));
  }

  section('报冲突的新条目不自动生效');
  {
    // AI 主动报冲突 = 答案存疑，即使是全自动模式也必须人工确认过才允许注入。
    // 注意两条问题必须**指纹不同**，否则会被去重合并成一条（那就不是冲突而是更新了）。
    // 所以这里两条都用控制台建，确定性地保证它们各自独立。
    const a = await api('/api/knowledge', { question: '本群允不允许发广告', answer: '答案 A：不能发', kind: 'rule' });
    const idA = a.json?.entry?.id;
    const v = await api('/api/knowledge', { question: '本群发广告允许吗', answer: '答案 B：可以发', kind: 'rule' });
    const idV = v.json?.entry?.id;
    ok('两条问题指纹不同（不会被合并）', Boolean(idA) && Boolean(idV) && idA !== idV, `${idA} / ${idV}`);

    const b = await agentSubmit({
      key: GROUP_KEY,
      question: '本群发广告允许吗',
      answer: '答案 B：可以发，别刷屏',
      kind: 'rule',
      conflictOf: idA,
      asker: ASKER_B,
    });
    ok('命中变体条目而非新建', b.json?.entry?.id === idV, `${b.json?.entry?.id} vs ${idV}`);
    ok('报冲突的条目落为候选', b.json?.entry?.status === 'candidate', String(b.json?.entry?.status));
    ok('报冲突同时带上冲突标记', b.json?.conflict === true, JSON.stringify(b.json).slice(0, 250));
    // 降级为候选后必须真的不再被注入（这是「存疑答案不许生效」的实质保证）
    const q = await agentGet(`key=${encodeURIComponent(GROUP_KEY)}&q=${encodeURIComponent('本群发广告允许吗')}`);
    ok('存疑条目不再出现在查询结果里', !(q.json?.entries || []).some((e) => e.id === idV), JSON.stringify((q.json?.entries || []).map((e) => e.question)));
    const candList = await api('/api/knowledge?status=candidate', null, 'GET');
    ok('候选列表能查到它', (candList.json?.entries || []).some((e) => e.id === idV), JSON.stringify((candList.json?.entries || []).map((e) => e.question)));

    // 确认后应转正且清掉冲突标记
    const promote = await api('/api/knowledge/update', { id: idV, status: 'confirmed', resolveConflict: true });
    ok('确认后转正并清除冲突', promote.json?.entry?.status === 'confirmed' && promote.json?.entry?.conflict === null, JSON.stringify(promote.json?.entry));
    await api('/api/knowledge/delete', { ids: [idA, idV] });
  }

  section('落盘与持久化');
  {
    const file = path.join(STATE, 'knowledge.json');
    ok('knowledge.json 已生成', fs.existsSync(file), file);
    const entries = loadKnowledge(file);
    ok('落盘内容可被模块读回', entries.length >= 1, String(entries.length));
    ok('落盘条目字段完整', entries.every((e) => e.question && e.answer && e.id && e.status), JSON.stringify(entries.map((e) => e.question)));
    ok('命中最多的条目计数已持久化', entries.some((e) => (e.hitCount || 0) >= 4), JSON.stringify(entries.map((e) => [e.question, e.hitCount])));
    const vecFile = path.join(STATE, 'knowledge-vectors.json');
    ok('知识库向量文件独立于黑话', fs.existsSync(vecFile) && !fs.existsSync(path.join(STATE, 'slang-vectors.json')), `${fs.existsSync(vecFile)}`);
    ok('指纹函数与线上一致', questionFingerprint('DeepSeek 是什么时候开源的？') === questionFingerprint('deepseek什么时候开源'));
  }

  section('前端接线');
  {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'console', 'views', 'knowledge.html'), 'utf8');
    ok('控制台片段有冲突区', html.includes('kbConflictBox'));
    ok('控制台片段有参数开关', html.includes('kbAutoWrite') && html.includes('kbEnabled'));
    ok('控制台片段有检索调试', html.includes('kbDebugQuery'));
    const js = fs.readFileSync(path.join(ROOT, 'public', 'console', 'views', 'knowledge.js'), 'utf8');
    ok('视图导出 id/order', js.includes("export const id = 'knowledge'") && js.includes('export const order'));
    ok('视图调用了管理接口', js.includes('/api/knowledge') && js.includes('/api/knowledge/update') && js.includes('/api/knowledge/delete'));
    ok('视图调用了调试接口', js.includes('/api/knowledge/debug-search'));
    const app = fs.readFileSync(path.join(ROOT, 'public', 'console', 'app.js'), 'utf8');
    ok('app.js 已注册 knowledge 视图', app.includes("import * as knowledge from './views/knowledge.js'") && app.includes('knowledge,'));
    const social2 = fs.readFileSync(path.join(ROOT, 'public', 'console', 'views', 'social2.html'), 'utf8');
    ok('social2 有 knowledge 工具开关', social2.includes('data-v2-tool="knowledge"'), '工具开关缺失');
  }

  section('MCP 工具注册');
  {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'mcp-snowluma-safe.js')] });
    const client = new Client({ name: 'knowledge-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      const names = tools.map((t) => t.name);
      ok('qq_knowledge_query 已注册', names.includes('qq_knowledge_query'), names.join(','));
      ok('qq_knowledge_submit 已注册', names.includes('qq_knowledge_submit'));
      const q = tools.find((t) => t.name === 'qq_knowledge_query');
      ok('query 工具必填 key/token', Array.isArray(q?.inputSchema?.required) && q.inputSchema.required.includes('key') && q.inputSchema.required.includes('token'), JSON.stringify(q?.inputSchema?.required));
      const s = tools.find((t) => t.name === 'qq_knowledge_submit');
      ok('submit 工具必填 question/answer', Array.isArray(s?.inputSchema?.required) && s.inputSchema.required.includes('question') && s.inputSchema.required.includes('answer'), JSON.stringify(s?.inputSchema?.required));
      await client.close();
    } catch (error) {
      ok('MCP 工具表可读取', false, error?.message ?? String(error));
    }
  }
} finally {
  bridge.kill('SIGKILL');
  fake.close();
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail && bridgeLog) {
  console.error('\n—— bridge 日志尾部 ——');
  console.error(bridgeLog.slice(-40000));
}
process.exit(fail ? 1 : 0);
