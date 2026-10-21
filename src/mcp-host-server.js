// SnowLuma 进程管理 MCP server（stdio）。
// 由 DSH 的 MCP 客户端 spawn（cordis.patch.yml 里 mcp-snowluma-host 行），
// 给 agent 提供 SnowLuma 网关的状态查询与启停工具。
//
// 工具：
//   snowluma_status   —— 检查网关是否在线（HTTP get_login_info）
//   start_snowluma    —— 未运行时启动 launcher.bat 并等待网关就绪（最长 90s）
//   stop_snowluma     —— 停止 SnowLuma（按安装目录匹配进程）
//   mc_status / mc_command / mc_milestone —— Minecraft bot 状态与游戏内指令
//   mc_control_status / mc_control        —— MC 服务端 / AI 游玩 / 推流 / B站开播开关
//                                            （见 mcp-mc-control.js，动作走 SSH 到 tzd）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getMcStatus, postCommand } from './mc-state.js';
import * as mcControl from './mc-control.js';
import { registerMcControlTools } from './mcp-mc-control.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function getConfig() {
  return loadConfig();
}

function getHostConfig() {
  const c = getConfig();
  const httpUrl = (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const launcher = c.snowluma?.launcherPath ?? '';
  return {
    httpUrl,
    httpPort: new URL(httpUrl).port || '80',
    token: c.snowluma?.accessToken ?? '',
    launcher,
    homeDir: c.snowluma?.homeDir ?? (launcher ? path.dirname(launcher) : ''),
    // 进程控制默认关闭：只有 config.json 显式设置 snowluma.allowProcessControl=true 才允许启停
    allowProcessControl: c.snowluma?.allowProcessControl === true
  };
}

function getConsolePort() {
  // 允许用环境变量覆盖：除调试外，测试要能把它指到死端口以验证门禁 fail-closed
  // （由 spawn 本进程的父进程注入，正常运行时不存在）。
  const override = Number(process.env.QQ_BRIDGE_CONSOLE_PORT);
  if (Number.isFinite(override) && override > 0) return override;
  try {
    const c = getConfig();
    return Number(c.consolePort) || 3100;
  } catch {
    return 3100;
  }
}

function readConsoleToken() {
  try {
    const c = getConfig();
    if (c.consoleToken) return String(c.consoleToken);
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读一次 bridge 控制台状态（/api/status），失败返回 null。 */
async function readBridgeStatus() {
  try {
    const token = readConsoleToken();
    const res = await fetch(`http://127.0.0.1:${getConsolePort()}/api/status`, {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// SnowLuma 进程控制与 mc_control 同门槛（allowProcessControl + chat + 仅 owner 私聊 + 无新鲜群活动）。
async function bridgeModeAllowsProcessControl() {
  const decision = await hostControlDecision();
  return decision.allowed;
}

/**
 * MC 控制（mc_control）的门禁。
 *
 * 开关的用途就是「在 QQ 里让机器人开播/上号」，所以门禁按 chat 的实际用法设计。
 * 判定条件（全部满足才放行，任何一步读不到都 fail-closed）：
 *   ① config.json 的 snowluma.allowProcessControl=true —— 显式、唯一的配置开关
 *   ② bridge 处于 chat，且 allow.private **恰好只白名单 owner**
 *   ③ 群聊活动守卫：最近 GROUP_ACTIVITY_GUARD_MS 内**有群会话在活动**就拒绝
 *
 * ④ 的由来（重要，别删）：MCP 协议层拿不到「这次调用来自哪个 QQ 会话」
 * （DSH 的 mcp-client 不透传会话信息，handler 的 extra 里也没有），
 * 而 qq-chat preset 的白名单前缀包含 mcp__snowluma-host__ ——
 * 也就是**群会话的 agent 也能看到 mc_control**。于是只能靠时序启发式：
 * QQ 驱动的控制必然紧跟在一条群消息之后（桥接收到消息 → 建/唤 agent → 调工具），
 * 而控制台/私聊发起的调用前面不会有新鲜的群活动。
 * 这是启发式而非强判据：可能误拒（群里刚刷屏时 owner 在控制台点开关），
 * 但误拒只是多重试一次，反过来让群友诱导 agent 重启服务端/下播的代价大得多。
 */
const GROUP_ACTIVITY_GUARD_MS = 15_000;

/** 解析 `[HH:MM:SS] group:123 ...` 形式的 activity 行，返回最近一条群活动的毫秒年龄。 */
export function recentGroupActivityAgeMs(activityText) {
  const lines = String(activityText || '').trim().split('\n').slice(-12).reverse();
  for (const line of lines) {
    if (!/(^|\s)group:/.test(line)) continue;
    const m = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/);
    if (!m) continue;
    const now = new Date();
    const at = new Date(now);
    at.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
    let age = now - at;
    if (age < 0) age += 86_400_000; // 跨零点
    return age;
  }
  return Infinity; // 最近 12 条里没有群活动
}

/**
 * MC 控制（mc_control）的门禁判定，带「为什么被拒」的原因。
 *
 * 判定条件（全部满足才放行，任何一步读不到都 fail-closed）：
 *   ① config.json 的 snowluma.allowProcessControl=true —— 显式、唯一的配置开关
 *   ② bridge 处于 chat，且 allow.private **恰好只白名单 owner**
 *   ③ 群聊活动守卫：最近 GROUP_ACTIVITY_GUARD_MS 内**有群会话在活动**就拒绝
 *
 * ④ 的由来（重要，别删）：MCP 协议层拿不到「这次调用来自哪个 QQ 会话」
 * （DSH 的 mcp-client 不透传会话信息，handler 的 extra 里也没有），
 * 而 qq-chat preset 的白名单前缀包含 mcp__snowluma-host__ ——
 * 也就是**群会话的 agent 也能看到 mc_control**。于是只能靠时序启发式：
 * QQ 驱动的控制必然紧跟在一条群消息之后（桥接收到消息 → 建/唤 agent → 调工具），
 * 而控制台/私聊发起的调用前面不会有新鲜的群活动。
 * 这是启发式而非强判据：可能误拒（群里刚刷屏时 owner 在控制台点开关），
 * 但误拒只是多重试一次，反过来让群友诱导 agent 重启服务端/下播的代价大得多。
 */
export async function hostControlDecision() {
  if (!getHostConfig().allowProcessControl) {
    return { allowed: false, reason: '未开启进程控制（config.json 需设置 snowluma.allowProcessControl=true）' };
  }
  const st = await readBridgeStatus();
  if (!st) {
    return { allowed: false, reason: `读不到桥接控制台状态（http://127.0.0.1:${getConsolePort()}/api/status），门禁 fail-closed` };
  }
  const mode = String(st.mode ?? '');
  if (mode !== 'chat') {
    return { allowed: false, reason: `当前模式是 ${mode || '(未知)'}，只有 chat（且私聊白名单仅 owner）允许控制` };
  }
  const ownerQQ = String(st.ownerQQ ?? '');
  const priv = Array.isArray(st.allowPrivate) ? st.allowPrivate.map(String) : [];
  if (!(ownerQQ !== '' && priv.length > 0 && priv.every((q) => q === ownerQQ))) {
    return { allowed: false, reason: `chat 的私聊白名单不是「仅 owner」（allow.private=${JSON.stringify(priv)}，ownerQQ=${ownerQQ || '(未设置)'}）` };
  }
  const age = recentGroupActivityAgeMs(st.activity);
  if (age < GROUP_ACTIVITY_GUARD_MS) {
    return { allowed: false, reason: `最近 ${Math.round(age / 1000)}s 内有群会话在活动，为避免群友诱导 agent 操作服务端/直播而拒绝；稍后重试即可` };
  }
  return { allowed: true, reason: 'chat + 仅 owner 私聊 + 无新鲜群活动' };
}

async function gatewayInfo() {
  const { httpUrl, token } = getHostConfig();
  try {
    const res = await fetch(`${httpUrl}/get_login_info`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请改为 OneBot HTTP API 地址）' : '';
      return { reachable: false, httpStatus: res.status, ...(hint ? { hint } : {}) };
    }
    const body = await res.json();
    if (body?.status === 'ok' && body?.retcode === 0) {
      return { reachable: true, online: true, user_id: body.data?.user_id, nickname: body.data?.nickname };
    }
    return { reachable: true, online: false, retcode: body?.retcode, wording: body?.wording };
  } catch (error) {
    return { reachable: false, error: String(error?.message ?? error) };
  }
}

function findSnowLumaPids() {
  // 先按 OneBot HTTP 端口找监听进程，再用安装目录过滤命令行，
  // 避免误杀恰好占用同一端口的其他进程。
  const { httpPort, homeDir } = getHostConfig();
  const portNum = Number(httpPort);
  if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) return [];
  const pids = new Set();
  try {
    const byPort = `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq ${portNum} } | Select-Object -ExpandProperty OwningProcess -Unique`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', byPort], { timeout: 15000, windowsHide: true, encoding: 'utf8' });
    for (const s of out.split(/\s+/)) {
      const n = Number(s.trim());
      if (Number.isInteger(n) && n > 0) pids.add(n);
    }
  } catch {}
  const home = String(homeDir || '').toLowerCase().replace(/\\/g, '/');
  const result = [];
  for (const pid of pids) {
    try {
      const cmd = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { timeout: 10000, windowsHide: true, encoding: 'utf8' }).trim();
      const cmdLower = String(cmd || '').toLowerCase().replace(/\\/g, '/');
      if (home && cmdLower.includes(home)) result.push(pid);
    } catch {
      // 拿不到命令行时宁可不杀，避免误伤
    }
  }
  return result;
}

const server = new McpServer({ name: 'snowluma-host', version: '0.2.0' });

server.tool(
  'snowluma_status',
  '检查 SnowLuma OneBot 网关是否在线（HTTP 探活 get_login_info）。返回网关可达性、QQ 在线状态与账号信息。',
  {},
  async () => {
    const hc = getHostConfig();
    const info = await gatewayInfo();
    // 只有显式开启进程控制且通过 chat 门禁时，才暴露本机路径/PID 这类敏感信息。
    const admin = hc.allowProcessControl && await bridgeModeAllowsProcessControl();
    const extra = admin ? { launcher: hc.launcher, homeDir: hc.homeDir, processPids: findSnowLumaPids() } : {};
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...info, ...extra }, null, 2) }]
    };
  }
);

