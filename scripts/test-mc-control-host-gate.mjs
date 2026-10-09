// 验证 mcp-host-server.js 里真实的 hostControlAllowed 判定（含群聊活动守卫）。
// 手法：把桥接控制台指到一个死端口，门禁必然 fail-closed → 用于确认「读不到就拒」；
// 再指回真端口，用只读的 live/status 验证放行路径。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (c, label, extra = '') => { console.log(`${c ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`); if (!c) failures += 1; };
const txt = (r) => (r.content ?? []).map((c) => c.text).join('\n');

async function call(env, name, args) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'src/mcp-host-server.js')],
    cwd: ROOT, env: { ...process.env, ...env }, stderr: 'pipe',
  });
  const client = new Client({ name: 'host-gate', version: '0' });
  await client.connect(transport);
  try { return await client.callTool({ name, arguments: args }); }
  finally { try { await client.close(); } catch {} }
}

// 读一下当前真实门禁输入，便于解读结果
const token = (() => { try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; } })();
let st = null;
try {
  const r = await fetch('http://127.0.0.1:3100/api/status', { headers: token ? { 'x-console-token': token } : {} });
  if (r.ok) st = await r.json();
} catch {}
console.log(`当前 bridge: mode=${st?.mode} ownerQQ=${st?.ownerQQ} allowPrivate=${JSON.stringify(st?.allowPrivate)}`);

// ① 读不到控制台 → fail-closed
{
  const r = await call({ QQ_BRIDGE_CONSOLE_PORT: '59999' }, 'mc_control', { target: 'live', action: 'status' });
  ok(!!r.isError, '读不到桥接控制台时 fail-closed', JSON.stringify(txt(r).slice(0, 40)));
  ok(/fail-closed/.test(txt(r)), '拒绝原因说明了是 fail-closed（而不是笼统说模式不对）');
}

// ② 真实门禁（当前配置）
{
  const r = await call({}, 'mc_control', { target: 'live', action: 'status' });
  const groupBusy = /群会话在活动/.test(txt(r));
  ok(!r.isError, '当前配置下 mc_control 放行（owner 私聊 + 无新鲜群活动）', r.isError ? JSON.stringify(txt(r).slice(0, 80)) : '');
  if (groupBusy) console.log('   （命中群活动守卫：说明最近 15s 内有群会话在活动，属于预期内的保守拒绝）');
}

console.log(failures ? `\n❌ ${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
