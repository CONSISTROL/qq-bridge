// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SENSITIVE_RE } from './sensitive.js';

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

let cfg = loadConfig();

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 构造可选的“引用/回复”消息段：
// - 传了 replyToMessageId 时，在文本前追加 reply 段，让 QQ 显示“引用了某条消息”；
// - 使用结构化消息段而不是 CQ 码，避免注入；
// - replyToMessageId 必须是非零整数（字符串数字也接受；QQ 消息 id 可能为负数）。
function messageSegments(message, replyToMessageId) {
  const segments = [];
  const replyId = replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== ''
    ? String(replyToMessageId).trim()
    : null;
  if (replyId !== null) {
    if (!/^-?[1-9]\d*$/.test(replyId)) {
      throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
    }
    segments.push({ type: 'reply', data: { id: replyId } });
  }
  segments.push({ type: 'text', data: { text: escapeCqText(String(message ?? '')) } });
  return segments;
}

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
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

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(rest.headers ?? {})
  };
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(body?.error || `桥接 API HTTP ${res.status}`);
  }
  return body;
}

async function authorizeRead(key, token) {
  await agentApi('/api/authorize/read', { method: 'POST', body: JSON.stringify({ key, token: token || undefined }) });
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.1.5' });

// ── 动态工具注册 ────────────────────────────────────────────────────────────
// 目的：控制台改工具开关后，不重启 DSH 也能让模型侧的工具表同步。
// 机制：注册统一走 defineTool() 以便拿到句柄；配置变化时把已注册工具全部
//       remove，再按最新的 cfg 重跑一遍注册，最后发 tools/list_changed 通知，
//       DSH 的 MCP 客户端收到后会重新拉取工具表。
const toolHandles = [];
const CONFIG_PATH = path.join(ROOT, 'config.json');

function defineTool(...args) {
  const handle = server.tool(...args);
  toolHandles.push(handle);
  return handle;
}

function removeAllTools() {
  while (toolHandles.length) {
    const handle = toolHandles.pop();
    try { handle.remove(); } catch { /* 已移除或未注册，忽略 */ }
  }
}

let lastAppliedConfig = JSON.stringify(cfg);

function reregisterTools(reason) {
  try {
    const next = loadConfig();
    const fingerprint = JSON.stringify(next);
    // fs.watch 与兜底轮询会重复触发；内容没变就直接跳过，避免无谓的重注册。
    if (fingerprint === lastAppliedConfig) return;
    cfg = next;
    lastAppliedConfig = fingerprint;
    registerAllTools();
    server.sendToolListChanged(); // 批量重注册后只通知一次
    console.error(`[snowluma-safe] tools re-registered (${reason}), enabled=${toolHandles.length}`);
  } catch (error) {
    console.error(`[snowluma-safe] tools re-register failed (${reason}): ${error?.message ?? error}`);
  }
}

function installConfigWatcher() {
  let timer = null;
  const schedule = (reason) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; reregisterTools(reason); }, 300);
  };
  try {
    fs.watch(CONFIG_PATH, () => schedule('watch'));
    console.error('[snowluma-safe] config watcher: fs.watch');
  } catch (error) {
    console.error(`[snowluma-safe] fs.watch unavailable (${error?.message ?? error}); polling fallback only`);
  }
  // 兜底轮询：部分容器/overlay 文件系统上 fs.watch 不可靠。
  fs.watchFile(CONFIG_PATH, { interval: 2000 }, (cur, prev) => {
    if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) schedule('poll');
  });
}

