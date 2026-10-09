// 验证 mc_control / mc_control_status 的注册与门禁：
//   1) 注册层面真的挂上了两个工具，且 mc_control_status 不带门禁（只读）
//   2) mc_control 在门禁拒绝时不产生任何副作用（不碰 SSH）
//   3) mc_control 在门禁放行时能把动作执行下去（用只读的 live/status 探）
//
// 用一个桩 stdio server 承载真实的 registerMcControlTools，这样不依赖 DSH，
// 也不依赖 bridge 当前处于什么模式 —— hostControlAllowed 由本脚本按场景注入。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { registerMcControlTools } from '../src/mcp-mc-control.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failures += 1;
};

// ——— 桩 server：按环境变量决定门禁结果 ———
const ALLOW = process.env.STUB_ALLOW === '1';
const stub = {
  getFullStatus: async () => ({ ok: true, services: { mcserver: { active: 'active' } }, stream: { room: 'STUB', streaming: true } }),
  getStreamStatus: async () => ({ ok: true }),
  getMcServices: async () => ({ ok: true, services: {} }),
  controlStream: async () => ({ ok: true, state: 'stopped' }),
  controlAi: async () => ({ ok: true, state: 'active' }),
  controlServer: async () => ({ ok: true, state: 'active' }),
  controlLive: async (action) => ({ ok: true, action, opened: false, detail: `STUB live ${action}` }),
};
const server = new McpServer({ name: 'mc-control-gate-stub', version: '0' });
registerMcControlTools(server, {
  z,
  getHostConfig: () => ({ allowProcessControl: ALLOW }),
  // 门禁本身在 mcp-host-server.js 里（hostControlDecision），这里只验工具侧行为
  hostControlDecision: async () => (ALLOW ? { allowed: true, reason: 'stub' } : { allowed: false, reason: '未开启进程控制（config.json 需设置 snowluma.allowProcessControl=true）' }),
  mcControl: stub,
});
await server.connect(new StdioServerTransport());

// ——— 上面是桩 server（由下面的 runner 以子进程方式拉起）———
// 当被以 --stub 启动时，交给 stdio 循环；否则作为 runner 驱动整组检查。
if (process.argv.includes('--stub')) {
  // 已经在 connect 上挂着，stdio 循环会保持进程存活
} else {
  const SELF = fileURLToPath(import.meta.url);

  async function runStub(allow) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SELF, '--stub'],
      cwd: ROOT,
      env: { ...process.env, STUB_ALLOW: allow ? '1' : '0' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'gate-runner', version: '0' });
    await client.connect(transport);
    return {
      client,
      close: async () => { try { await client.close(); } catch {} },
    };
  }
  const txt = (r) => (r.content ?? []).map((c) => c.text).join('\n');

  // 场景 1：门禁关闭
  {
    const s = await runStub(false);
    const { tools } = await s.client.listTools();
    const names = tools.map((t) => t.name).sort();
    ok(JSON.stringify(names) === JSON.stringify(['mc_control', 'mc_control_status']),
      '注册了 mc_control 与 mc_control_status', names.join(', '));

    const ro = await s.client.callTool({ name: 'mc_control_status', arguments: {} });
    ok(!ro.isError, 'mc_control_status 无门禁，可随时调用');

    const rw = await s.client.callTool({ name: 'mc_control', arguments: { target: 'stream', action: 'stop' } });
    ok(!!rw.isError, '门禁关闭时 mc_control 被拒');
    ok(/未开启进程控制/.test(txt(rw)), '拒绝信息指向配置开关', JSON.stringify(txt(rw).slice(0, 40)));
    await s.close();
  }

  // 场景 2：门禁放行
  {
    const s = await runStub(true);
    const rw = await s.client.callTool({ name: 'mc_control', arguments: { target: 'live', action: 'status' } });
    ok(!rw.isError, '门禁放行时 mc_control 可执行');
    ok(/STUB live status/.test(txt(rw)), '动作透传到 mcControl.controlLive');

    const bad = await s.client.callTool({ name: 'mc_control', arguments: { target: 'live', action: 'restart' } });
    ok(!!bad.isError, 'live/restart 被拒（B站不支持 restart）');

    const ai = await s.client.callTool({ name: 'mc_control', arguments: { target: 'ai', action: 'status' } });
    ok(!!ai.isError, 'ai/status 被拒（status 只对 live 有效）');
    await s.close();
  }

  console.log(failures ? `\n❌ ${failures} 项失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
}
