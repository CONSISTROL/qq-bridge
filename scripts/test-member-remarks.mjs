// 群成员备注自检：
// 1) member-remarks 纯函数（读写/查找/上限/原型污染/落盘往返）
// 2) 隔离实例 + 假 OneBot：/api/socialV2/member-remark(-remove)/member-remarks 的增查改删
// 3) 真·QQ 群名片默认关闭 → 403；显式打开后 → 假 OneBot 真的收到 set_group_card
// 4) 控制台工具开关 + MCP 工具注册：默认开的备注工具在、默认关的群名片工具不在
//
// 不碰线上 bridge / 真 QQ：用 QQ_BRIDGE_CONFIG + QQ_BRIDGE_STATE_DIR 起隔离实例，
// snowluma 指向本脚本的假 OneBot。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  loadMemberStore,
  saveMemberStore,
  emptyMemberStore,
  setMemberRemark,
  removeMemberRemark,
  listMemberRemarks,
  findMemberRemark,
  formatMemberRemarkList,
  normalizeMemberRemark,
  normalizeUserId,
  MEMBER_REMARKS_PER_KEY_MAX
} from '../src/member-remarks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = '/tmp/qqbridge-member-remarks';
const ONEBOT_PORT = 3998;
const BRIDGE_PORT = 3197;
const STATE = path.join(TMP, 'state');
const TOKEN = 'member-remark-test-token-0123456789';
const GROUP_KEY = 'group:123456';
const MEMBER_QQ = '555';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (t) => console.log(`\n## ${t}`);

// ── 1. 纯函数 ─────────────────────────────────────────────────────────────
section('member-remarks 纯函数');
{
  ok('normalizeUserId 只收正整数', normalizeUserId('555') === '555' && normalizeUserId('-1') === '' && normalizeUserId('abc') === '' && normalizeUserId('0') === '');
  ok('空记录返回 null', normalizeMemberRemark({ qq: '1' }) === null);
  const e = normalizeMemberRemark({ qq: '555', remark: '老\n王', note: 'x'.repeat(500) }, '');
  ok('去掉换行并截断 key', e && e.remark === '老 王' && e.note.length === 200, JSON.stringify(e));
}
{
  const store = emptyMemberStore();
  const r1 = setMemberRemark(store, GROUP_KEY, MEMBER_QQ, { remark: '老王', note: '写代码的' });
  ok('写入返回 entry', r1.entry?.qq === MEMBER_QQ && r1.entry?.remark === '老王', JSON.stringify(r1));
  ok('列表能查到', listMemberRemarks(store, GROUP_KEY, {}).total === 1);
  const r2 = setMemberRemark(store, GROUP_KEY, MEMBER_QQ, { note: '爱发猫图' });
  ok('只传 note 时保留 remark', r2.entry?.remark === '老王' && r2.entry?.note === '爱发猫图', JSON.stringify(r2.entry));
  ok('按短名精确命中', findMemberRemark(store, GROUP_KEY, '老王')?.qq === MEMBER_QQ);
  ok('按说明模糊命中', findMemberRemark(store, GROUP_KEY, '猫图')?.qq === MEMBER_QQ);
  ok('按 QQ 找到', findMemberRemark(store, GROUP_KEY, MEMBER_QQ)?.remark === '老王');
  ok('查不到返回 null', findMemberRemark(store, GROUP_KEY, '查无此人') === null);
  const block = formatMemberRemarkList(listMemberRemarks(store, GROUP_KEY, {}).entries);
  ok('格式化带 QQ 与说明', block.includes('老王') && block.includes(MEMBER_QQ) && block.includes('爱发猫图'), block);
  ok('搜索命中过滤', listMemberRemarks(store, GROUP_KEY, { q: '猫' }).total === 1 && listMemberRemarks(store, GROUP_KEY, { q: 'zzz' }).total === 0);
  ok('删除成功', removeMemberRemark(store, GROUP_KEY, MEMBER_QQ) === true && listMemberRemarks(store, GROUP_KEY, {}).total === 0);
  ok('重复删除返回 false', removeMemberRemark(store, GROUP_KEY, MEMBER_QQ) === false);
  ok('remakr+note 全空等于删除', setMemberRemark(store, GROUP_KEY, '999', { remark: '临时' }).entry?.qq === '999'
    && setMemberRemark(store, GROUP_KEY, '999', { remark: '', note: '' }).removed === true);
  const convAfterProto = store.conversations[GROUP_KEY] || {};
  setMemberRemark(store, GROUP_KEY, '__proto__', { remark: 'x' });
  ok('__proto__ 不会被写进去', !Object.prototype.hasOwnProperty.call(convAfterProto, '__proto__')
    && !Object.prototype.hasOwnProperty.call(convAfterProto, 'constructor'));
  // 有界：超出上限丢最旧的
  for (let i = 0; i < MEMBER_REMARKS_PER_KEY_MAX + 5; i++) setMemberRemark(store, GROUP_KEY, String(1000 + i), { remark: `m${i}` });
  ok(`单个会话备注数有上限(${MEMBER_REMARKS_PER_KEY_MAX})`, Object.keys(store.conversations[GROUP_KEY]).length <= MEMBER_REMARKS_PER_KEY_MAX);
}
{
  const file = path.join(TMP, 'roundtrip.json');
  fs.rmSync(TMP, { recursive: true, force: true });
  const store = emptyMemberStore();
  setMemberRemark(store, GROUP_KEY, MEMBER_QQ, { remark: '老王', note: '写代码的', nick: '旺财' });
  saveMemberStore(file, store);
  const back = loadMemberStore(file);
  ok('落盘往返一致', back.conversations[GROUP_KEY]?.[MEMBER_QQ]?.remark === '老王' && back.conversations[GROUP_KEY]?.[MEMBER_QQ]?.nick === '旺财');
  fs.writeFileSync(file, '{ 坏掉的 json');
  ok('坏文件回退空库', loadMemberStore(file).conversations && Object.keys(loadMemberStore(file).conversations).length === 0);
  ok('文件不存在回退空库', loadMemberStore(path.join(TMP, 'nope.json')).conversations !== undefined);
}

