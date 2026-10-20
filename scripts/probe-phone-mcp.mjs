import { spawn } from 'node:child_process';
import path from 'node:path';
const script = process.argv[2] || path.resolve('src/mcp-phone.js');
const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const pending = new Map(); let nextId = 1;
child.stdout.on('data', (d) => { buf += d.toString('utf8'); let i;
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
child.stderr.on('data', (d) => process.stderr.write(`[stderr] ${d}`));
function rpc(method, params) { const id = nextId++;
  return new Promise((res, rej) => { pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 60000); }); }
function notify(m, p) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: m, params: p }) + '\n'); }
const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } });
console.log('server:', JSON.stringify(init.result?.serverInfo));
notify('notifications/initialized', {});
const tools = await rpc('tools/list', {});
console.log(`工具数: ${(tools.result?.tools ?? []).length}`);
for (const t of tools.result?.tools ?? []) console.log(`  ${t.name}`);
for (const [name, args] of [['phone_capability', {}], ['phone_status', {}], ['phone_exec', { command: 'echo OK; id -un' }]]) {
  console.log(`\n=== ${name} ===`);
  try { const r = await rpc('tools/call', { name, arguments: args });
    for (const c of r.result?.content ?? []) console.log(c.type === 'text' ? c.text : `  [${c.type} ${c.mimeType} ${Math.round((c.data||'').length/1024)}KB]`);
    if (r.result?.isError) console.log('  (isError)');
  } catch (e) { console.log('  调用失败:', e.message); }
}
child.kill(); process.exit(0);