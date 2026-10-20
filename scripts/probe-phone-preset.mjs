// 验证 mcp-phone 工具在指定 preset 下是否真的可用。
// 用法: node scripts/probe-phone-preset.mjs [preset]   (默认 standard)
//
// 判定逻辑：
//   1. 建会话挂指定 preset
//   2. 让 agent 调用 phone_status
//   3. 观测 tool/call 里是否出现 mcp__phone__*
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080';

function launchToken() {
  // 优先用桥接 config.json 里的 dsh.authToken：
  // dsh-restart.sh 每次重启 DSH 后会把新 token 写回这里，是最权威的来源。
  // 日志里的 token 会因为旧 server-*.out.log 残留而取到过期值（踩过）。
  try {
    const d = JSON.parse(fs.readFileSync('/home/wx/qq-bridge/config.json', 'utf8').replace(/^\uFEFF/, ''));
    if (d?.dsh?.authToken) return d.dsh.authToken;
  } catch {}
  const dir = path.join(os.homedir(), '.dsh', 'guard', 'logs');
  try {
    const files = fs.readdirSync(dir)
      .filter((n) => /^server-.*\.out\.log$/.test(n))
      .map((n) => ({ n, m: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const { n } of files) {
      try {
        const m = fs.readFileSync(path.join(dir, n), 'utf8').match(/[?&]token=([A-Za-z0-9_-]+)/);
        if (m) return m[1];
      } catch {}
    }
  } catch {}
  return '';
}

const t = process.env.DSH_TOKEN || launchToken();
console.log('launch token:', t ? `${t.slice(0, 8)}…` : '(未找到)');
const r0 = await fetch(`${BASE}/?token=${t}`, { redirect: 'manual' });
const cookie = (r0.headers.get('set-cookie') || '').split(';')[0];
if (!cookie) { console.error('未拿到会话 cookie'); process.exit(1); }

async function rpc(ep, args) {
  const r = await fetch(`${BASE}/api/${ep}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'x' + Math.random().toString(36).slice(2, 8), method: ep, payload: { args } }),
  });
  return (await r.json()).result;
}

const PRESET = process.argv[2] || 'standard';
const dir = path.join(process.cwd(), 'state', 'e2e');
fs.mkdirSync(dir, { recursive: true });

const ws = await rpc('workspace/create', { request: { path: dir } });
const wsId = ws.value.workspace.workspaceId;

const sc = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: PRESET } });
if (!sc.ok) {
  console.error(`preset ${PRESET} 挂载失败: ${sc.error.code}: ${sc.error.message}`);
  process.exit(2);
}
const sessionId = sc.value.sessionId;
console.log(`session ${sessionId} (preset=${PRESET})`);

const sm = await rpc('session/selectModel', {
  request: { sessionId, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
});
console.log('selectModel:', sm.ok ? JSON.stringify(sm.value.selected) : `FAIL ${sm.error.message}`);

const url = new URL('/api/remote.mux', BASE);
url.protocol = 'ws:';
const socket = new WebSocket(url, { headers: { cookie } });
const streamId = randomUUID();
const eventStreamId = randomUUID();
const toolCalls = [];
const toolResults = [];

const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 150_000);
  const finish = (why) => { clearTimeout(timer); resolve(why); };
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }));
    socket.send(JSON.stringify({ type: 'open', streamId: eventStreamId, endpoint: '$events', payload: { args: {} } }));
    setTimeout(async () => {
      const p = await rpc('session/prompt', {
        request: {
          sessionId, requestId: randomUUID(), mode: 'queue',
          content: [{ type: 'text', text: '请调用 phone_status 工具一次（检查那台手机是否在线），然后把它的原始输出贴给我。' }],
        },
      });
      console.log('prompt ->', JSON.stringify(p).slice(0, 140));
    }, 800);
  });
  socket.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'item' || m.streamId === eventStreamId) return;
    const v = m.value;
    if (v?.type !== 'event') return;
    const e = v.event;
    if (e.type === 'tool/call') toolCalls.push({ name: e.data?.name ?? e.data?.toolName });
    if (e.type === 'tool/result') {
      const raw = e.data ?? {};
      const content = raw.content ?? raw.result?.content ?? [];
      const textBits = (Array.isArray(content) ? content : [])
        .filter((c) => c?.type === 'text').map((c) => String(c.text || ''));
      toolResults.push({
        name: raw.name ?? raw.toolName,
        isError: raw.isError === true,
        text: textBits.join('\n').slice(0, 600),
      });
    }
    if (e.type === 'turn/end') finish('done');
  });
  socket.addEventListener('close', () => finish('closed'));
  socket.addEventListener('error', () => finish('error'));
});

const why = await done;
console.log(`\n结果: ${why}`);
console.log('tool/call:', JSON.stringify(toolCalls));
for (const r of toolResults) {
  console.log('tool/result raw:', r.raw);
}

const phoneCalled = toolCalls.some((c) => String(c.name).startsWith('mcp__phone__') || String(c.name).startsWith('phone_'));
const phoneOk = toolResults.some((r) =>
  (String(r.name).startsWith('mcp__phone__') || String(r.name).startsWith('phone_'))
  && !r.isError && /手机在线|ALIVE|MODEL=|u0_a194/.test(r.text || ''));
console.log('\n判定:');
console.log(`  phone 工具被调用 : ${phoneCalled ? '✅' : '❌'}`);
console.log(`  返回真实手机数据 : ${phoneOk ? '✅' : '❌'}`);
process.exit(0);