function registerAllTools() {
  // 批量重注册期间屏蔽逐条通知：SDK 的 registerTool/remove 每次都会
  // sendToolListChanged()，36 个工具会瞬间打出几十条通知。
  const notify = server.sendToolListChanged.bind(server);
  server.sendToolListChanged = () => {};
  try {
    removeAllTools();

defineTool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: JSON.stringify({ ...login, online: status.online, good: status.good }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token；reserved2 模式下通过桥接 /api/status 直接拒绝，
    // 避免绕过二代仿真模式的令牌隔离。
    try {
      const status = await agentApi('/api/status');
      if (status?.mode === 'reserved2') {
        return { content: [{ type: 'text', text: 'reserved2 模式下旧只读工具不可用，请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_get_group_members',
  '列出指定群的成员列表（只读）：QQ 号、昵称、群名片。',
  { groupId: z.union([z.number(), z.string()]).describe('群号') },
  async ({ groupId }) => {
    const g = String(groupId);
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中。白名单：${a.allowGroups.join(', ') || '（空）'}` }], isError: true };
    }
    try { await authorizeRead(`group:${g}`); } catch (error) {
      return { content: [{ type: 'text', text: `拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    try {
      const data = await onebot('get_group_member_list', { group_id: Number(g) });
      const list = (Array.isArray(data) ? data : (data?.data ?? [])).map((m) => ({ user_id: m.user_id, nickname: m.nickname, card: m.card }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中。白名单：${a.allowGroups.join(', ') || '（空）'}` }], isError: true };
    }
    try { await authorizeRead(`group:${g}`); } catch (error) {
      return { content: [{ type: 'text', text: `拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息，并发送一条文本。适合群消息很多、需要明确“我回的是哪条”时使用；replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id。发送前桥接会校验该 id 存在且属于当前会话。二代模式下这是你正常可用的引用工具，但不要每条都引用。只有以下情况才需要引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。reserved2 下调用时必须携带会话令牌 token。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
defineTool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_get_unread_messages',
  '查看指定会话的未读消息（只读，不自动标记已读）。消息对象里若有 `card` 字段，那是卡片消息（分享/小程序/音乐等）的结构化内容：**`card.url` 是完整链接，要用就用它**——`text` 里的摘要在极长时会用 `…` 截断。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'), limit: z.number().optional().describe('最多返回条数，默认 30，最大 100') },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。消息对象里若有 `card` 字段，那是卡片消息（分享/小程序/音乐等）的结构化内容：**`card.url` 是完整链接，要用就用它**——`text` 里的摘要在极长时会用 `…` 截断。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_mark_read',
  '将指定会话的当前未读消息标记为已读（用于“看过但决定不回复”后避免重复未读）。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_set_wake_config',
  '设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（二代仿真模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  defineTool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

defineTool(
  'qq_wait_for_messages',
  '等待群友消息：可指定“静默窗口”来判断对方是否说完了。收到新消息后如果还想要更多上下文，设置 quietMs（例如 10000~20000）继续等一小段没有新消息的时间；桥接会强制至少等后台“收到新消息后最小静默”（默认 10000ms=10 秒）再返回，防止抢话。返回 timeout=true 表示这段时间内没有等到新消息/没人说话，这不是错误；可以再用 qq_get_unread_messages / qq_get_recent_messages 查看是否有新消息，再决定继续等、发言或潜水。沉睡前观察：准备设置潜水/下一次唤醒前，必须用 timeoutMs=300000 发起一次完整观察（短等待不会满足沉睡前观察）。如果全程没人说话，返回 preSleepWaitSatisfied=true；如果等待期间等到新消息，会返回 preSleepWaitObserved=true 和 newMessages，表示你已完成一次沉睡前观察，查看后认为不需要你参与即可直接设置潜水。响应里还会给出 preSleepWaitRemainingMs，帮助你判断还差多久。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    timeoutMs: z.number().optional().describe('总等待毫秒数；普通等待默认 30000，沉睡前观察请传 300000（最大 600000）'),
    minNewMessages: z.number().optional().describe('至少等到多少条新消息才提前返回，默认 1'),
    quietMs: z.number().optional().describe('检测到新消息后继续等待的静默窗口（毫秒），用于判断对方是否说完了；建议 8000~12000，默认取 socialV2.wait.defaultQuietMs（当前 8000）')
  },
  async ({ key, token, timeoutMs, minNewMessages, quietMs }) => {
    try {
      const data = await agentApi('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_get_message_detail',
  '按 message_id 查看单条消息的完整内容、发送者、引用信息（只读）。消息对象里若有 `card` 字段，那是卡片消息（分享/小程序/音乐等）的结构化内容：**`card.url` 是完整链接，要用就用它**——`text` 里的摘要在极长时会用 `…` 截断。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 群成员备注（本地私有记忆，不改 QQ） ────────────────────────────────────
// 网关没有「群成员本地备注」接口，所以「谁是谁」只能由桥接自己记。
// 这三个工具读写的是 state/member-remarks.json，只影响 AI 视角；真·群名片
// 是另一个默认关闭的工具（qq_set_member_card）。
if (cfg.socialV2?.tools?.memberRemark !== false) {
  defineTool(
    'qq_get_member_remarks',
    '查看你给本会话群友记的备注（本地私有记忆：只有你自己能看到，不会修改对方 QQ 资料）。想认人、想不起「谁是谁」时先查这里；也可以传 q 按 QQ 号/备注/昵称/说明模糊搜。备注不会自动出现在唤醒提示里，需要你自己来查。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      q: z.string().optional().describe('可选搜索词：QQ 号 / 你起的备注 / 群昵称 / 说明文字'),
      limit: z.number().optional().describe('最多返回几条，默认 100，最大 300')
    },
    async ({ key, token, q, limit }) => {
      try {
        const params = new URLSearchParams({ key });
        if (q) params.set('q', String(q));
        if (limit) params.set('limit', String(limit));
        const data = await agentApi(`/api/socialV2/member-remarks?${params.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取成员备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  defineTool(
    'qq_set_member_remark',
    '给某个群友写/改备注，方便你以后记住他是谁。这是你自己的本地记忆（不动对方 QQ 资料、别人看不到）。remark=你给他起的短名（最多 20 字，如「老王」），note=补充说明（最多 200 字，如「写代码的，爱发猫图」）；只传一个也可以，另一个会保留原值。QQ 号可以用 qq_get_active_members 或 qq_get_recent_messages 查到。remark 和 note 都传空字符串等于删除这条备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      userId: z.string().describe('要记备注的群友 QQ 号'),
      remark: z.string().optional().describe('你给他起的短名，最多 20 字；空字符串表示清空短名'),
      note: z.string().optional().describe('补充说明，最多 200 字；空字符串表示清空说明')
    },
    async ({ key, token, userId, remark, note }) => {
      try {
        const payload = { key, userId: String(userId) };
        if (remark !== undefined) payload.remark = String(remark);
        if (note !== undefined) payload.note = String(note);
        const data = await agentApi('/api/socialV2/member-remark', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录成员备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  defineTool(
    'qq_remove_member_remark',
    '删掉某个群友的本地备注（只删你自己的记忆，不影响 QQ）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      userId: z.string().describe('要删掉备注的群友 QQ 号')
    },
    async ({ key, token, userId }) => {
      try {
        const data = await agentApi('/api/socialV2/member-remark-remove', {
          method: 'POST',
          body: JSON.stringify({ key, userId: String(userId) }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `删除成员备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// 真·QQ 群名片：默认关闭。需要机器人是管理员/群主，且全群可见——是「正名」而不是「记忆」。
if (cfg.socialV2?.tools?.setMemberCard === true) {
  defineTool(
    'qq_set_member_card',
    '修改 QQ 群里的真实群名片（set_group_card）。注意：这是公开写操作，全群都能看到，而且机器人必须是管理员/群主；当记忆用请改用 qq_set_member_remark。默认关闭，只有管理员显式打开 socialV2.tools.setMemberCard 才可用。card 传空字符串表示清除群名片。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      userId: z.string().describe('要改群名片的群友 QQ 号'),
      card: z.string().describe('新的群名片，最多 60 字；空字符串表示清除')
    },
    async ({ key, token, userId, card }) => {
      try {
        const data = await agentApi('/api/socialV2/set-member-card', {
          method: 'POST',
          body: JSON.stringify({ key, userId: String(userId), card: String(card ?? '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改群名片失败：${error?.message ?? error}（机器人需要是管理员/群主）` }], isError: true };
      }
    }
  );
}

defineTool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表（按出现次数排序）。遇到不熟悉的词先查这里：命中就直接按含义/用法自然使用；这里没有的词，再用 qq_lookup_meme（能联网现学 B 站视频与高赞评论里的真实用法）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 群知识库：问题→答案 的沉淀与复用 ───────────────────────────────────────
// 与黑话库的分工：黑话管「这个词什么意思」，知识库管「这个问题的答案是什么」。
// 唤醒提示里已按话题自动注入相关答案，这里是 AI 主动查 / 主动写的入口。
if (cfg.knowledge?.enabled !== false) {
  defineTool(
    'qq_knowledge_query',
    '查群知识库里已经沉淀好的答案（只读）。碰到「XX 是什么/什么时候/怎么弄/谁是」这类群友以前可能问过的问题，先查这里：命中就直接用那条答案，别重新联网考据一遍；但**命中不等于答案不能改**——如果你这次知道得更多、或发现那条已经过时/不对，就照常回答，并用 qq_knowledge_submit 把更准的答案更新上去。没命中说明是新问题，正常回答就好，答完用 qq_knowledge_submit 存一条。返回里还会带 repeats（被反复问过、该把答案弄准的条目）与 conflicts（答案互相矛盾、待管理员裁定的条目）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      question: z.string().optional().describe('可选：要查的问题原文（如「DeepSeek 什么时候开源的」）。不传则列出命中次数最高的若干条。'),
      kind: z.enum(['fact', 'rule', 'person', 'howto']).optional().describe('可选：按类型过滤。fact=客观事实，rule=群规，person=人物/称呼，howto=操作步骤'),
      limit: z.number().optional().describe('可选：最多返回几条，默认 40（传了 question 时默认更大，便于精确匹配）')
    },
    async ({ key, token, question, kind, limit }) => {
      try {
        const qs = new URLSearchParams({ key });
        if (question) qs.set('q', String(question));
        if (kind) qs.set('kind', String(kind));
        if (limit !== undefined && limit !== null) qs.set('limit', String(limit));
        const data = await agentApi(`/api/socialV2/knowledge/query?${qs.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `查询知识库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  defineTool(
    'qq_knowledge_submit',
    '把一条知识沉淀进群知识库，之后有人问到会直接命中（默认全自动生效，管理员可随时删改）。**判断可以宽松一点**：只要是一条以后可能还用得上的知识就存——客观事实、版本时间、价格、原理、操作步骤、群规、称呼指代、群友的固定偏好都算。去重是自动的：同一个问题换着说法问会合并到同一条并累计次数，所以不用怕重复。**同一条被反复问到时，答案会持续更新**（新版本号、新价格、更准的结论都该覆盖旧的），所以再遇到已经存在的问题，如果这次你知道得更多、或发现旧答案不对，就用同样的 question 提交一次，它会把那条更新掉（旧答案被完整替换，修订次数 +1）。只有这些别存：闲聊玩梗、时效性极强的一次性信息（如「今天几点开播」）、你自己都不确定的猜测。若某个已有条目的答案与事实不符，用 conflictOf 传那条 id 标记冲突，管理员会在控制台裁定。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      question: z.string().describe('问题原话（规范一点，如「DeepSeek 什么时候开源的」，最多 200 字）'),
      answer: z.string().describe('答案：简明、可直接照读，带上关键数字/时间/前提，最多 2000 字'),
      kind: z.enum(['fact', 'rule', 'person', 'howto']).optional().describe('类型，默认 fact。rule=群规，person=人物/称呼指代，howto=操作步骤'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["电竞","股票"]'),
      aliases: z.array(z.string()).optional().describe('可选：同一问题的其他问法（有助于合并命中）'),
      sources: z.array(z.string()).optional().describe('可选：来源 URL（只收 http/https），便于以后核对'),
      asker: z.string().optional().describe('可选：这次是谁问的（群名片或昵称），用于统计「几个人问过」'),
      evidence: z.string().optional().describe('可选：提问时的原话片段，最多 200 字'),
      conflictOf: z.string().optional().describe('可选：要标记冲突的已有条目 id（答案与事实不符时用）')
    },
    async ({ key, token, question, answer, kind, tags, aliases, sources, asker, evidence, conflictOf }) => {
      try {
        const data = await agentApi('/api/socialV2/knowledge/submit', {
          method: 'POST',
          body: JSON.stringify({
            key,
            question,
            answer,
            kind: kind || '',
            tags: tags || [],
            aliases: aliases || [],
            sources: sources || [],
            asker: asker || '',
            evidence: evidence || '',
            conflictOf: conflictOf || ''
          }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `沉淀知识失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  defineTool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情] 或 hasMedia=true 时调用。支持一条消息里的多张图片/表情；二代模式下必须携带会话令牌。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  defineTool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        const q = new URLSearchParams({ key });
        if (query) q.set('query', String(query));
        if (count != null) q.set('count', String(count));
        if (refresh) q.set('refresh', '1');
        const data = await agentApi(`/api/socialV2/sticker-list?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  defineTool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${data?.error || '未知'}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  defineTool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  defineTool(
    'qq_collect_sticker',
    '收藏当前会话里别人（群友/好友）发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。**这是收藏聊天里图片的首选工具**：它由网关直接取图片字节，不受图床白名单限制、也不怕临时链接过期，所以聊天里看到的图就用它，不要拿 media.url 去调 qq_save_sticker。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.image?.enabled !== false && cfg.socialV2?.tools?.saveSticker !== false) {
  defineTool(
    'qq_save_sticker',
    '把一张**外部**图片保存进你的 QQ 收藏表情库（保存后就能用 qq_send_sticker 发送）。image 可以是本地图库文件名、data:image/...;base64 或裸 base64；默认不允许远程 URL（除非管理端打开了 socialV2.image.allowRemoteUrl，那时可以传 http(s) 图片直链，但目标站点必须命中 socialV2.image.refererAllow 白名单）。**注意：聊天里别人发的图片/表情不要用这个工具**——那种图请用 qq_collect_sticker(messageId=那条消息)，它走网关取字节，不受白名单限制也不怕链接过期；只有图库图片、base64、或白名单图床（B 站等）上的外部图才用本工具。remark 写一句最多 20 字的备注帮你以后认出来。不要频繁保存，先看图确认内容。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      image: z.string().describe('图片来源：本地图库文件名 / data:image/...;base64 / 裸 base64 / http(s) 图片直链（需管理端开启远程）'),
      source: z.string().optional().describe('来源类型，可选 auto / library / base64 / url；一般不用传'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“B站梗图”')
    },
    async ({ key, token, image, source, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/save-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, image: String(image), source: source || 'auto', remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 180000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `保存表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.pickSticker !== false) {
  defineTool(
    'qq_pick_sticker',
    '「现在适不适合发表情包 + 该发哪张」的专用工具。它先做时机判断（冷却、本轮是否已发过、语境是否偏严肃），再从「你的 QQ 收藏表情 + 本地图库」里按当前语境/心情打分排序给出候选；如果本地都不够合适，会自动去网上找一批（偏二次元 / DeepSeek 二创 / 梗图风格）返回图片直链。返回里的 candidates[i].id 可以直接用 send 参数发出去（本地候选走收藏表情库），online[i].url 也能用 send 发（按图片直发）。不确定发哪张、或收藏里没有对得上语境的时候用它；一次只发一张，别把它当刷图工具。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      context: z.string().optional().describe('当前语境/心情描述，例如「群友在嘲笑我菜，我想回一张不服气的」。不传则用会话最近消息自动判断'),
      topic: z.string().optional().describe('话题词（联网找图时用），例如「原神」「考试」'),
      limit: z.number().optional().describe('返回候选数，默认取配置（通常 5）'),
      minScore: z.number().optional().describe('本地候选的合格分（0~100），低于它才联网兜底；不传用配置'),
      searchOnline: z.boolean().optional().describe('是否强制/禁止联网兜底；不传=本地不够好时自动联网'),
      preview: z.boolean().optional().describe('要不要把候选图直接返回给你看（最多 2 张，视觉模型可看图）。本地图库（lib: 开头）的条目没有含义描述，不确定长什么样时传 true'),
      send: z.object({
        id: z.string().optional().describe('本地候选的 id（来自 candidates）'),
        url: z.string().optional().describe('联网候选的 url（来自 online）'),
        replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（可选）'),
        atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（可选）')
      }).optional().describe('要直接发出去时传：本地候选传 id，联网候选传 url；不传则只返回候选不发')
    },
    async ({ key, token, context, topic, limit, minScore, searchOnline, preview, send }) => {
      try {
        const data = await agentApi('/api/socialV2/pick-sticker', {
          method: 'POST',
          body: JSON.stringify({
            key,
            context: context || '',
            topic: topic || '',
            limit,
            minScore,
            searchOnline: typeof searchOnline === 'boolean' ? searchOnline : undefined,
            preview: preview === true,
            send: send && (send.id || send.url) ? send : null
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 180000
        });
        const content = [{ type: 'text', text: JSON.stringify(data, null, 2) }];
        // 预览图跟着结果一起进视觉上下文，让 AI 真的「看图选表情」
        for (const p of (Array.isArray(data?.previews) ? data.previews : [])) {
          if (!p?.data || !p?.mimeType) continue;
          content.push({ type: 'text', text: `候选预览：${p.label || p.id}` });
          content.push({ type: 'image', mimeType: String(p.mimeType), data: String(p.data) });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `挑表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.image?.enabled !== false && cfg.socialV2?.tools?.sendImage !== false) {
  defineTool(
    'qq_send_image',
    '直接发送一张图片到当前会话（不会存进收藏表情库；想长期留存请用 qq_save_sticker）。image 可以是本地图库文件名、data:image/...;base64 或裸 base64；默认不允许远程 URL（除非管理端打开了 socialV2.image.allowRemoteUrl，那时可以传 http(s) 图片直链）。注意：一条消息只能是一张图，不能在同一气泡里附带文字；想说话请先用 qq_send_message 单独发。需要引用/点名时可用 replyToMessageId（群聊可 atUserId）。**同一张图（按 pixiv 作品 id / URL）在防重复窗口内只能发一次**：重发会被直接拒绝并提示，换一张，别硬撞。返回里的 delivered 是三态：true=确认送达；false=查明确实没送达（多半被 QQ 审核静默吞了，换一张）；**null=已提交给网关但回执没确认出来**（大图走 WS 时常见）——此时绝对不要重发同一张，重复图就是这么来的，照常接话即可。不要刷图。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      image: z.string().describe('图片来源：本地图库文件名 / data:image/...;base64 / 裸 base64 / http(s) 图片直链（需管理端开启远程）'),
      source: z.string().optional().describe('来源类型，可选 auto / library / base64 / url；一般不用传'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, image, source, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-image', {
          method: 'POST',
          body: JSON.stringify({ key, image: String(image), source: source || 'auto', replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 180000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 工作车道：把慢活丢到独立会话，聊天这边不用等 ─────────────────────────
// 一个 QQ 会话只有一个 DSH session，而 DSH 一次只跑一个 turn：一次 pixiv 取图（上限 110s）
// 或十几 MB 的图发送，就会让群里这段时间问什么都被压后。qq_run_task 把这类任务投给
// 独立的工作车道会话，**立即返回**，聊天会话照常应答；跑完结论会自动回投给你。
if (cfg.socialV2?.tools?.runTask !== false) {
  defineTool(
    'qq_run_task',
    '把一个**耗时的长任务**交给独立的工作车道去跑，立即返回，不占用你当前这一轮。\n'
    + '什么时候该用：任务里有慢步骤，你不想让群里等——典型是「找一张 XX 的图并发出去」'
    + '（pixiv 取图+大图发送可能要 1~2 分钟）、「看几个 B 站视频再总结」、「多条链接/多处搜索汇总结论」。\n'
    + '什么时候不该用：一句话就能答的、纯聊天、查群知识库、看未读消息——这些自己做完更快。\n'
    + '工作车道拿到的是**独立的新会话**，看不到你们的聊天上下文，所以 task 必须写成自包含的一句话'
    + '（对象、数量、要发到哪里、有什么要求都写清楚），细节放 note。\n'
    + '它的能力和你一样（同一套 qq_* 工具），会自己把图/消息发到群里；跑完把结论回投给你，'
    + '你到时候再决定要不要跟群友补一句。**投完不要在本轮里反复查进度**——继续接别的话，结论会自己回来。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      task: z.string().describe('自包含的任务描述，一句话说清要做什么（例如「用 pixiv 搜一张初音未来的图，挑 1 张发到本会话」）'),
      note: z.string().optional().describe('补充说明：风格/角色/数量/上下文线索等')
    },
    async ({ key, token, task, note }) => {
      try {
        const data = await agentApi('/api/socialV2/run-task', {
          method: 'POST',
          body: JSON.stringify({ key, task: String(task), note: note ? String(note) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `交给工作车道失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── B站视频理解：搜视频 → 读字幕 → 按需取画面 ─────────────────────────────
// 这三件套合起来等于「看懂 B站视频」，且不需要任何额外凭据。
// 实测：字幕可得 5/8 视频、画面可得 8/8，两者互补；49 分钟复盘字幕约 4700 token。
if (cfg.socialV2?.tools?.video !== false) {
  defineTool(
    'qq_video',
    'B站视频：给 word 就**搜视频**，给 bvid 就**读它的字幕文字稿**。\n'
    + '· 搜视频：中文的时事、赛事、影视、游戏、梗、热点**优先用这个而不是 web_search**——B站的标题本身就是结论摘要（如「深度复盘BLG不敌HLE痛失冠军」），比抓网页搜索准得多。返回 bvid 列表。\n'
    + '· 读字幕：返回该视频里实际说的话（B站 AI 字幕）+ 元数据 + 字数/token 估算。不用下载视频、不用语音识别。长视频用 offset/limit 分段读，避免一次塞太多。\n'
    + '⚠️ AI 字幕有识别错误，**人名/英雄名/专有名词经常不对**（例如「安蓓萨」被写成「安萨」）：总结观点可以，引用具体名词要存疑。没有字幕时会返回 available:false，那就改用 qq_video_frames 看画面。\n'
    + '想看画面用 qq_video_frames（按时间点取帧）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      word: z.string().optional().describe('搜索词，例如「BLG HLE MSI 决赛 复盘」。给了它就搜视频（返回 bvid 列表）'),
      bvid: z.string().optional().describe('视频 bvid，例如 BV1Uh3e6uETs。给了它就读这个视频的字幕'),
      offset: z.number().optional().describe('读字幕时从第几段开始（默认 0）'),
      limit: z.number().optional().describe('读字幕时读多少段（默认全部，最大 600）。只是想先看看讲了什么，可以传 60 左右'),
      searchLimit: z.number().optional().describe('搜视频时返回几条，默认 8，最大 20')
    },
    async ({ key, token, word, bvid, offset, limit, searchLimit }) => {
      const hasWord = String(word ?? '').trim().length > 0;
      const hasBvid = String(bvid ?? '').trim().length > 0;
      if (hasWord === hasBvid) {
        return {
          content: [{ type: 'text', text: '请二选一：给 word 搜视频，或给 bvid 读字幕（两个都传或都不传都无法判断意图）。' }],
          isError: true
        };
      }
      try {
        const body = hasWord
          ? { key, token, op: 'search', word: String(word), limit: searchLimit }
          : { key, token, op: 'subtitle', bvid: String(bvid), offset, limit };
        const data = await agentApi('/api/socialV2/bili-video', {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'x-agent-token': token },
          timeoutMs: hasWord ? 30000 : 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `${hasWord ? '搜 B站' : '读字幕'}失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.videoFrames !== false) {
  defineTool(
    'qq_video_frames',
    '取 B站视频**某个时间点的画面**（若干帧，直接以图像返回给你看）。来源是 B站进度条预览图，约每 5 秒一帧、480×270，所以：能看清比分板/阵容/大致场面，看不清小字和瞬时操作，也可能正好错过团战那几秒。**不要盲目扫全片**（600 帧≈60 万 token），正确用法是先读字幕定位到关键时间点，再取那附近几帧确认画面。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      bvid: z.string().describe('视频 bvid'),
      atSeconds: z.number().describe('要看的时刻（秒），通常来自 qq_video（传 bvid 读字幕）返回的时间点'),
      count: z.number().optional().describe('取几帧，默认 4，最大 12（越多越费上下文）'),
      spreadSeconds: z.number().optional().describe('以该时刻为中心向两侧摊开的秒数，默认 0（只取最近几帧）；想观察一段过程可设 20~60')
    },
    async ({ key, token, bvid, atSeconds, count, spreadSeconds }) => {
      try {
        const data = await agentApi('/api/socialV2/bili-frames', {
          method: 'POST',
          body: JSON.stringify({ key, token, bvid: String(bvid), atSeconds, count, spreadSeconds }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `没取到画面：${data?.error || data?.failures?.map((f) => f.error).join('; ') || '该视频可能没有预览图'}` }] };
        }
        const content = [{
          type: 'text',
          text: `《${data.title}》共 ${Math.round((data.duration || 0) / 60)} 分钟，以下是 ${images.map((i) => `${i.at}s`).join('、')} 处的画面（480×270 预览帧）：`
        }];
        for (const im of images) content.push({ type: 'image', mimeType: im.mimeType, data: im.data });
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `取画面失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.slang?.enabled !== false && cfg.socialV2?.tools?.lookupMeme !== false) {
  defineTool(
    'qq_lookup_meme',
    '遇到不懂的网络梗/黑话时先查再回。顺序：① 本地黑话库（已确认的直接返回释义/用法/例句）；② 10 分钟内的查询缓存；③ 没命中就去 B 站搜相关视频与**高赞评论**（评论通常就是这个梗最真实的用法与出处）。第 ③ 步有硬预算（几秒），超时会先返回视频标题、并把深度考究转入后台，因此不会拖慢你的回复；查不到就按上下文自然接话，别硬套术语也别自己编。若这里仍不够，可用 mcp__web-search-safe__web_search 查萌娘百科等（本机直连贴吧会被反爬）。新学到的词会自动进后台考究并在出释义后转正，不必反复提交。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      word: z.string().describe('要查的梗/黑话/表达，例如「那你无敌了」「班味」')
    },
    async ({ key, token, word }) => {
      try {
        const data = await agentApi('/api/socialV2/lookup-meme', {
          method: 'POST',
          body: JSON.stringify({ key, word: String(word), token }),
          headers: { 'x-agent-token': token },
          timeoutMs: 15000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        // 明确告诉模型「不要再试」：查梗只是加分项，卡住回复才是损失。
        return { content: [{ type: 'text', text: `学梗查询失败或超时（${error?.message ?? error}）。不要重试，直接按上下文自然回应即可。` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getFriendDress !== false) {
  defineTool(
    'qq_get_friend_dress',
    '查看某个 QQ 号正在使用的个性装扮（头像框/挂件、名片、双击动作、来电等）。返回每项的 kind/name 与预览图；withImage=true 时会把「挂件」预览图取回来放进你的视觉上下文。适合「你这头像框哪来的」「看看某人装扮」这类话题。目标没设置装扮时 items 为空数组，不要编造。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      userId: z.string().describe('目标 QQ 号'),
      withImage: z.boolean().optional().describe('是否把挂件预览图取回来看（默认 false）')
    },
    async ({ key, token, userId, withImage }) => {
      try {
        const q = new URLSearchParams({ key, userId: String(userId) });
        if (withImage) q.set('withImage', '1');
        const data = await agentApi(`/api/socialV2/friend-dress?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 90000
        });
        const content = [{ type: 'text', text: JSON.stringify({ ok: data?.ok, userId: data?.userId, isSvip: data?.isSvip, items: data?.items, imageError: data?.imageError, error: data?.error }, null, 2) }];
        if (data?.image?.data) content.push({ type: 'image', mimeType: data.image.mimeType || 'image/png', data: data.image.data });
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查询装扮失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getMemberAvatar !== false) {
  defineTool(
    'qq_get_member_avatar',
    '查看某个群成员（或本群）的头像图片。userId 传群友 QQ 号；想群头像就传 "group"。返回的图片会直接进入你的视觉上下文，可以描述、玩梗或吐槽。适合「这人头像好怪」「看看某人长什么样」「群里换头像了吗」这类场景；不要频繁刷（每次调用都要下载一张图）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      userId: z.string().describe('群成员 QQ 号；传 "group" 表示本群群头像'),
      size: z.union([z.number(), z.string()]).optional().describe('头像尺寸，可选 40/100/140/640，默认 640')
    },
    async ({ key, token, userId, size }) => {
      try {
        const q = new URLSearchParams({ key, userId: String(userId) });
        if (size) q.set('size', String(size));
        const data = await agentApi(`/api/socialV2/member-avatar?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        if (!data?.data) return { content: [{ type: 'text', text: `取头像失败：${data?.error || '没有图片数据'}` }], isError: true };
        return {
          content: [
            { type: 'text', text: `用户 ${userId} 的头像（${data.mimeType || 'image'}，来源 ${data.avatar}）` },
            { type: 'image', mimeType: data.mimeType || 'image/jpeg', data: data.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `取头像失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.image?.enabled !== false && cfg.socialV2?.tools?.searchImages !== false) {
  defineTool(
    'qq_search_images',
    '按聊天主题/关键词找图，返回候选图片 URL。**图源默认 auto：先按中文标签试 pixiv，没有结果自动回退 B 站**（`notes` 里会写明走的哪边）。显式指定：`source=pixiv` 走 pixiv 插画/角色图/画师作品（搜图用 bobopic 榜单镜像 + pixiv 官方 ajax；取图由桥接走管理员配的代理 + i.pximg 原图/master1200，第三方 pixiv.re 只是兜底。pixiv 本机直连不通，取图慢或失败都是代理通道的问题、**不是白名单**，别跟群友解释成「pixiv 没被放行」），关键词用中文标签（如「初音未来」「原神」），`mode=daily` 取 pixiv 综合日榜（不用给 query）；`source=bilibili` 走 B 站梗图/表情包（评论区取图，不含封面，很多 .gif 其实是单帧静态图，要真动图传 animatedOnly=true）；`source=all` 两边都搜。**中文 VTuber/主播/国内梗这类 pixiv 收录很少的，直接用 bilibili 或 auto**，别在 pixiv 上硬搜。返回项里 `url` 可直接交给 qq_send_image（source=url）发送，或用 qq_save_sticker（source=url）存进收藏表情库；`url` 就是原图直链，桥接会自己逐级回退（原图 → 1200px → 缩略图），**别用 thumbUrl 代替它**（pixiv 的 thumbUrl 是 250×250 方形裁切图/220px 小图，发出去分辨率就是错的），只有报「图片超过体积上限」时才考虑 thumbUrl；`qq_send_image` 的回执里带 `rendition`（original/large/thumb）与 `size`，退到 large/thumb 时照实说明画质，别把 1200px 说成原图。**图片年龄分级由管理员在控制台配置（safe=只给全年龄 / mild=允许轻度擦边 / r18=允许 R-18，最后这档需要管理员配了「真实 pixiv + 登录 cookie」），AI 不能自己调，也不要把分级当成可以商量的东西**；返回里 rating/notes 会告诉你滤掉了什么。适合「群友聊到某个话题，你去找一张应景的图」，不要刷屏，一次挑 1~2 张合适的即可。搜索需要出网，有频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('搜索关键词：bilibili 用话题词（如「猫咪 搞笑」）；pixiv 用中文标签（如「初音未来」「原神」）；source=pixiv 且 mode=daily 时可以不给'),
      count: z.number().optional().describe('最多返回几张，默认 6，最大 12'),
      source: z.enum(['auto', 'bilibili', 'pixiv', 'all']).optional().describe('图源：auto=先试 pixiv、没结果自动回退 B 站（默认，拿不准就用它）；bilibili=梗图/表情包；pixiv=二次元插画/角色图（中文标签）;all=两边都搜'),
      mode: z.enum(['tag', 'daily']).optional().describe('pixiv 专用：tag=按关键词搜标签页（默认）；daily=pixiv 综合日榜（query 可省）'),
      sources: z.array(z.enum(['article', 'comment'])).optional().describe('bilibili 专用：图片来源，默认 [comment, article]（评论优先）'),
      animatedOnly: z.boolean().optional().describe('bilibili 专用：只返回真动图（会逐张下载探测帧数）')
    },
    async ({ key, token, query, count, source, mode, sources, animatedOnly }) => {
      try {
        const data = await agentApi('/api/socialV2/search-images', {
          method: 'POST',
          body: JSON.stringify({
            key,
            query: String(query ?? ''),
            count: count ?? 6,
            source: source ?? 'auto',
            mode: mode === 'daily' ? 'daily' : 'tag',
            sources: sources && sources.length ? sources : ['comment', 'article'],
            animatedOnly: animatedOnly === true
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `搜图失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.image?.enabled !== false && cfg.socialV2?.tools?.listImageLibrary !== false) {
  defineTool(
    'qq_list_image_library',
    '列出本地图库里可用的图片（assets/stickers/ 与 index.json）。想发这些图时，用 qq_send_image（直接发）或 qq_save_sticker（先存进收藏表情库）并把 source 设为 library、image 传返回的 file 文件名。file 是纯文件名，不能带路径。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('按文件名/标题/来源过滤，可省'),
      limit: z.number().optional().describe('最多返回多少条，默认 50，最大 200')
    },
    async ({ key, token, query, limit }) => {
      try {
        const q = new URLSearchParams({ key });
        if (query) q.set('query', String(query));
        if (limit) q.set('limit', String(limit));
        const data = await agentApi(`/api/socialV2/image-library?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取本地图库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  defineTool(
    'qq_get_self_image',
    '查看你自己的默认 Q 版形象图片（DeepSeek 小鲸鱼形象）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${data?.error || '未知'}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  defineTool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  defineTool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  defineTool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）、card（卡片消息，`card.url` 是完整链接）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: JSON.stringify(data, null, 2) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  }
  } finally {
    server.sendToolListChanged = notify;
  }
}

registerAllTools();
installConfigWatcher();

await server.connect(new StdioServerTransport());