// ===== Minecraft bot =====
// 只读状态随时可查；投递游戏内指令属于"会改变外部世界"的操作，
// 与进程控制同门槛：config.json 的 snowluma.allowProcessControl + chat 门禁。
server.tool(
  'mc_status',
  '查看你自己在 Minecraft 里的实时状态 —— 那个游戏角色就是你本人，不是别人也不是小号。含：是否在线、位置、血量、饥饿、已加载区块、背包、在线玩家，以及服务端进程/端口/模式/难度、里程碑进度、直播地址。只读。',
  {},
  async () => {
    try {
      const st = await getMcStatus();
      return { content: [{ type: 'text', text: JSON.stringify(st, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: '读取 MC 状态失败：' + (e?.message ?? e) }], isError: true };
    }
  }
);

server.tool(
  'mc_command',
  '给你自己在 Minecraft 里的角色投递一条游戏内指令（那个角色就是你本人），由你轮询执行。只允许 say / pos / mine / stop / goto 开头。例如 say 大家好、mine dirt、pos。执行结果要再用 mc_status 或看日志确认。',
  { command: z.string().describe('指令内容，如 "say 你好" 或 "mine dirt"') },
  async ({ command }) => {
    const hc = getHostConfig();
    const cmd = String(command || '').trim();
    if (!/^(say|pos|mine|stop|goto)\b/i.test(cmd)) {
      return { content: [{ type: 'text', text: '拒绝：只允许 say / pos / mine / stop / goto 开头的指令。' }], isError: true };
    }
    if (!hc.allowProcessControl) {
      return { content: [{ type: 'text', text: '拒绝：未开启进程控制（config.json 需设置 snowluma.allowProcessControl=true）。' }], isError: true };
    }
    if (!(await bridgeModeAllowsProcessControl())) {
      return { content: [{ type: 'text', text: '拒绝：投递指令需要 chat + 私聊白名单仅 owner + 无新鲜群活动的门禁放行。' }], isError: true };
    }
    const r = postCommand(cmd);
    return { content: [{ type: 'text', text: JSON.stringify(r) }], isError: !r.ok };
  }
);

server.tool(
  'mc_milestone',
  '查看你自己在 Minecraft 里 15 个里程碑的进度：当前推进到第几个、哪些已完成、哪些因 peaceful 难度受阻及原因、最近完成/跳过的步骤。',
  {},
  async () => {
    const st = await getMcStatus();
    return { content: [{ type: 'text', text: JSON.stringify(st.milestones, null, 2) }] };
  }
);

if (getHostConfig().allowProcessControl) {
  server.tool(
    'start_snowluma',
    '启动 SnowLuma（launcher.bat，独立窗口）并等待 OneBot 网关就绪，最长 90 秒。已在运行时直接返回当前状态。',
    {},
    async () => {
      const hc = getHostConfig();
      if (!hc.launcher) {
        return { content: [{ type: 'text', text: '拒绝：未配置 snowluma.launcherPath。' }], isError: true };
      }
      if (!hc.allowProcessControl) {
        return { content: [{ type: 'text', text: '拒绝：进程控制未开启（config.json 需设置 snowluma.allowProcessControl=true）。' }], isError: true };
      }
      if (!(await bridgeModeAllowsProcessControl())) {
        return { content: [{ type: 'text', text: '拒绝：进程控制需要 chat + 私聊白名单仅 owner + 无新鲜群活动的门禁放行。' }], isError: true };
      }
      const before = await gatewayInfo();
      if (before.reachable && before.online) {
        return { content: [{ type: 'text', text: JSON.stringify({ started: false, alreadyOnline: true, info: before }) }] };
      }
      let spawnError = null;
      const child = spawn('cmd.exe', ['/c', 'start', '', `"${hc.launcher}"`], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (err) => { spawnError = err; });
      child.unref();
      let info = null;
      for (let i = 0; i < 45; i += 1) {
        if (spawnError) {
          return { content: [{ type: 'text', text: `启动失败：${spawnError?.message ?? spawnError}` }], isError: true };
        }
        await sleep(2000);
        info = await gatewayInfo();
        if (info.reachable && info.online) {
          return { content: [{ type: 'text', text: JSON.stringify({ started: true, readyAfterMs: (i + 1) * 2000, info }) }] };
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ started: false, timeout: true, lastInfo: info ?? before }) }] };
    }
  );

  server.tool(
    'stop_snowluma',
    '停止 SnowLuma 进程（按安装目录匹配 node 进程后 taskkill）。谨慎使用：会断开当前 QQ 连接。',
    {},
    async () => {
      const hc = getHostConfig();
      if (!hc.allowProcessControl) {
        return { content: [{ type: 'text', text: '拒绝：进程控制未开启（config.json 需设置 snowluma.allowProcessControl=true）。' }], isError: true };
      }
      if (!(await bridgeModeAllowsProcessControl())) {
        return { content: [{ type: 'text', text: '拒绝：进程控制需要 chat + 私聊白名单仅 owner + 无新鲜群活动的门禁放行。' }], isError: true };
      }
      const pids = findSnowLumaPids();
      if (pids.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ stopped: false, reason: 'no process found' }) }] };
      }
      const killed = [];
      for (const pid of pids) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true, stdio: 'ignore' });
          killed.push(pid);
        } catch (error) {
          // 进程可能已退出
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ stopped: true, killed }) }] };
    }
  );
}

// ===== Minecraft 全套开关（MC 服务端 / AI 游玩 / 推流 / B站开播）=====
// 实现在 mcp-mc-control.js；动作经 SSH 到 tzd 执行（bridge 跑在云主机，管不到那边的 systemd）。
registerMcControlTools(server, { z, getHostConfig, hostControlDecision, mcControl });

await server.connect(new StdioServerTransport());