// ── 2. 隔离实例 + 假 OneBot ────────────────────────────────────────────────
const received = [];
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 忽略 */ }
    const action = req.url.replace(/^\//, '');
    received.push({ action, body });
    let data = { message_id: 1000 + received.length };
    if (action === 'get_login_info') data = { user_id: 10001, nickname: '测试机器人' };
    if (action === 'get_status') data = { online: true, good: true };
    if (action === 'get_group_member_info') data = { user_id: Number(body.user_id), nickname: '旺财', card: '旺财' };
    if (action === 'get_group_member_list') data = [{ user_id: 555, nickname: '旺财', card: '旺财' }];
    if (action === 'set_group_card') data = {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
});

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });
const baseCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

function writeTempConfig(cardEnabled) {
  const cfg = JSON.parse(JSON.stringify(baseCfg));
  cfg.consolePort = BRIDGE_PORT;
  cfg.consoleToken = TOKEN;
  cfg.snowluma = { ...(cfg.snowluma ?? {}), wsUrl: 'ws://127.0.0.1:1/', httpUrl: `http://127.0.0.1:${ONEBOT_PORT}` };
  cfg.dsh = { ...(cfg.dsh ?? {}), baseUrl: 'http://127.0.0.1:1' };
  cfg.allow = { ...(cfg.allow ?? {}), groups: [123456], private: [] };
  cfg.socialV2.enabled = true;
  cfg.socialV2.tools = { ...(cfg.socialV2.tools ?? {}), memberRemark: true, setMemberCard: cardEnabled };
  const p = path.join(TMP, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

const cfgPath = writeTempConfig(false);
let bridgeLog = '';
let bridge = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], {
  cwd: ROOT,
  env: { ...process.env, QQ_BRIDGE_CONFIG: cfgPath, QQ_BRIDGE_STATE_DIR: STATE },
  stdio: ['ignore', 'pipe', 'pipe']
});
bridge.stdout.on('data', (d) => { bridgeLog += d.toString(); });
bridge.stderr.on('data', (d) => { bridgeLog += d.toString(); });

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

