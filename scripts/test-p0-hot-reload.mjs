// P0 验证：工具表热刷新（不重启 DSH 也能同步工具开关）
//
// 做法：在隔离副本（/tmp/mcp-test）里以 stdio 方式拉起 MCP server，
// 用与 DSH 相同的方式（SDK Client + ToolListChangedNotificationSchema）
// 验证：改 config.json 的工具开关 → 收到 tools/list_changed → 工具表变化。
//
// 用法：node scripts/test-p0-hot-reload.mjs
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const SANDBOX = process.env.P0_SANDBOX || '/tmp/mcp-test';
const CONFIG = path.join(SANDBOX, 'config.json');
const SERVER = path.join(SANDBOX, 'src', 'mcp-snowluma-safe.js');
const TARGET_TOOL = 'qq_get_self_image';
const FLAG_PATH = ['socialV2', 'tools', 'getSelfImage'];

function readCfg() { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
function writeCfg(v) { fs.writeFileSync(CONFIG, JSON.stringify(v, null, 2)); return v; }
function setFlag(v, on) { v.socialV2.tools.getSelfImage = on; return v; }
function has(tools) { return tools.some((t) => t.name === TARGET_TOOL); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const original = readCfg();
let listChanged = 0;
let failures = 0;

function check(label, ok, detail) {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  cwd: SANDBOX,
  stderr: 'pipe'
});
transport.stderr?.on('data', (chunk) => {
  const text = String(chunk).trim();
  if (text) console.log(`   [server] ${text.split('\n').join('\n   [server] ')}`);
});

const client = new Client({ name: 'p0-hot-reload-test', version: '1.0.0' }, { capabilities: {} });
client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { listChanged += 1; });

try {
  await client.connect(transport);

  const before = await client.listTools();
  check('初始工具表包含 ' + TARGET_TOOL, has(before.tools), `工具数=${before.tools.length}`);
  check('初始工具表包含 qq_save_sticker', before.tools.some((t) => t.name === 'qq_save_sticker'), `工具数=${before.tools.length}`);

  writeCfg(setFlag(readCfg(), false));
  await sleep(3000);
  const off = await client.listTools();
  check('关闭开关后工具消失（免重启）', !has(off.tools), `工具数=${off.tools.length}`);
  check('关闭后收到过 list_changed', listChanged > 0, `次数=${listChanged}`);

  const seen = listChanged;
  writeCfg(setFlag(readCfg(), true));
  await sleep(3000);
  const on = await client.listTools();
  check('重新打开后工具回来（免重启）', has(on.tools), `工具数=${on.tools.length}`);
  check('打开后再次收到 list_changed', listChanged > seen, `次数=${listChanged}`);
} catch (error) {
  check('测试执行', false, String(error?.message ?? error));
} finally {
  writeCfg(original);
  try { await client.close(); } catch {}
}

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