try {
  await new Promise((r) => fake.listen(ONEBOT_PORT, '127.0.0.1', r));
  ok('隔离实例已启动', await waitUp());

  section('备注接口：写 / 查 / 改 / 删');
  {
    const r = await api('/api/socialV2/member-remark', { key: GROUP_KEY, userId: MEMBER_QQ, remark: '老王', note: '写代码的' });
    ok('写入 200', r.status === 200 && r.json?.ok === true, JSON.stringify(r.json).slice(0, 200));
    ok('自动补了昵称快照', r.json?.entry?.nick === '旺财', JSON.stringify(r.json?.entry));
    ok('返回当前会话备注总数', r.json?.total === 1);

    const g = await api(`/api/socialV2/member-remarks?key=${encodeURIComponent(GROUP_KEY)}`, null, 'GET');
    ok('读取 200 且能查到', g.json?.ok === true && g.json?.total === 1, JSON.stringify(g.json).slice(0, 200));
    ok('block 可读（带 QQ 与说明）', String(g.json?.block || '').includes('老王') && String(g.json?.block || '').includes('写代码的'), g.json?.block);

    const q = await api(`/api/socialV2/member-remarks?key=${encodeURIComponent(GROUP_KEY)}&q=${encodeURIComponent('老王')}`, null, 'GET');
    ok('按名字搜到 match', q.json?.match?.qq === MEMBER_QQ, JSON.stringify(q.json?.match));
    const miss = await api(`/api/socialV2/member-remarks?key=${encodeURIComponent(GROUP_KEY)}&q=查无此人`, null, 'GET');
    ok('搜不到时 total=0 且给提示', miss.json?.total === 0 && String(miss.json?.block || '').includes('没有匹配'), miss.json?.block);

    const upd = await api('/api/socialV2/member-remark', { key: GROUP_KEY, userId: MEMBER_QQ, note: '爱发猫图' });
    ok('只改 note 时保留短名', upd.json?.entry?.remark === '老王' && upd.json?.entry?.note === '爱发猫图', JSON.stringify(upd.json?.entry));

    const bad = await api('/api/socialV2/member-remark', { key: GROUP_KEY, userId: 'abc', remark: 'x' });
    ok('非数字 QQ 被拒(400)', bad.status === 400, `status=${bad.status}`);
    const empty = await api('/api/socialV2/member-remark', { key: GROUP_KEY, userId: MEMBER_QQ });
    ok('一个字段都不传被拒(400)', empty.status === 400, `status=${empty.status}`);
    const wrongToken = await api(`/api/socialV2/member-remarks?key=${encodeURIComponent(GROUP_KEY)}`, null, 'GET', { 'x-agent-token': 'bogus-token' });
    ok('假 agent token 被拒(403)', wrongToken.status === 403, `status=${wrongToken.status}`);
    const emptyToken = await api(`/api/socialV2/member-remarks?key=${encodeURIComponent(GROUP_KEY)}`, null, 'GET', { 'x-agent-token': '' });
    ok('空 agent token 被拒(403)', emptyToken.status === 403, `status=${emptyToken.status}`);

    // 备注要活过 /reset：它是独立文件，不属于 social-v2 状态
    const reset = await api('/api/socialV2/reset', { key: GROUP_KEY });
    const afterReset = await api(`/api/socialV2/member-remarks?key=${encodeURIComponent(GROUP_KEY)}`, null, 'GET');
    ok('reset 后备注仍在（独立于 v2 状态）', afterReset.json?.total === 1 || reset.status !== 200, `reset=${reset.status} total=${afterReset.json?.total}`);

    const del = await api('/api/socialV2/member-remark-remove', { key: GROUP_KEY, userId: MEMBER_QQ });
    ok('删除 200', del.status === 200 && del.json?.ok === true && del.json?.removed === true, JSON.stringify(del.json));
    const after = await api(`/api/socialV2/member-remarks?key=${encodeURIComponent(GROUP_KEY)}`, null, 'GET');
    ok('删完就查不到', after.json?.total === 0);
  }

  section('qq_get_prompt 的可用工具表');
  {
    const p = await api(`/api/socialV2/prompt?key=${encodeURIComponent(GROUP_KEY)}`, null, 'GET');
    const names = String((p.json?.enabledTools || []).join(' '));
    ok('备注读取工具在表里', names.includes('qq_get_member_remarks'), names.slice(0, 300));
    ok('备注写入工具在表里', names.includes('qq_set_member_remark') && names.includes('qq_remove_member_remark'));
    ok('默认关闭时群名片工具不在表里', !names.includes('qq_set_member_card'), names.slice(0, 300));
  }

  section('真·QQ 群名片：默认关闭');
  {
    const before = received.filter((r) => r.action === 'set_group_card').length;
    const r = await api('/api/socialV2/set-member-card', { key: GROUP_KEY, userId: MEMBER_QQ, card: '小王' });
    ok('默认关闭时被拒(403)', r.status === 403, `status=${r.status} ${JSON.stringify(r.json)}`);
    ok('没有真的调用 set_group_card', received.filter((x) => x.action === 'set_group_card').length === before);
    const priv = await api('/api/socialV2/set-member-card', { key: 'private:10001', userId: MEMBER_QQ, card: 'x' });
    ok('私聊 key 被拒(400)', priv.status === 400, `status=${priv.status}`);
  }

  section('真·QQ 群名片：显式打开后可用');
  {
    bridge.kill('SIGKILL');
    await sleep(500);
    writeTempConfig(true);
    bridgeLog = '';
    bridge = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], {
      cwd: ROOT,
      env: { ...process.env, QQ_BRIDGE_CONFIG: cfgPath, QQ_BRIDGE_STATE_DIR: STATE },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    bridge.stdout.on('data', (d) => { bridgeLog += d.toString(); });
    bridge.stderr.on('data', (d) => { bridgeLog += d.toString(); });
    ok('重启后实例已就绪', await waitUp());

    const r = await api('/api/socialV2/set-member-card', { key: GROUP_KEY, userId: MEMBER_QQ, card: '小王' });
    ok('打开后调用成功', r.status === 200 && r.json?.ok === true, `${JSON.stringify(r.json)} log=${bridgeLog.slice(-300)}`);
    const call = received.filter((x) => x.action === 'set_group_card').pop();
    ok('假 OneBot 收到 set_group_card', Boolean(call), JSON.stringify(received.map((x) => x.action)));
    ok('群号/QQ/名片都正确', String(call?.body?.group_id) === '123456' && String(call?.body?.user_id) === MEMBER_QQ && call?.body?.card === '小王', JSON.stringify(call?.body));
    const again = await api('/api/socialV2/set-member-card', { key: GROUP_KEY, userId: MEMBER_QQ, card: '小王小王' });
    ok('同一人 15 秒内冷却(429)', again.status === 429, `status=${again.status}`);

    const p = await api(`/api/socialV2/prompt?key=${encodeURIComponent(GROUP_KEY)}`, null, 'GET');
    const names = String((p.json?.enabledTools || []).join(' '));
    ok('打开后群名片工具出现在工具表', names.includes('qq_set_member_card'), names.slice(0, 400));
  }

  section('控制台与 MCP 工具表');
  {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'console', 'views', 'social2.html'), 'utf8');
    ok('控制台有 memberRemark 开关', html.includes('data-v2-tool="memberRemark"'));
    ok('控制台有 setMemberCard 开关', html.includes('data-v2-tool="setMemberCard"'));
    const js = fs.readFileSync(path.join(ROOT, 'public', 'console', 'views', 'social2.js'), 'utf8');
    ok('默认关闭的工具按 === true 显示', js.includes("OPT_IN_TOOLS") && js.includes("=== true"));
    ok('「全部开启」跳过默认关闭的工具', /enabled && OPT_IN_TOOLS\.has/.test(js));
    ok('记忆面板能列成员备注', js.includes('memberRemarks') && js.includes('remark-remove'));
    const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
    ok('群名片接口按 === true 收口', bridgeSrc.includes("cfg.socialV2?.tools?.setMemberCard !== true"));
  }

  section('MCP 工具注册（读真实 config.json）');
  {
    const realCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src', 'mcp-snowluma-safe.js')] });
    const client = new Client({ name: 'member-remark-test', version: '0.1.0' });
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((t) => t.name);
      ok('qq_get_member_remarks 已注册', names.includes('qq_get_member_remarks'), names.join(','));
      ok('qq_set_member_remark 已注册', names.includes('qq_set_member_remark'));
      ok('qq_remove_member_remark 已注册', names.includes('qq_remove_member_remark'));
      const cardOn = realCfg.socialV2?.tools?.setMemberCard === true;
      ok('qq_set_member_card 与配置一致（默认关闭）', names.includes('qq_set_member_card') === cardOn, `config=${cardOn} registered=${names.includes('qq_set_member_card')}`);
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
process.exit(fail ? 1 : 0);
