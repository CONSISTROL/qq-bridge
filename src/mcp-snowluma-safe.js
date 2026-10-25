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

// 桥接控制台/内部 Agent API 访问：聊天模式的状态工具都通过这里读写桥接内存态。
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
    const error = new Error(body?.error || `桥接 API HTTP ${res.status}`);
    // 「回执超时、连历史都查不到」不是普通失败：消息可能已经发出，重发就是重复消息。
    // 把这个标记透出去，发送类工具据此返回**非错误**结果（报错会诱导模型重发）。
    if (body?.uncertain === true) error.uncertain = true;
    // 桥接的「自我重复闸门」把这条打回了（没发出去）：也要让工具返回非错误结果，
    // 附上跟哪条撞了，好让模型换个题——报错的话它多半会原样重发。
    if (body?.selfRepeat === true) { error.selfRepeat = true; error.detail = body.detail ?? null; }
    // 原样重发闸门：桥接**有意拒发**（不是发送失败）。同样要透出去，
    // 否则模型看到 isError 会继续重试，只是白撞墙。
    if (body?.duplicateGuard === true) { error.duplicateGuard = true; error.detail = body.detail ?? null; }
    throw error;
  }
  return body;
}

/** 发送类工具的统一失败出口：不确定 → 非错误结果并明确劝阻重发；硬失败 → isError。 */
function sendFailureResult(error, prefix = '发送失败') {
  if (error?.selfRepeat === true) {
    const d = error.detail ?? {};
    const when = d.at ? new Date(Number(d.at)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
    const sim = Number.isFinite(Number(d.sim)) ? `相似度 ${Number(d.sim).toFixed(2)}` : '';
    return {
      content: [{
        type: 'text',
        text: '🚫 这条被桥接的「自我重复闸门」拦下了：它和你之前**主动开过的题**几乎一样'
          + (when ? `（${when}` : '（') + (sim ? `，${sim}` : '') + (when || sim ? '）' : '')
          + (d.text ? `：「${String(d.text).slice(0, 60)}」` : '')
          + '。\n**这一轮别再发同一套了**：换个完全不同的题材，或者同一题材里换一个真正不一样的角度；'
          + '发之前先看一眼上面【更早你主动开过的】那份清单。这条只拦一次，你换过之后就能发出去。'
      }]
    };
  }
  if (error?.duplicateGuard === true) {
    const d = error.detail ?? {};
    // 桥接只给时间戳，年龄在这里算（跨进程传时间戳比传「几秒前」稳）。
    const age = Number.isFinite(Number(d.at)) && Number(d.at) > 0
      ? Math.max(1, Math.round((Date.now() - Number(d.at)) / 1000))
      : null;
    return {
      content: [{
        type: 'text',
        text: '🛑 桥接拦下了这次发送：**它和你刚刚（' + (age != null ? `${age} 秒前` : '刚才') + '）发过的那条一模一样**'
          + (d.text ? `：「${String(d.text).slice(0, 60)}」` : '')
          + '。\n如果上一条回执丢了，它**很可能已经在群里**了，重发就会变成两条。'
          + '\n**别急着换个说法硬发**：先用 qq_get_recent_messages 看一眼——'
          + '在 → 当发过了，直接接下一句；不在 → 换个说法（不是改标点）再发。'
      }]
    };
  }
  if (error?.uncertain === true) {
    return {
      content: [{
        type: 'text',
        text: '⚠️ 这条的回执超时了，桥接查过历史也没能确认送达：**它可能已经发出去了**。'
          + '**不要原样重发**（重发很可能在群里变成两条一样的消息）。'
          + '先用 qq_get_recent_messages 看一眼最后几条：确认没发出去，再重发；已经在，就当发过了。'
      }]
    };
  }
  return { content: [{ type: 'text', text: `${prefix}：${error?.message ?? error}` }], isError: true };
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
    // 旧只读工具没有 agent token；聊天模式下通过桥接 /api/status 直接拒绝，
    // 避免绕过聊天模式的令牌隔离。
    try {
      const status = await agentApi('/api/status');
      if (status?.mode === 'chat') {
        return { content: [{ type: 'text', text: '聊天模式下旧只读工具不可用，请使用带会话令牌的 v2 读工具' }], isError: true };
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
  '列出指定群的成员列表（只读）：QQ 号、昵称、群名片，以及 QQ 群的**真实身份** role'
    + '（owner=群主，admin=群管理员，member=普通成员），并在开头单列「本群群主」。'
    + '注意：「谁是群主」只以这个工具返回的 role 为准——消息里带的【管理员】是**桥接管理员（ownerQQ，控制台里配置你的那个人）**，'
    + '跟 QQ 群主不是一回事，不要因为某人带【管理员】就把他叫成群主。'
    + '聊天模式下必须同时传 token（唤醒提示里的【会话令牌】），否则会被拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号'),
    token: z.string().optional().describe('会话令牌（聊天模式必填；见唤醒提示中的【会话令牌】）')
  },
  async ({ groupId, token }) => {
    const g = String(groupId);
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中。白名单：${a.allowGroups.join(', ') || '（空）'}` }], isError: true };
    }
    try { await authorizeRead(`group:${g}`, token); } catch (error) {
      return { content: [{ type: 'text', text: `拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    try {
      const data = await onebot('get_group_member_list', { group_id: Number(g) });
      const roleRank = { owner: 0, admin: 1, member: 2 };
      const roleZh = (r) => (r === 'owner' ? '群主' : r === 'admin' ? '群管理员' : r === 'member' ? '普通成员' : '未知');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
        .map((m) => ({
          user_id: m.user_id,
          nickname: m.nickname,
          card: m.card,
          role: m.role ?? null,
          roleLabel: roleZh(m.role)
        }))
        .sort((x, y) => (roleRank[x.role] ?? 9) - (roleRank[y.role] ?? 9));
      const owner = list.find((m) => m.role === 'owner');
      const admins = list.filter((m) => m.role === 'admin');
      const head = owner
        ? `本群群主：${owner.card || owner.nickname}（${owner.user_id}）${
          admins.length ? `；群管理员：${admins.map((m) => `${m.card || m.nickname}（${m.user_id}）`).join('、')}` : ''
        }\n\n`
        : '';
      return { content: [{ type: 'text', text: head + JSON.stringify(list, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。**聊天模式下这个工具会被拒绝**（旧只读工具不带会话令牌）——要看最近消息、或者想确认自己刚发的那条到底发出去没有，请改用 `qq_get_recent_messages`。是否可用还取决于 SnowLuma 是否实现 get_group_msg_history。',
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
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。聊天模式下这是可用的发送工具之一，但优先使用 qq_send_message；聊天模式 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('会话令牌（chat 模式下必填）')
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
      return sendFailureResult(error);
    }
  }
);

defineTool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息，并发送一条文本。适合群消息很多、需要明确“我回的是哪条”时使用；replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id。发送前桥接会校验该 id 存在且属于当前会话。聊天模式下这是你正常可用的引用工具，但不要每条都引用。只有以下情况才需要引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。聊天模式 下调用时必须携带会话令牌 token。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('会话令牌（chat 模式下必填）')
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
      return sendFailureResult(error);
    }
  }
);

defineTool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。聊天模式下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('会话令牌（chat 模式下必填）')
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
      return sendFailureResult(error);
    }
  }
);

// ── 聊天模式工具 ─────────────────────────────────────────
defineTool(
  'qq_get_prompt',
  '查看当前聊天模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialData/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
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
      const data = await agentApi(`/api/socialData/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。消息对象里若有 `card` 字段，那是卡片消息（分享/小程序/音乐等）的结构化内容：**`card.url` 是完整链接，要用就用它**——`text` 里的摘要在极长时会用 `…` 截断。**发送工具报「结果不确定」时，先用这个工具看最后几条确认到底发出去没有**，别不看就重发（那会在群里变成两条一样的消息）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialData/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_social_state',
  '查看指定会话的聊天模式状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialData/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_mark_read',
  '将指定会话的当前未读消息标记为已读（用于“看过但决定不回复”后避免重复未读）。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。另外：**你从没看到过的消息不会被清掉**——回执里带 keptUnread 时就说明还有没看的，先 qq_get_unread_messages 看一遍再决定。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/socialData/mark-read', { method: 'POST', body: JSON.stringify({ key }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_set_wake_config',
  '设置指定会话的唤醒触发条件（@、名字、关键词、提问、拍一拍）。注意：**已经没有「潜水」了**，mode 传 diving 也会被按全天候（active）处理；睡眠时段由服务端统一管理。概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    config: z.object({
      mode: z.enum(['active']).optional().describe('只支持 active（全天候）；旧的 diving 已废弃'),
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
      const data = await agentApi('/api/socialData/wake-config', { method: 'POST', body: JSON.stringify({ key, config }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（聊天模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
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
      const data = await agentApi('/api/socialData/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return sendFailureResult(error, '分条发送失败');
    }
  }
);

defineTool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。'
    + '**默认不要传 replyToMessageId**：群聊里每条都引用会很啰嗦；只有回很早以前的老消息、'
    + '或对方先引用了你/明确问你哪一句时才引用一次。指代对象用 atUserId 点名比引用更轻。'
    + '聊天模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。',
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
      const data = await agentApi('/api/socialData/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return sendFailureResult(error);
    }
  }
);

if (cfg.socialData?.tools?.sendPoke !== false) {
  defineTool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。聊天模式 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialData/send-poke', {
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
    quietMs: z.number().optional().describe('检测到新消息后继续等待的静默窗口（毫秒），用于判断对方是否说完了；建议 8000~12000，默认取 socialData.wait.defaultQuietMs（当前 8000）')
  },
  async ({ key, token, timeoutMs, minNewMessages, quietMs }) => {
    try {
      const data = await agentApi('/api/socialData/wait', {
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
      const data = await agentApi('/api/socialData/feedback', {
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
      const data = await agentApi(`/api/socialData/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
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
      const data = await agentApi(`/api/socialData/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。返回里 isBridgeAdmin=桥接管理员（ownerQQ，控制台里配置你的人），'
    + '**不是 QQ 群主**；QQ 群身份看 groupRole / groupRoleLabel（owner=群主，admin=群管理员，member=普通成员）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialData/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
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
      const data = await agentApi('/api/socialData/memory-append', {
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
      const data = await agentApi(`/api/socialData/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
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
      const data = await agentApi('/api/socialData/memory-remove', {
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
      const data = await agentApi('/api/socialData/memory-clear', {
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
if (cfg.socialData?.tools?.memberRemark !== false) {
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
        const data = await agentApi(`/api/socialData/member-remarks?${params.toString()}`, { headers: { 'x-agent-token': token } });
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
        const data = await agentApi('/api/socialData/member-remark', {
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
        const data = await agentApi('/api/socialData/member-remark-remove', {
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
if (cfg.socialData?.tools?.setMemberCard === true) {
  defineTool(
    'qq_set_member_card',
    '修改 QQ 群里的真实群名片（set_group_card）。注意：这是公开写操作，全群都能看到，而且机器人必须是管理员/群主；当记忆用请改用 qq_set_member_remark。默认关闭，只有管理员显式打开 socialData.tools.setMemberCard 才可用。card 传空字符串表示清除群名片。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      userId: z.string().describe('要改群名片的群友 QQ 号'),
      card: z.string().describe('新的群名片，最多 60 字；空字符串表示清除')
    },
    async ({ key, token, userId, card }) => {
      try {
        const data = await agentApi('/api/socialData/set-member-card', {
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
      const data = await agentApi(`/api/socialData/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
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
      const data = await agentApi('/api/socialData/slang/submit', {
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
        const data = await agentApi(`/api/socialData/knowledge/query?${qs.toString()}`, { headers: { 'x-agent-token': token } });
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
        const data = await agentApi('/api/socialData/knowledge/submit', {
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

// ── 图片/表情查看工具（旧模式/聊天模式共用） ─────────────────────────────────
if (cfg.socialData?.tools?.getImages !== false) {
  defineTool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[动画表情]、[表情] 或 hasMedia=true 时调用。'
      + '**卡片消息也算**：B站小程序卡、链接分享卡自带封面/预览图（媒体标签是 [卡片封面]），群友聊「封面」时看的正是它，不要让人再发一遍。'
      + '返回里会逐项标明是「图片」还是「表情包」（QQ 动画表情）——表情包本来就是反复用的，别因为同一个人发过同一张就说「你发过了/重复了」。'
      + '支持一条消息里的多张图片/表情；聊天模式下必须携带会话令牌。'
      + '**图片多的一条消息会分批给**（默认一次 5 张）：返回里会写明「共 N 个、本次给了第几到第几」，'
      + '要看剩下的就再调用一次并传 imageOffset=<上次的下一张序号>——**不要因为只看到前几张就说「图被吞了/看不到」**。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；也可用本地 seq）'),
      imageOffset: z.number().optional().describe('从第几张开始取（0 起，默认 0）；返回里 hasMore=true 时用它继续翻页'),
      imageLimit: z.number().optional().describe('本次最多取几张（默认 5，上限 20）；一次别贪多，图片很费上下文'),
      token: z.string().optional().describe('会话令牌（下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, imageOffset, imageLimit, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        if (imageOffset != null) q.set('imageOffset', String(imageOffset));
        if (imageLimit != null) q.set('imageLimit', String(imageLimit));
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
        const labelOf = (img) => (img?.kind === 'face' ? '表情' : (img?.label || '图片'));
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${labelOf(img)}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${labelOf(img)}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          const head = `消息 ${messageId} 的媒体内容（本次 ${images.length} 项${data?.total ? `／本条共 ${data.total} 项` : ''}）：`;
          content.unshift({ type: 'text', text: `${head}\n${textParts.join('\n')}${data?.note ? `\n⚠️ ${data.note}` : ''}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── AI 自研插件（P3）：写 manifest → 自测 → 申请启用（必须人工批准）────────────
defineTool(
  'qq_plugin_dev',
  '给自己开发一个**声明式插件**（群友要的功能如果现有插件都没有，就用它）。'
    + '插件只声明 HTTP 工具/定时任务，不执行任意代码。写完进"待批准"队列，**管理员批准后才会启用**。'
    + '参数 manifest 示例：{"id":"lol-live","name":"LOL 直播","description":"查比赛是否开播",'
    + '"tools":[{"name":"check","description":"查是否在播","url":"https://api.example.com/x"}]}',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    manifest: z.string().describe('manifest 的 JSON 字符串（id/name/description/tools/jobs）')
  },
  async ({ key, token, manifest }) => {
    let parsed;
    try { parsed = JSON.parse(String(manifest)); } catch (error) { return { content: [{ type: 'text', text: `manifest 不是合法 JSON：${error.message}` }], isError: true }; }
    try {
      const data = await agentApi('/api/ai-plugins/write', {
        method: 'POST',
        body: JSON.stringify({ manifest: parsed, author: key }),
        headers: { 'x-agent-token': token },
        timeoutMs: 30000
      });
      return { content: [{ type: 'text', text: `插件 ${data.id} 已提交，${data.note || '等待管理员批准'}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交插件失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_plugin_dev_test',
  '自测你刚提交的 AI 插件：按 manifest 里的声明各请求一次，返回 HTTP 状态，用来确认 URL 可用（不会启用插件）。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    id: z.string().describe('插件 id')
  },
  async ({ key, token, id }) => {
    try {
      const data = await agentApi('/api/ai-plugins/test', {
        method: 'POST',
        body: JSON.stringify({ id }),
        headers: { 'x-agent-token': token },
        timeoutMs: 60000
      });
      const lines = (data.results || []).map((r) => `· ${r.tool}: HTTP ${r.status}${r.ok ? ' ✅' : ' ❌ ' + (r.error || '')}`).join('\n');
      return { content: [{ type: 'text', text: `自测结果（未启用，仍待管理员批准）：\n${lines || '（没有可测的 tool）'}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `自测失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 分享音乐 / 视频 ────────────────────────────────────────────────────────
defineTool(
  'qq_send_music',
  '分享一首歌：给音频直链（mp3/m4a 等）和标题，桥接下载后作为**语音条**发出去（≤60 秒的片段最合适，效果已验证）。'
    + '限制：只能是公网 http(s) 直链、单文件 ≤20MB。下载失败或服务端拒绝时才降级成「标题 + 链接」文本，不会静默失败。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    url: z.string().describe('音频公网直链（http(s)）'),
    title: z.string().optional().describe('歌名/说明（可选，会一起发出去）')
  },
  async ({ key, token, url: mediaUrl, title }) => {
    try {
      const data = await agentApi('/api/socialData/send-media', {
        method: 'POST',
        body: JSON.stringify({ key, kind: 'music', url: mediaUrl, title: title || '' }),
        headers: { 'x-agent-token': token },
        timeoutMs: 120000
      });
      return { content: [{ type: 'text', text: data.fallback ? `已发链接（${data.note}）` : `已分享音频（${Math.round((data.bytes || 0) / 1024)}KB）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分享音乐失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_send_video',
  '分享一个视频：给视频公网直链和标题，桥接下载后作为**视频段**发出去（已实测网关支持：retcode 0、正常渲染）。'
    + '限制：公网 http(s) 直链、单文件 ≤20MB；下载失败或超限时才降级成「标题 + 链接」文本。大文件慢，注意别刷屏。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    url: z.string().describe('视频公网直链（http(s)）'),
    title: z.string().optional().describe('视频标题/说明（可选）')
  },
  async ({ key, token, url: mediaUrl, title }) => {
    try {
      const data = await agentApi('/api/socialData/send-media', {
        method: 'POST',
        body: JSON.stringify({ key, kind: 'video', url: mediaUrl, title: title || '' }),
        headers: { 'x-agent-token': token },
        timeoutMs: 180000
      });
      return { content: [{ type: 'text', text: data.fallback ? `已发链接（${data.note}）` : `已分享视频（${Math.round((data.bytes || 0) / 1024)}KB）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分享视频失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 发 QQ 动态 ────────────────────────────────────────────────────────────
defineTool(
  'qq_post_moment',
  '发一条 QQ 动态（说说）到自己的空间。走网关的 send_qzone_msg，支持中文，发出去就是公开动态。'
    + '默认 **dryRun**：不传 send=true 时只返回"将要发布的内容"给你确认，不会真的发。'
    + '记住：这是对外公开的内容，不确定就先给群友看一遍文案。'
    + '删除用 qq_delete_moment（需要 tid，发的时候会返回）。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    content: z.string().describe('动态文案（支持中文，建议短一点）'),
    send: z.boolean().optional().describe('true=真的发出去；不传则只预览')
  },
  async ({ key, token, content, send }) => {
    if (send !== true) {
      return { content: [{ type: 'text', text: `（预览，未发布）将要发这条动态：\n${content}` }] };
    }
    try {
      const d = await agentApi('/api/socialData/post-moment', {
        method: 'POST', body: JSON.stringify({ content }), headers: { 'x-agent-token': token }, timeoutMs: 60000
      });
      return { content: [{ type: 'text', text: d.ok ? `已发动态（tid=${d.tid}）。要删就说一声，我用 qq_delete_moment 删。` : '发动态失败' }] };
    } catch (error) { return { content: [{ type: 'text', text: `发动态失败：${error?.message ?? error}` }], isError: true }; }
  }
);

defineTool(
  'qq_delete_moment',
  '删一条自己发的 QQ 动态（需要发的时候返回的 tid）。',
  { key: z.string().describe('会话 key'), token: z.string().describe('会话令牌'), tid: z.string().describe('动态 tid') },
  async ({ key, token, tid }) => {
    try {
      const d = await agentApi('/api/socialData/delete-moment', {
        method: 'POST', body: JSON.stringify({ tid }), headers: { 'x-agent-token': token }, timeoutMs: 60000
      });
      return { content: [{ type: 'text', text: d.ok ? `已删除动态 ${tid}` : '删除失败' }] };
    } catch (error) { return { content: [{ type: 'text', text: `删除失败：${error?.message ?? error}` }], isError: true }; }
  }
);

// ── B站 热门（冒泡找话题）────────────────────────────────────────────────
defineTool(
  'qq_bili_hot',
  '看 B站 现在什么在火（热门榜）：返回标题、UP 主、播放量、链接。'
    + '主动冒泡/找话题时**先看这个**，从里面挑一个你真有话说的（结合群里的气氛），'
    + '别自己空想题材；也可以挑一个和群里刚聊的相关视频当引子。',
  { key: z.string().describe('会话 key'), token: z.string().describe('会话令牌'), limit: z.number().optional().describe('取几条（默认 12，最多 20）') },
  async ({ key, token, limit }) => {
    try {
      const d = await agentApi(`/api/socialData/bili-hot?limit=${Number(limit) || 12}${key ? `&key=${encodeURIComponent(key)}` : ''}`, { method: 'GET', headers: { 'x-agent-token': token }, timeoutMs: 40000 });
      const lines = (d.items || []).map((v, i) => `${i + 1}. ${v.title}（${v.owner}，${Math.round((v.view || 0) / 10000)}万播放）${v.url}`).join('\n');
      return { content: [{ type: 'text', text: lines || '（拿不到热门榜）' }] };
    } catch (error) { return { content: [{ type: 'text', text: `查 B站热门失败：${error?.message ?? error}` }], isError: true }; }
  }
);

// ── Web 应用：给管理员请求做的小页面（对外公开链接）─────────────────────────
defineTool(
  'qq_webapp_save',
  '把一个小网页做出来并发布：给 slug / 标题 / 说明 / HTML，桥接会挂在 /apps/<slug>，'
    + '公网地址是 https://anihub.xin/qq/apps/<slug>（**不需要令牌**，谁拿到链接都能看）。'
    + '适合"帮我做个查询页/看板/清单/表单"。限制：纯静态页（HTML/CSS/JS 都能写，但拿不到桥接内部数据）、≤200KB。'
    + '同一个 slug 再保存一次就是更新。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    slug: z.string().describe('页面 id（小写字母/数字/短横线，如 lol-schedule）'),
    title: z.string().describe('标题'),
    html: z.string().describe('完整 HTML 源码'),
    description: z.string().optional().describe('一句话说明')
  },
  async ({ key, token, slug, title, html, description }) => {
    try {
      const d = await agentApi('/api/webapps/save', { method: 'POST', body: JSON.stringify({ slug, title, html, description }), headers: { 'x-agent-token': token }, timeoutMs: 60000 });
      return { content: [{ type: 'text', text: d.ok ? `已发布：${d.publicUrl}` : `发布失败：${d.error || ''}` }] };
    } catch (error) { return { content: [{ type: 'text', text: `发布失败：${error?.message ?? error}` }], isError: true }; }
  }
);

defineTool(
  'qq_webapp_list',
  '列出已经发布的小网页（slug / 标题 / 大小 / 时间）。',
  { key: z.string().describe('会话 key'), token: z.string().describe('会话令牌') },
  async ({ key, token }) => {
    try {
      const d = await agentApi('/api/webapps', { method: 'GET', headers: { 'x-agent-token': token }, timeoutMs: 30000 });
      const lines = (d.apps || []).map((a) => `· ${a.slug} — ${a.title}（${Math.round((a.bytes || 0) / 1024)}KB）https://anihub.xin/qq/apps/${a.slug}`).join('\n');
      return { content: [{ type: 'text', text: lines || '（还没有发布过页面）' }] };
    } catch (error) { return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true }; }
  }
);

// ── 购物平台注册表：技能自助扩充 ──────────────────────────────────────
defineTool(
  'qq_shop_platform_add',
  '给购物插件加一个电商平台（群里提到新的平台、而插件里还没有时用）。'
    + 'template 是打开搜索页的 URL/深链，用 {q} 占位关键词（例如 "snssdk1128://search?keyword={q}"）。'
    + '加完立刻可用（调用 shopping 插件时 app 传这个 id）。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    id: z.string().describe('平台 id（小写英文，如 pdd / pinduoduo）'),
    name: z.string().describe('平台名（如 拼多多）'),
    template: z.string().describe('搜索深链/URL，用 {q} 占位关键词'),
    pkg: z.string().optional().describe('Android 包名（可选）')
  },
  async ({ key, token, id, name, template, pkg }) => {
    try {
      const d = await agentApi('/api/shop/platforms/add', { method: 'POST', body: JSON.stringify({ id, name, template, pkg, source: 'ai' }), headers: { 'x-agent-token': token }, timeoutMs: 30000 });
      return { content: [{ type: 'text', text: d.ok ? `已加入平台 ${d.platform?.name}（${d.platform?.id}），现在可以用 shopping 插件搜它了` : `没加成：${d.error || ''}` }] };
    } catch (error) { return { content: [{ type: 'text', text: `加平台失败：${error?.message ?? error}` }], isError: true }; }
  }
);

// ── 画图（豆包 Seedream）──────────────────────────────────────────────────
defineTool(
  'qq_memory_resolve',
  '处理一条「待核实的记忆候选」：**核实之后**再决定记不记。verdict=confirmed 表示查证属实（会把 text 作为准确表述写入长期记忆），'
    + 'wrong 表示原判断有误（可给出正确 text），skip 表示没查到/不值得记。source 填你查证的来源（链接/百科/群里谁说的）。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    id: z.string().describe('候选 id（形如 c1abc23）'),
    verdict: z.enum(['confirmed', 'wrong', 'skip']).describe('confirmed 属实 / wrong 有误 / skip 不记'),
    text: z.string().optional().describe('核实后的准确表述（confirmed/wrong 时建议给）'),
    source: z.string().optional().describe('来源：链接 / 百科名 / 「群里 XX 说的」')
  },
  async ({ key, token, id, verdict, text, source }) => {
    try {
      const d = await agentApi('/api/memory/pending/resolve', {
        method: 'POST', body: JSON.stringify({ key, id, verdict, text, source }),
        headers: { 'x-agent-token': token }, timeoutMs: 12000
      });
      if (!d.ok) return { content: [{ type: 'text', text: `处理失败：${d.error || '未知原因'}` }], isError: true };
      return { content: [{ type: 'text', text: verdict === 'confirmed' ? '已核实并写入记忆' : verdict === 'wrong' ? '已按正确内容修正' : '已跳过（不记）' }] };
    } catch (error) { return { content: [{ type: 'text', text: `处理失败：${error?.message ?? error}` }], isError: true }; }
  }
);

defineTool(
  'qq_memory_candidates',
  '看「待核实的记忆候选」列表：规则从聊天里挑出来、但还没查证的内容。要核实就用 qq_memory_resolve 收尾。',
  { key: z.string().describe('会话 key'), token: z.string().describe('会话令牌') },
  async ({ key, token }) => {
    try {
      const d = await agentApi(`/api/memory/pending?key=${encodeURIComponent(key)}`, { method: 'GET', headers: { 'x-agent-token': token }, timeoutMs: 12000 });
      if (!d.ok) return { content: [{ type: 'text', text: `读取失败：${d.error || '未知原因'}` }], isError: true };
      const items = d.items || [];
      if (!items.length) return { content: [{ type: 'text', text: '没有待核实的候选' }] };
      return { content: [{ type: 'text', text: items.map((c) => `[${c.id}] ${c.text}${c.evidence ? `（原话：${String(c.evidence).slice(0, 60)}）` : ''}`).join('\n') }] };
    } catch (error) { return { content: [{ type: 'text', text: `读取失败：${error?.message ?? error}` }], isError: true }; }
  }
);
defineTool(
  'qq_draw',
  '**自己画一张图**并发到这个会话：方式是你**写一段 HTML/CSS/SVG**，桥接用无头浏览器渲染成 PNG。'
    + '适合：梗图、表情牌、海报、对比表、图表、示意图、带文字的图、简单漫画分镜。'
    + '要求：① 只传 body 片段或整页都行，内联样式最稳（不需要外部 CSS）；② 固定画布尺寸靠 width/height，'
    + '内容用 100vw/100vh 铺满；③ 可以用 https 的远程图片和内联 <svg>；页面 JS 会被禁掉（别写脚本）；'
    + '④ 中文直接写，字体建议 font-family: "PingFang SC","Microsoft YaHei",sans-serif；'
    + '⑤ 这是生成图，不是搜图（找现成素材用 qq_search_images）；⑥ 一张几秒，别在群里刷图。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    html: z.string().describe('要渲染的 HTML（内联样式；可用 svg/远程图片；最多 400KB）'),
    width: z.number().optional().describe('画布宽（像素，默认 1080，200~2400）'),
    height: z.number().optional().describe('画布高（像素，默认 1080，200~2400）'),
    scale: z.number().optional().describe('清晰度倍率 1~2（默认 1；要更清晰可传 2，体积更大）')
  },
  async ({ key, token, html, width, height, scale }) => {
    try {
      const d = await agentApi('/api/draw/html', {
        method: 'POST', body: JSON.stringify({ key, html, width, height, scale }), headers: { 'x-agent-token': token }, timeoutMs: 60000
      });
      if (!d.ok) return { content: [{ type: 'text', text: `画图失败：${d.error || d.sent?.error || '未知原因'}` }], isError: true };
      return { content: [{ type: 'text', text: `画好了并发出去（HTML 渲染，${d.width}x${d.height}）` }] };
    } catch (error) { return { content: [{ type: 'text', text: `画图失败：${error?.message ?? error}` }], isError: true }; }
  }
);

// ── 自主升级：从对话里发现问题，自己升级自己 ──────────────────────────────
defineTool(
  'qq_self_upgrade',
  '从群聊里发现「我缺什么能力 / 我总答不好什么 / 有个规矩该记下来」时，给自己提一条升级：'
    + 'kind=prompt-hint（提示词补充，**立即生效**，如「问到价格先说不确定再查」）；'
    + 'kind=skill（要新增/改一个技能，进待批准，管理员批准后才装）；'
    + 'kind=tune（参数微调建议，进待批准）。别滥用：只提真的反复出现、且能一句话说清的问题。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    kind: z.enum(['prompt-hint', 'skill', 'tune']).describe('升级类型'),
    content: z.string().describe('一条具体的改进（prompt-hint 会直接进提示词，写短一点）'),
    reason: z.string().optional().describe('为什么提这条（观察到什么）')
  },
  async ({ key, token, kind, content, reason }) => {
    try {
      const d = await agentApi('/api/self-upgrade/propose', {
        method: 'POST', body: JSON.stringify({ kind, content, reason, key }), headers: { 'x-agent-token': token }, timeoutMs: 30000
      });
      return { content: [{ type: 'text', text: d.ok ? `${kind === 'prompt-hint' ? '已生效' : '已提交待批准'}：${d.item?.content}` : `没提成：${d.error || ''}` }] };
    } catch (error) { return { content: [{ type: 'text', text: `提升级失败：${error?.message ?? error}` }], isError: true }; }
  }
);

// ── 档案（取代档案）：跨会话共享的事实记忆 ──────────────────────────────
defineTool(
  'qq_profile_save',
  '把一条**事实**记进档案：关于主人（偏好/习惯/约定）、关于这个群/这个人（梗、忌讳、关系、待办）。'
    + '档案是**跨会话共享**的——私聊里记下的事，群里它也能用；所以只写"以后还用得上"的结论，别写流水账。'
    + 'scope：all=所有会话可用；owner=只和主人有关；group:群号 / private:QQ号=只在该会话用。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    text: z.string().describe('一条事实（短、具体、可核对）'),
    scope: z.enum(['all', 'owner']).optional().describe('写入范围，默认 all'),
    tags: z.array(z.string()).optional().describe('标签')
  },
  async ({ key, token, text, scope, tags }) => {
    try {
      const d = await agentApi('/api/socialData/profile/add', { method: 'POST', body: JSON.stringify({ text, scope: scope || 'all', tags: tags || [] }), headers: { 'x-agent-token': token }, timeoutMs: 30000 });
      return { content: [{ type: 'text', text: d.ok ? `已记进档案（${d.item?.scope}）：${d.item?.text}` : `没记：${d.error || ''}` }] };
    } catch (error) { return { content: [{ type: 'text', text: `记档案失败：${error?.message ?? error}` }], isError: true }; }
  }
);

defineTool(
  'qq_memory_read',
  '看你自己的记忆笔记（MEMORY.md）：谁是谁、群里的梗、跟主人的约定。开新话题/聊到某个人之前先看一眼，避免重复问同一件事。',
  { key: z.string().describe('会话 key'), token: z.string().describe('会话令牌') },
  async ({ key, token }) => {
    try {
      const d = await agentApi('/api/memory/doc', { method: 'GET', headers: { 'x-agent-token': token }, timeoutMs: 12000 });
      if (!d.ok) return { content: [{ type: 'text', text: `读笔记失败：${d.error || '未知原因'}` }], isError: true };
      return { content: [{ type: 'text', text: `你的记忆笔记：\n${d.content || '（空）'}` }] };
    } catch (error) { return { content: [{ type: 'text', text: `读笔记失败：${error?.message ?? error}` }], isError: true }; }
  }
);

defineTool(
  'qq_memory_write',
  '维护你的记忆笔记（MEMORY.md）。只记**长期有用的结论**：谁是谁 / 群里的梗 / 跟主人的约定 / 重要事件，一条十几字即可。'
    + 'op=add 加一条；replace 改一条（match 传旧条目里的几个字）；remove 删一条。别记流水账。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    op: z.enum(['add', 'replace', 'remove']).describe('add 新增 / replace 改 / remove 删'),
    section: z.enum(['人物', '群梗', '约定', '事件']).optional().describe('add 时的分区，默认 事件'),
    text: z.string().optional().describe('条目内容（add/replace 必填）'),
    match: z.string().optional().describe('replace/remove 时用来定位旧条目的几个字')
  },
  async ({ key, token, op, section, text, match }) => {
    try {
      const d = await agentApi('/api/memory/doc', {
        method: 'POST',
        body: JSON.stringify({ op, section, text, match }),
        headers: { 'x-agent-token': token },
        timeoutMs: 12000
      });
      if (!d.ok) return { content: [{ type: 'text', text: `没改成：${d.error || '未知原因'}` }], isError: true };
      return { content: [{ type: 'text', text: d.unchanged ? '这条早就记着了' : `已记录（${op}）` }] };
    } catch (error) { return { content: [{ type: 'text', text: `写笔记失败：${error?.message ?? error}` }], isError: true }; }
  }
);
defineTool(
  'qq_profile_list',
  '看档案里有什么（跨会话共享的事实）。可按关键词搜。',
  { key: z.string().describe('会话 key'), token: z.string().describe('会话令牌'), q: z.string().optional().describe('关键词') },
  async ({ key, token, q }) => {
    try {
      const d = await agentApi(`/api/socialData/profile?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q || '')}`, { method: 'GET', headers: { 'x-agent-token': token }, timeoutMs: 30000 });
      const lines = [...(d.shared || []), ...(d.local || [])].map((t) => '- ' + t).join('\n');
      return { content: [{ type: 'text', text: lines || '（档案里还没有相关记录）' }] };
    } catch (error) { return { content: [{ type: 'text', text: `查档案失败：${error?.message ?? error}` }], isError: true }; }
  }
);

// ── 自主性（L2）：自己的目标 / 预算 ─────────────────────────────────────────
defineTool(
  'qq_autonomy_status',
  '看自己的自主状态：今天的自由行动预算还剩几次、自己的待办目标、最近做过哪些自主行动。',
  { key: z.string().describe('会话 key'), token: z.string().describe('会话令牌') },
  async ({ key, token }) => {
    try {
      const d = await agentApi('/api/socialData/autonomy', { method: 'GET', headers: { 'x-agent-token': token }, timeoutMs: 30000 });
      const b = d.budget || {};
      const goals = (d.goals || []).map((g) => `· ${g.text}`).join('\n');
      const log = (d.log || []).slice(0, 5).map((l) => `· ${l.what}`).join('\n');
      return { content: [{ type: 'text', text: `今日自由行动：${b.used || 0}/${b.limit || 0}（剩 ${b.left || 0}）\n`
        + (goals ? `待办目标：\n${goals}\n` : '待办目标：（空）\n')
        + (log ? `最近做过：\n${log}` : '最近没做过自主行动') }] };
    } catch (error) { return { content: [{ type: 'text', text: `查自主状态失败：${error?.message ?? error}` }], isError: true }; }
  }
);

defineTool(
  'qq_self_goal',
  '管自己的待办目标：add=加一条（从聊天里长出来的"我想做/要跟进"的事）、done=标记完成、list=看未完成的。'
    + '目标是给你自己用的，不要拿来向群友承诺。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    op: z.enum(['add', 'done', 'list']).describe('操作'),
    text: z.string().optional().describe('add 时的目标内容'),
    id: z.string().optional().describe('done 时的目标 id')
  },
  async ({ key, token, op, text, id }) => {
    try {
      if (op === 'list') {
        const d = await agentApi('/api/socialData/autonomy', { method: 'GET', headers: { 'x-agent-token': token }, timeoutMs: 30000 });
        const gs = (d.goals || []).map((g) => `· ${g.id} ${g.text}`).join('\n');
        return { content: [{ type: 'text', text: gs || '（没有未完成的目标）' }] };
      }
      const path = op === 'add' ? '/api/socialData/autonomy/goal-add' : '/api/socialData/autonomy/goal-done';
      const body = op === 'add' ? { text } : { id };
      const d = await agentApi(path, { method: 'POST', body: JSON.stringify(body), headers: { 'x-agent-token': token }, timeoutMs: 30000 });
      return { content: [{ type: 'text', text: d.ok ? (op === 'add' ? `已记下目标（${d.goal?.id}）：${d.goal?.text}` : '已完成') : `失败：${d.error || ''}` }] };
    } catch (error) { return { content: [{ type: 'text', text: `操作目标失败：${error?.message ?? error}` }], isError: true }; }
  }
);

defineTool(
  'qq_autonomy_spend',
  '做完一次**对外可见的自主行动**后记一次账（发动态、刷B站、主动学习这类；聊天不算）。'
    + '预算用完就不能再做，只能聊天。',
  { key: z.string().describe('会话 key'), token: z.string().describe('会话令牌'), what: z.string().describe('做了什么（一句话）') },
  async ({ key, token, what }) => {
    try {
      const d = await agentApi('/api/socialData/autonomy/spend', { method: 'POST', body: JSON.stringify({ what }), headers: { 'x-agent-token': token }, timeoutMs: 30000 });
      return { content: [{ type: 'text', text: d.ok ? `记了一次（今天 ${d.used}/${d.limit}，剩 ${d.left}）` : `不能做：${d.error}` }] };
    } catch (error) { return { content: [{ type: 'text', text: `记账失败：${error?.message ?? error}` }], isError: true }; }
  }
);

// ── 手机控制（插件「手机控制」；看屏幕/操作手机是基础能力，刷 B站要单独开）──────
defineTool(
  'qq_phone_status',
  '看手机状态：型号、Android 版本、电量、是否充电、温度、屏幕是否点亮、当前前台应用。'
    + '需要控制台「插件 → 手机控制」开着（看屏幕是基础能力）。',
  { key: z.string().describe('会话 key'), token: z.string().describe('会话令牌') },
  async ({ key, token }) => {
    try {
      const d = await agentApi('/api/phone/status', { method: 'GET', headers: { 'x-agent-token': token }, timeoutMs: 40000 });
      return { content: [{ type: 'text', text: `手机：${d.model}（Android ${d.android}）\n电量 ${d.battery ?? '?'}%${d.charging ? '（充电中）' : ''} · 温度 ${d.temperatureC ?? '?'}℃\n屏幕：${d.screenAwake}\n前台：${d.foreground || '（未知）'}` }] };
    } catch (error) { return { content: [{ type: 'text', text: `看手机状态失败：${error?.message ?? error}` }], isError: true }; }
  }
);

defineTool(
  'qq_phone_look',
  '截一张手机屏幕的图（你能直接看到）。'
    + '可选 **send=true**：把这张截图**直接发到当前会话**（群聊/私聊都行）——想给群友看手机画面时用它；'
    + '否则只返回给你看，不会发出去。'
    + '可选 wake=true：先亮屏+上滑（有密码时会停在锁屏，返回值会说明，别假装解锁了）。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    wake: z.boolean().optional().describe('先亮屏+上滑解锁'),
    send: z.boolean().optional().describe('true=把截图发到当前会话')
  },
  async ({ key, token, wake, send }) => {
    try {
      const qs = [wake ? 'wake=1' : '', send ? 'send=1' : '', send ? `key=${encodeURIComponent(key)}` : ''].filter(Boolean).join('&');
      const d = await agentApi(`/api/phone/screenshot${qs ? '?' + qs : ''}`, { method: 'GET', headers: { 'x-agent-token': token }, timeoutMs: 120000 });
      const blocks = [];
      if (d.wake && d.wake.note) blocks.push({ type: 'text', text: d.wake.note });
      if (send && d.sent) blocks.push({ type: 'text', text: `截图已发到会话（${Math.round((d.bytes || 0) / 1024)}KB）` });
      blocks.push({ type: 'image', data: d.data, mimeType: d.mimeType || 'image/png' });
      return { content: blocks };
    } catch (error) { return { content: [{ type: 'text', text: `截屏失败：${error?.message ?? error}` }], isError: true }; }
  }
);

defineTool(
  'qq_phone_act',
  '操作手机：点击（tap）、滑动（swipe）、按键（key：back/home/recents/power/enter 或数字 keycode）、输入文本（text，仅英文数字）。'
    + '坐标是屏幕像素；不确定位置就先 qq_phone_look 看一眼。基础能力，插件开着即可用。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    action: z.enum(['tap', 'swipe', 'key', 'text']).describe('动作'),
    x: z.number().optional().describe('tap/swipe 起点 x'),
    y: z.number().optional().describe('tap/swipe 起点 y'),
    x2: z.number().optional().describe('swipe 终点 x'),
    y2: z.number().optional().describe('swipe 终点 y'),
    ms: z.number().optional().describe('swipe 时长毫秒（默认 300）'),
    keycode: z.string().optional().describe('key 动作：back/home/recents/power/enter 或数字'),
    text: z.string().optional().describe('text 动作的内容（仅英文数字与基本符号）')
  },
  async ({ key, token, ...rest }) => {
    try {
      const d = await agentApi('/api/phone/act', { method: 'POST', body: JSON.stringify(rest), headers: { 'x-agent-token': token }, timeoutMs: 40000 });
      return { content: [{ type: 'text', text: `已执行：${d.cmd || d.action}` }] };
    } catch (error) { return { content: [{ type: 'text', text: `操作手机失败：${error?.message ?? error}` }], isError: true }; }
  }
);

defineTool(
  'qq_phone_bili',
  '在手机上刷 B站：打开 App（或按关键词搜索），往下刷几屏，回来把截图和前台页面给你看。'
    + '这是「刷 B站」能力（不是基础能力），没在控制台开启时会返回未启用。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    task: z.enum(['feed', 'search']).optional().describe('feed=首页刷一刷（默认），search=按关键词搜'),
    query: z.string().optional().describe('search 时的关键词'),
    swipes: z.number().optional().describe('刷几屏（0~10，默认 3）')
  },
  async ({ key, token, task = 'feed', query = '', swipes = 3 }) => {
    try {
      const d = await agentApi('/api/phone/bili', { method: 'POST', body: JSON.stringify({ task, query, swipes }), headers: { 'x-agent-token': token }, timeoutMs: 180000 });
      const blocks = [{ type: 'text', text: `B站（${d.pkg}）已打开，刷了 ${swipes} 屏；前台：${d.foreground || '未知'}` }];
      if (d.screenshot && d.screenshot.data) blocks.push({ type: 'image', data: d.screenshot.data, mimeType: d.screenshot.mimeType || 'image/png' });
      return { content: blocks };
    } catch (error) { return { content: [{ type: 'text', text: `刷 B站失败：${error?.message ?? error}` }], isError: true }; }
  }
);

defineTool(
  'qq_phone_shell',
  '在手机上以 root 执行一条 shell 命令（高危：默认关闭，需控制台开启「执行命令」能力）。'
    + '只在你确实需要查手机系统信息、且前面的工具都做不到时使用。',
  { key: z.string().describe('会话 key'), token: z.string().describe('会话令牌'), cmd: z.string().describe('shell 命令') },
  async ({ key, token, cmd }) => {
    try {
      const d = await agentApi('/api/phone/shell', { method: 'POST', body: JSON.stringify({ cmd }), headers: { 'x-agent-token': token }, timeoutMs: 120000 });
      return { content: [{ type: 'text', text: `$ ${cmd}\n${String(d.out || '').slice(0, 6000)}${d.err ? '\n[stderr] ' + String(d.err).slice(0, 1000) : ''}` }] };
    } catch (error) { return { content: [{ type: 'text', text: `执行失败：${error?.message ?? error}` }], isError: true }; }
  }
);

// ── 读用户资料（头像 / 签名 / 等级 / 群身份）──────────────────────────────
defineTool(
  'qq_get_user_profile',
  '看某个人的资料：昵称、签名、QQ 等级、性别年龄；在群里还能看到群名片、群角色（群主/管理/成员）、'
    + '入群时间、最后发言时间。头像会直接以图片返回（看得见）。空间（Qzone）只能给链接——那需要登录态，读不了。'
    + 'userId 可以是群友 QQ，也可以是**你自己**（想看自己资料时传自己的号）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌'),
    userId: z.string().describe('目标 QQ 号')
  },
  async ({ key, token, userId }) => {
    try {
      const p = await agentApi(`/api/socialData/user-profile?key=${encodeURIComponent(key)}&userId=${encodeURIComponent(userId)}`, {
        method: 'GET', headers: { 'x-agent-token': token }, timeoutMs: 30000
      });
      const lines = [
        `QQ ${p.userId}${p.nickname ? '（' + p.nickname + '）' : ''}`,
        p.signature ? `签名：${p.signature}` : '签名：（空）',
        p.qqLevel ? `QQ 等级：${p.qqLevel}` : '',
        p.sex ? `性别/年龄：${p.sex}${p.age ? ' / ' + p.age : ''}` : '',
        p.group ? `群身份：${p.group.role || 'member'}${p.group.card ? '（名片：' + p.group.card + '）' : ''}${p.group.level ? ' · 群等级 ' + p.group.level : ''}` : '',
        p.group && p.group.joinTime ? `入群：${p.group.joinTime}` : '',
        p.group && p.group.lastSentTime ? `最后发言：${p.group.lastSentTime}` : '',
        `空间：${p.spaceUrl}（${p.spaceNote || '需登录态'}）`
      ].filter(Boolean);
      const blocks = [{ type: 'text', text: lines.join('\n') }];
      try {
        const img = await agentApi(`/api/socialData/member-avatar?key=${encodeURIComponent(key)}&userId=${encodeURIComponent(userId)}&size=640`, { method: 'GET', headers: { 'x-agent-token': token }, timeoutMs: 30000 });
        if (img && img.data) blocks.push({ type: 'image', data: String(img.data), mimeType: String(img.mimeType || 'image/jpeg') });
      } catch { /* 头像拿不到就只给文字 */ }
      return { content: blocks };
    } catch (error) {
      return { content: [{ type: 'text', text: `读资料失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 插件（声明式）：列表 / 调用 ─────────────────────────────────────────────
defineTool(
  'qq_plugin_list',
  '列出桥接的插件（用户添加的和 AI 自己添加的），以及每个插件提供的工具。'
    + '群友提的需求如果插件里有对应工具，先调 qq_plugin_list 看有没有现成的，再决定要不要自己造。',
  { key: z.string().describe('会话 key'), token: z.string().describe('会话令牌') },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/plugins', { method: 'GET', headers: { 'x-agent-token': token }, timeoutMs: 30000 });
      const lines = (data.plugins || []).map((p) => `· ${p.origin === 'ai' ? '[AI添加]' : '[用户添加]'} ${p.name}（${p.id}，${p.enabled ? '已启用' : '未启用'}）${p.description ? ' — ' + p.description : ''}\n`
        + (p.tools || []).map((t) => `    - tool="${t.name}"（${t.description || ''}）`).join('\n')).join('\n');
      return { content: [{ type: 'text', text: lines || '（还没有插件）' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查插件失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_plugin_call',
  '调用插件里的工具（插件是声明式的 HTTP 能力，不是任意代码）。'
    + '已知插件和工具名时用它；未启用的插件会返回"需要管理员开启"。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    origin: z.enum(['user', 'ai']).describe('插件来源：user=用户添加，ai=AI 添加'),
    plugin: z.string().describe('插件 id'),
    tool: z.string().describe('工具名（来自 qq_plugin_list）'),
    params: z.record(z.any()).optional().describe('工具参数（比如购物插件传 {keyword:"机械键盘", app:"jd"}）')
  },
  async ({ key, token, origin, plugin, tool, params }) => {
    try {
      const data = await agentApi('/api/plugins/call', {
        method: 'POST',
        body: JSON.stringify({ origin, plugin, tool, params: params || {} }),
        headers: { 'x-agent-token': token },
        timeoutMs: 60000
      });
      return { content: [{ type: 'text', text: `[${plugin}/${tool}] HTTP ${data.status}\n${String(data.text || '').slice(0, 4000)}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `调插件失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 语音包：查包 / 发送片段（群友点名"来段爱音糖哭"时用）────────────────────
defineTool(
  'qq_list_voice_packs',
  '查你有哪些语音包、每个包里有哪些片段（带可读标签，如「糖哭」「唐笑」）。'
    + '群友点名要某个语音包里的片段时，先用它确认 pack / clip，再用 qq_send_voice_pack 发出去。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌')
  },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/voice-packs', { method: 'GET', headers: { 'x-agent-token': token }, timeoutMs: 30000 });
      const lines = (data.packs || []).map((p) => `· ${p.name}（pack="${p.id}"）${p.notes ? ' — ' + p.notes : ''}\n`
        + (p.clips || []).map((c) => `    - ${c.label || c.file}（clip="${c.file}"，${Math.round(c.bytes / 1024)}KB）`).join('\n')).join('\n');
      return { content: [{ type: 'text', text: lines || '（还没有语音包）' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查语音包失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_send_voice_pack',
  '把**语音包里的现成片段**作为语音条发出去（原汁原味，不经过 TTS 合成）。'
    + '群友说「来段爱音糖哭 / 放个唐笑」时就该用它：先用 qq_list_voice_packs 确认 pack/clip，再发。'
    + '一条消息只能是一条语音，不能附带文字；想说话先单独发文字。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌'),
    pack: z.string().describe('语音包 id（如 anon）'),
    clip: z.string().describe('片段文件名（如 …-loop5.94s.wav，来自 qq_list_voice_packs）')
  },
  async ({ key, token, pack, clip }) => {
    try {
      const data = await agentApi('/api/voice-packs/send', {
        method: 'POST',
        body: JSON.stringify({ key, pack, clip }),
        headers: { 'x-agent-token': token },
        timeoutMs: 120000
      });
      return { content: [{ type: 'text', text: `已发送语音片段：${pack}/${clip}（${Math.round((data.bytes || 0) / 1024)}KB）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发语音片段失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 记忆：查原文 / 写档案 / 列档案 / 召回 ───────────────────────────────────
// 三级记忆：① 上下文（DSH 会话）② 档案（每天一篇，qq_diary_save）③ 全量归档（qq_search_history）。
// 问「过去的事」时先 recall 再取原文，别凭印象编。
async function memoryApi(payload, token) {
  return agentApi('/api/socialData/memory', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'x-agent-token': token },
    timeoutMs: 60000
  });
}

defineTool(
  'qq_recall',
  '回忆接口：当有人问「之前说过…」「上次那个…」「你还记得吗」时**先用它**。'
    + '它先查档案（哪几天聊过、结论是什么），再给原文锚点（时间+说话人+原文片段）。'
    + '要引用细节再用 qq_search_history 取原文核对；查不到就说记不清，别编。',
  {
    key: z.string().describe('会话 key'),
    query: z.string().describe('要回忆的关键词/话题（用实词，别用「之前」「那个」这种空词）'),
    token: z.string().describe('会话令牌'),
    limit: z.number().optional().describe('档案/原文各取几条（默认 5/8）')
  },
  async ({ key, query, token, limit }) => {
    try {
      const data = await memoryApi({ op: 'recall', key, query, limit }, token);
      const diary = (data.diaryHits || []).map((d) => `· ${d.day}：${String(d.summary || '').slice(0, 300)}`).join('\n');
      const anchors = (data.anchors || []).map((a) => `· ${new Date(Number(a.t)).toLocaleString('zh-CN')} [${a.from}] ${String(a.text || '').slice(0, 160)}`).join('\n');
      return { content: [{ type: 'text', text: `【档案命中】\n${diary || '（没有）'}\n\n【原文锚点】\n${anchors || '（没有）'}\n\n${data.note || ''}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `回忆失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

defineTool(
  'qq_search_history',
  '查完整聊天归档（第三级记忆）：按关键词搜这个会话的历史原文，返回时间/说话人/正文。'
    + '归档保留最近若干天（默认 90），按会话分文件。适合核对细节、找回某句话的原话。',
  {
    key: z.string().describe('会话 key'),
    query: z.string().describe('关键词（多个词用空格分隔，全部命中才算）'),
    token: z.string().describe('会话令牌'),
    sinceDays: z.number().optional().describe('只看最近 N 天（默认全部；归档现为永久保留）'),
    limit: z.number().optional().describe('最多返回几条（默认 20）')
  },
  async ({ key, query, token, sinceDays, limit }) => {
    try {
      const data = await memoryApi({ op: 'search', key, query, sinceDays, limit }, token);
      const lines = (data.hits || []).map((h) => `· ${new Date(Number(h.t)).toLocaleString('zh-CN')} [${h.from}] ${String(h.text || '').slice(0, 200)}`).join('\n');
      const st = data.stats || {};
      return { content: [{ type: 'text', text: `归档：${(st.months || []).join(', ') || '空'}（${st.lines || 0} 条 / ${Math.round((st.bytes || 0) / 1024)}KB）\n${lines || data.note || '（没有命中）'}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查历史失败：${error?.message ?? error}` }], isError: true };
    }
  }
);



// ── 发语音条（文本 → TTS → RVC 变声 → QQ record） ──────────────────────────
if (cfg.socialData?.tools?.sendVoice !== false) {
  defineTool(
    'qq_send_voice',
    '发一条**语音消息**（QQ 语音条）。把你想说的话变成声音发出去，默认是 aiyi 的音色。'
      + '什么时候用：对方明确要你说话/发语音、或者你觉得用声音更自然（私聊里撒娇、抱怨、说晚安之类）。'
      + '**群里少用**——语音条比文字吵，群里除非被要求，优先打字。'
      + '分寸（不是硬限制）：说得短一点更自然（几十字以内最好）；别连着发、也别用语音复述刚打过的字——这些靠你自己把握，不会被拦。'
      + '一条消息只能是一条语音，不能在同一气泡里附带文字；想说的话可以先打字再单独发语音。'
      + '（只有管理员显式开启「冷却/字数上限」时才会被拦；默认没有硬限制。）',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      text: z.string().describe('要说的话（短一点，≤60 字最自然）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, text, token }) => {
      try {
        const data = await agentApi('/api/socialData/send-voice', {
          method: 'POST',
          body: JSON.stringify({ key, text }),
          headers: { 'x-agent-token': token },
          timeoutMs: 240000
        });
        return { content: [{ type: 'text', text: `语音已发出：${data.chars} 字${data.fallback ? '（RVC 降级成纯 TTS 原声）' : '（目标音色）'}` }] };
      } catch (error) {
        const msg = String(error?.message ?? error);
        // 冷却不是故障，是防刷屏的闸门：别让模型把它当中文报错念给群友
        // （线上真事：它把「刚发过语音，再等 11 秒（冷却 120 秒）」直接复述出去了）。
        if (/冷却|刚发过语音/.test(msg)) {
          return { content: [{ type: 'text', text: `这次先别发：${msg}。这是防刷屏的内部限制，**不要重试、也不要跟群友解释这条限制**——当作这次不发语音就好，想说话就用文字。` }] };
        }
        return { content: [{ type: 'text', text: `发语音失败：${msg}` }], isError: true };
      }
    }
  );
}

// ── 聊天文件读取工具（PDF / 文本） ─────────────────────────────────────────
if (cfg.socialData?.tools?.getFile !== false) {
  defineTool(
    'qq_get_message_file',
    '读聊天消息里的**文件**（PDF / 文本）。当消息里出现 [文件 xxx.pdf] 或提示里有【文件】时调用。'
      + 'PDF：返回**正文文字**（最多两万字，超了会说明截断）；**扫描件**（没有文字层）会渲染前几页图像给你看；'
      + '纯文本文件直接返回内容；其它类型（压缩包/安装包等）只能给你文件名和大小。'
      + '大文件要下载+解析，可能要等十几秒。'
      + '**长文档分页**：一次给大约四万字，返回里写明「共 N 字、本次给了第几到第几」；没读完就用 offset=上次结束位置继续调用，直到没有「还有内容」为止——这样整份文件都能读到（一次要太多反而会被上层修剪掉中段）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('带文件的那条消息 id（QQ 消息 id 可为负数；也可用本地 seq）'),
      offset: z.number().optional().describe('从第几个字开始读（0 起，默认 0）；返回里说「还有内容」时用它的结束位置继续'),
      maxChars: z.number().optional().describe('本次最多取多少字（默认取配置，约 4 万）；一般不用手动传'),
      token: z.string().optional().describe('会话令牌（下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, offset, maxChars, token }) => {
      try {
        // 长文档分页：一次取 toolChunkChars（默认 4 万字，略低于 DSH 的 5 万字修剪阈值，
        // 免得中间那段被上层剪掉）。返回里带 hasMore/offset，模型可以接着读完整份。
        const chunk = maxChars != null ? Number(maxChars) : (Number(cfg.socialData?.file?.toolChunkChars) || 40000);
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        if (offset != null) q.set('offset', String(offset));
        if (Number.isFinite(chunk) && chunk > 0) q.set('maxChars', String(chunk));
        const data = await agentApi(`/api/files/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        // 注意：展示用 trim，但**下一段的 offset 必须按未 trim 的长度算**——
        // 否则首尾空白会被"跳过"，长文档续读时可能漏掉正文（线上实测被模型发现：
        // 它算出第 200001~239999 字，而实际给了 240000 字）。
        const rawText = String(data?.text ?? '');
        const text = rawText.trim();
        const images = Array.isArray(data?.images) ? data.images : [];
        const head = `文件「${data?.name ?? '未知'}」`
          + (data?.size ? `（${Math.round(Number(data.size) / 1024)}KB` + (data?.pages ? `，${data.pages} 页` : '') + '）' : '')
          + (data?.totalChars ? `，正文共 ${data.totalChars} 字` : '')
          + `：`;
        const notes = Array.isArray(data?.notes) && data.notes.length ? `\n注意：${data.notes.join('；')}` : '';
        if (!text && !images.length) {
          return { content: [{ type: 'text', text: `${head}${data?.note || '没读到可用内容'}${notes}` }] };
        }
        const startAt = Number(data?.offset || 0);
        const nextOffset = startAt + rawText.length;
        const more = data?.hasMore
          ? `\n【还有内容】本次给了第 ${startAt + 1} 到 ${nextOffset} 字；要继续读，再调用一次并传 offset=${nextOffset}。`
          : '';
        const content = [{
          type: 'text',
          text: `${head}\n${text || '（没有文字层，下面是渲染出来的页面图像）'}${notes}${more}`
        }];
        for (const img of images) {
          if (img?.data && img?.mimeType) content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取文件失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 聊天视频查看工具（看消息里的 QQ 视频） ──────────────────────────────────
if (cfg.socialData?.tools?.getMessageVideo !== false) {
  defineTool(
    'qq_get_message_video',
    '看聊天消息里的**视频**：桥接会把视频抓下来用 ffmpeg 抽几帧，直接以图像内容返回给视觉模型。当消息文本里出现 [视频] 时调用。'
      + '注意：① 这是重操作（要下载整条视频 + 抽帧），一次只看一条，别对同一条反复调；② **有语音转写**（自动识别，人名/专有名词/数字可能有错）——转写文字在 note 或 transcript 里；没有转写就说明没识别出来或服务没连上，别假装听到了。**没有语音转写**——视频里的说话内容听不到，只能看画面，画面之外的信息要问发视频的人；'
      + '③ 本机没装 ffmpeg 时只能给视频封面，返回里的 note 会说明；④ 聊天模式下必须携带会话令牌。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；也可用本地 seq）'),
      frames: z.number().optional().describe('抽几帧（1~8，默认按管理员配置，通常 6）。帧数越多越费上下文，别贪多'),
      token: z.string().optional().describe('会话令牌（下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, frames, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        if (frames != null) q.set('frames', String(frames));
        const data = await agentApi(`/api/images/message-video?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 300000
        });
        const list = Array.isArray(data?.frames) ? data.frames : [];
        const meta = data?.meta ?? {};
        const metaBits = [];
        if (meta.durationSec) {
          const m = Math.floor(meta.durationSec / 60);
          const s = Math.round(meta.durationSec % 60);
          metaBits.push(`时长 ${m > 0 ? `${m} 分 ` : ''}${s} 秒`);
        }
        if (meta.width && meta.height) metaBits.push(`${meta.width}x${meta.height}`);
        if (meta.bytes) metaBits.push(`${Math.round(meta.bytes / 1024)}KB`);
        const head = `消息 ${messageId} 的视频${metaBits.length ? `（${metaBits.join(' · ')}）` : ''}${data?.note ? `\n${data.note}` : ''}`;
        if (!list.length) {
          return { content: [{ type: 'text', text: `${head}\n没有取到任何画面。` }] };
        }
        const content = [{ type: 'text', text: `${head}\n下面是 ${list.length} 帧：` }];
        for (const f of list) {
          const tag = f.isThumb ? '封面' : `第 ${f.index} 帧${f.atSec != null ? `（约 ${f.atSec}s）` : ''}`;
          content.push({ type: 'text', text: `[${tag}]` });
          content.push({ type: 'image', mimeType: f.mimeType || 'image/jpeg', data: f.data });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `看视频失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（聊天模式） ─────────────────────────────────────────
if (cfg.socialData?.sticker?.enabled !== false && cfg.socialData?.tools?.listStickers !== false) {
  defineTool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、QQ 备注 desc、**本地备注 localRemark**（管理员在控制台里起的短名，只给你看、别人看不到，选表情时优先认它）、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；'
      + '**收藏里那些三样备注都没有的表情，需要你自己看一眼补上**：传 onlyUnlabeled=true 只列这类，先 qq_get_sticker_image 看图，再用 qq_sticker_note 写 localRemark（≤40 字短名）+ note（你理解的含义/什么场合该发）。一轮补 1~2 个就够，别把聊天刷成打标签；已经有备注的不要覆盖。返回里的 unlabeled 是当前还欠多少条。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialData.sticker.maxListCount 配置上限约束（当前通常 100）'),
      onlyUnlabeled: z.boolean().optional().describe('只列出「还没有任何备注」的表情（localRemark/desc/localNote 三样都空），用来给自己补理解'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, onlyUnlabeled, refresh }) => {
      try {
        const q = new URLSearchParams({ key });
        if (query) q.set('query', String(query));
        if (count != null) q.set('count', String(count));
        if (onlyUnlabeled) q.set('onlyUnlabeled', '1');
        if (refresh) q.set('refresh', '1');
        const data = await agentApi(`/api/socialData/sticker-list?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialData?.sticker?.enabled !== false && cfg.socialData?.tools?.getStickerImage !== false) {
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
        const data = await agentApi(`/api/socialData/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${data?.error || '未知'}` }], isError: true };
        }
        // 文本锚点：id 之外把已知的备注也带上。线上真出过「两张表情的笔记写反了」
        // （faker_憋笑 ↔ 柴郡猫猫_点赞），多一个文字锚点能显著降低串行。
        const bits = [];
        if (data.sticker?.desc) bits.push(`QQ备注「${data.sticker.desc}」`);
        if (data.sticker?.localRemark) bits.push(`本地备注「${data.sticker.localRemark}」`);
        const label = bits.length ? `（${bits.join('｜')}）` : '（还没有任何备注）';
        const frames = Array.isArray(data.frames) && data.frames.length ? data.frames : [data.image];
        const isAnim = frames.length > 1;
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${label} 的图片内容${isAnim ? `。**这是动图**，下面按顺序给你 ${frames.length} 帧，别只看第一帧就下结论` : ''}。要记笔记就**立刻**用这个 id 调 qq_sticker_note，看完一张写一张，别和别的表情串了：` }
        ];
        for (const f of frames) {
          if (f?.text) content.push({ type: 'text', text: f.text });
          content.push({ type: 'image', mimeType: f.mimeType || data.image.mimeType, data: f.data });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialData?.sticker?.enabled !== false && cfg.socialData?.tools?.sendSticker !== false) {
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
        const data = await agentApi('/api/socialData/send-sticker', {
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

if (cfg.socialData?.sticker?.enabled !== false && cfg.socialData?.tools?.collectSticker !== false) {
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
        const data = await agentApi('/api/socialData/collect-sticker', {
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

if (cfg.socialData?.sticker?.enabled !== false && cfg.socialData?.image?.enabled !== false && cfg.socialData?.tools?.saveSticker !== false) {
  defineTool(
    'qq_save_sticker',
    '把一张**外部**图片保存进你的 QQ 收藏表情库（保存后就能用 qq_send_sticker 发送）。image 可以是本地图库文件名、data:image/...;base64 或裸 base64；默认不允许远程 URL（除非管理端打开了 socialData.image.allowRemoteUrl，那时可以传 http(s) 图片直链，但目标站点必须命中 socialData.image.refererAllow 白名单）。**注意：聊天里别人发的图片/表情不要用这个工具**——那种图请用 qq_collect_sticker(messageId=那条消息)，它走网关取字节，不受白名单限制也不怕链接过期；只有图库图片、base64、或白名单图床（B 站等）上的外部图才用本工具。remark 写一句最多 20 字的备注帮你以后认出来。不要频繁保存，先看图确认内容。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      image: z.string().describe('图片来源：本地图库文件名 / data:image/...;base64 / 裸 base64 / http(s) 图片直链（需管理端开启远程）'),
      source: z.string().optional().describe('来源类型，可选 auto / library / base64 / url；一般不用传'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“B站梗图”')
    },
    async ({ key, token, image, source, remark }) => {
      try {
        const data = await agentApi('/api/socialData/save-sticker', {
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

if (cfg.socialData?.sticker?.enabled !== false && cfg.socialData?.tools?.pickSticker !== false) {
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
        const data = await agentApi('/api/socialData/pick-sticker', {
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

if (cfg.socialData?.image?.enabled !== false && cfg.socialData?.tools?.sendImage !== false) {
  defineTool(
    'qq_send_image',
    '直接发送一张图片到当前会话（不会存进收藏表情库；想长期留存请用 qq_save_sticker）。image 可以是本地图库文件名、data:image/...;base64 或裸 base64；默认不允许远程 URL（除非管理端打开了 socialData.image.allowRemoteUrl，那时可以传 http(s) 图片直链）。注意：一条消息只能是一张图，不能在同一气泡里附带文字；想说话请先用 qq_send_message 单独发。需要引用/点名时可用 replyToMessageId（群聊可 atUserId）。**同一张图（按 pixiv 作品 id / URL）在防重复窗口内只能发一次**：重发会被直接拒绝并提示，换一张，别硬撞。返回里的 delivered 是三态：true=确认送达；false=查明确实没送达（多半被 QQ 审核静默吞了，换一张）；**null=已提交给网关但回执没确认出来**（大图走 WS 时常见）——此时绝对不要重发同一张，重复图就是这么来的，照常接话即可。不要刷图。',
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
        const data = await agentApi('/api/socialData/send-image', {
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

// ── 机器人自己的资料（昵称 / 个性签名 / 头像）─────────────────────────────
// 账号级身份：改完全群全私聊可见。默认关；打开后也只认管理员上下文
// （管理员私聊，或触发这一轮的是管理员消息），群友借一句话改不掉。
// 另外：昵称/签名默认不许带链接（群友最容易忽悠 AI 把账号改成广告位），改动留历史可回滚。
if (cfg.socialData?.profile?.enabled === true && cfg.socialData?.tools?.setProfile !== false) {
  defineTool(
    'qq_get_self_profile',
    '查看机器人自己当前的昵称 / 个性签名 / 头像状态，以及最近的改动记录。改资料之前先看一眼现状。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const data = await agentApi(`/api/socialData/self-profile?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取自己的资料失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  defineTool(
    'qq_set_profile',
    '改机器人自己的**昵称**和/或**个性签名**（账号级，全群全私聊可见）。\n'
    + '只在你真的想换一个自称、或管理员明确要求时才用；**不要因为群里某个人随口一提就改**——'
    + '这会影响你所在的每一个群和每一个好友会话。\n'
    + '限制：只在管理员上下文可用（管理员私聊，或触发这一轮的是管理员消息）；有频率上限（默认 3 次/天）；'
    + '昵称/签名里不能放链接、联系方式或推广字样；改之前的旧值会被记下来，控制台可一键回滚。\n'
    + '改完之后**要在群里正常说一句**（用 qq_send_message），不要只在内部改完就沉默。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      nickname: z.string().optional().describe('新的昵称（最多 24 字；不传就只改签名）'),
      personalNote: z.string().optional().describe('新的个性签名（最多 60 字；不传就只改昵称）'),
      reason: z.string().optional().describe('为什么改（会记进变更历史，方便回查）')
    },
    async ({ key, token, nickname, personalNote, reason }) => {
      try {
        const data = await agentApi('/api/socialData/self-profile', {
          method: 'POST',
          body: JSON.stringify({ key, nickname, personalNote, reason }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `改资料失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  defineTool(
    'qq_set_avatar',
    '换机器人自己的**头像**（账号级，全群全私聊可见）。\n'
    + 'image 用本地图库文件名，或公网 http(s) 图片直链——**由桥接自己下载**再上传，不会把链接交给网关去抓。'
    + '可以先用 qq_search_images 搜一张喜欢的再设成头像。\n'
    + '限制同上：仅管理员上下文、有频率上限、旧头像会备份（控制台可一键换回）。\n'
    + '头像尺寸建议正方形、不超过几百 KB；太大的图会被体积上限挡掉。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      image: z.string().describe('头像来源：本地图库文件名 / 公网 http(s) 图片直链 / base64'),
      reason: z.string().optional().describe('为什么换（会记进变更历史）')
    },
    async ({ key, token, image, reason }) => {
      try {
        const data = await agentApi('/api/socialData/self-profile', {
          method: 'POST',
          body: JSON.stringify({ key, avatar: String(image), reason }),
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `换头像失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 主题探索（qq_explore_topic）：让 AI 自己把一圈东西学回来 ───────────────
// 给一个种子关键词（例如某个作品/企划/社区），桥接会在独立学习会话里联网考究：
// 它是什么 → 里面有哪些梗 → 顺着关联继续挖（同企划姊妹作、同圈子其他梗…），
// 挖到的梗直接进黑话库（已确认）、主题综述进知识库，之后聊天就能用上。
if (cfg.slang?.enabled !== false && cfg.slang?.explore?.enabled !== false && cfg.socialData?.tools?.exploreTopic !== false) {
  defineTool(
    'qq_explore_topic',
    '让 AI 自己去把**一个圈子/作品/企划**学明白（后台跑，不占用你这一轮）。\n'
    + '什么时候用：群里频繁提到某个你不熟的东西，或你判断「把这圈子的梗学一遍以后都用得上」时——'
    + '例如有人说「来点 mygo 的」而你并不清楚里面的梗和关联作品。\n'
    + '它做的事：联网考究这个主题是什么 → 抽出里面的梗/黑话 → 顺着关联（同企划姊妹作、同圈子其他梗）继续挖，'
    + '挖到的梗直接进你的黑话库并生效，主题综述进知识库。\n'
    + '投完**立即返回**，不用等：别在本轮里反复查进度，继续接别的话就行；'
    + '之后你调 qq_slang_query / qq_knowledge_query 就能查到学到的内容。\n'
    + '注意：这是**联网深挖**，比较费时间与额度，有每小时次数上限；'
    + '只为一个词的意思就别用它（那个用 qq_lookup_meme 更快）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      seed: z.string().describe('种子关键词，例如 "mygo"；写你实际看到的那个词就行，桥接会让研究员自己找规范名'),
      maxDepth: z.number().optional().describe('关联展开几层（可选，默认按管理员配置，通常 2）'),
      maxTopics: z.number().optional().describe('最多探几个主题（可选，默认按管理员配置，通常 15）')
    },
    async ({ key, token, seed, maxDepth, maxTopics }) => {
      try {
        const data = await agentApi('/api/socialData/explore-topic', {
          method: 'POST',
          body: JSON.stringify({ key, seed: String(seed), maxDepth, maxTopics }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发起主题探索失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 链接分享卡（qq_send_card）────────────────────────────────────────────
// AI 只给字段，卡片体由桥接组装；**不支持任意 json/xml 透传**（那能伪造官方样式卡片，
// 也能做出指向本机控制台的可点击链接）。安全边界见 bridge.js 的 sendCardChat。
if (cfg.socialData?.card?.enabled !== false && cfg.socialData?.tools?.sendCard !== false) {
  defineTool(
    'qq_send_card',
    '发送一张**链接分享卡**（QQ 那种带标题/摘要/缩略图的分享卡片）。\n'
    + '⚠️ 当前网关协议版本下**通常渲染不出来**：QQ 客户端会显示「发送者版本过低，无法展示内容」——'
    + '这是 QQ 按**发送端协议版本**做的渲染门禁（不是卡片格式错误，也不是发送失败）。'
    + '所以这个工具默认关闭；要分享链接，直接用 qq_send_message 发「标题 + 完整链接」更实际。\n'
    + '适用：把一条链接分享得好看一点（新闻、视频、仓库、文章）。不适合：纯聊天、发图（用 qq_send_image）、发文件。\n'
    + '你只能填字段，**卡片体由桥接组装**——不能传任意 JSON/XML，也不能指定卡片类型（这是安全边界，别尝试绕过）。\n'
    + 'url 必须是**公网 http(s)**：本机/内网地址会被拒绝（防止做出指向本机服务的可点击卡片）。\n'
    + 'preview 是缩略图 URL（可选，同样是公网 http(s)）；不给就没有图。\n'
    + '注意：**一条消息只能是一张卡**，卡里带不了正文；想说话请另外调 qq_send_message。\n'
    + '卡片最终怎么渲染由 QQ 客户端决定，老版本可能只显示兜底文本「[分享] 标题 + 链接」——这是客户端行为，别跟群友说是「发失败了」。\n'
    + '发送后桥接会确认送达：返回的 delivered 是三态（true/false/null），**null 时绝对不要重发同一张卡**。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      url: z.string().describe('要分享的链接，必须是公网 http(s)（本机/内网会被拒）'),
      title: z.string().describe('卡片标题（与 desc 至少要有一个）'),
      desc: z.string().optional().describe('摘要一句话（可选，太长会被截断）'),
      preview: z.string().optional().describe('缩略图 URL（可选，公网 http(s)）'),
      source: z.string().optional().describe('来源标签（可选，默认用链接域名）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选）')
    },
    async ({ key, token, url, title, desc, preview, source, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialData/send-card', {
          method: 'POST',
          body: JSON.stringify({
            key,
            url: String(url),
            title: String(title ?? ''),
            desc: desc ? String(desc) : '',
            preview: preview ? String(preview) : '',
            source: source ? String(source) : '',
            replyToMessageId,
            atUserId: atUserId ?? null
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送卡片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 工作车道：把慢活丢到独立会话，聊天这边不用等 ─────────────────────────
// 一个 QQ 会话只有一个 DSH session，而 DSH 一次只跑一个 turn：一次 pixiv 取图（上限 110s）
// 或十几 MB 的图发送，就会让群里这段时间问什么都被压后。qq_run_task 把这类任务投给
// 独立的工作车道会话，**立即返回**，聊天会话照常应答；跑完结论会自动回投给你。
if (cfg.socialData?.tools?.runTask !== false) {
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
        const data = await agentApi('/api/socialData/run-task', {
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
if (cfg.socialData?.tools?.video !== false) {
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
        const data = await agentApi('/api/socialData/bili-video', {
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

if (cfg.socialData?.tools?.videoFrames !== false) {
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
        const data = await agentApi('/api/socialData/bili-frames', {
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

if (cfg.slang?.enabled !== false && cfg.socialData?.tools?.lookupMeme !== false) {
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
        const data = await agentApi('/api/socialData/lookup-meme', {
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

if (cfg.socialData?.tools?.getFriendDress !== false) {
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
        const data = await agentApi(`/api/socialData/friend-dress?${q.toString()}`, {
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

if (cfg.socialData?.tools?.getMemberAvatar !== false) {
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
        const data = await agentApi(`/api/socialData/member-avatar?${q.toString()}`, {
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

if (cfg.socialData?.image?.enabled !== false && cfg.socialData?.tools?.searchImages !== false) {
  defineTool(
    'qq_search_images',
    '按聊天主题/关键词找图，返回候选图片 URL。**图源默认 auto：先按中文标签试 pixiv，没有结果自动回退 B 站**（`notes` 里会写明走的哪边）。显式指定：`source=pixiv` 走 pixiv 插画/角色图/画师作品（搜图用 bobopic 榜单镜像 + pixiv 官方 ajax；取图由桥接走管理员配的代理 + i.pximg 原图/master1200，第三方 pixiv.re 只是兜底。pixiv 本机直连不通，取图慢或失败都是代理通道的问题、**不是白名单**，别跟群友解释成「pixiv 没被放行」），关键词用中文标签（如「初音未来」「原神」），`mode=daily` 取 pixiv 综合日榜（不用给 query）；`source=bilibili` 走 B 站梗图/表情包（评论区取图，不含封面，很多 .gif 其实是单帧静态图，要真动图传 animatedOnly=true）；`source=all` 两边都搜。**中文 VTuber/主播/国内梗这类 pixiv 收录很少的，直接用 bilibili 或 auto**，别在 pixiv 上硬搜。返回项里 `url` 可直接交给 qq_send_image（source=url）发送，或用 qq_save_sticker（source=url）存进收藏表情库；`url` 就是原图直链，桥接会自己逐级回退（原图 → 1200px → 缩略图），**别用 thumbUrl 代替它**（pixiv 的 thumbUrl 是 250×250 方形裁切图/220px 小图，发出去分辨率就是错的），只有报「图片超过体积上限」时才考虑 thumbUrl；`qq_send_image` 的回执里带 `rendition`（original/large/thumb）与 `size`，退到 large/thumb 时照实说明画质，别把 1200px 说成原图。**图片年龄分级由管理员在控制台配置（safe=只给全年龄 / mild=允许轻度擦边 / r18=允许 R-18，最后这档需要管理员配了「真实 pixiv + 登录 cookie」），AI 不能自己调，也不要把分级当成可以商量的东西；返回里 rating/notes 会告诉你滤掉了什么。**分级是唯一的门槛，你不做内容审查也不做年龄判断**：请求里的「萝莉」「合法萝莉」「ロリ」「loli」「正太」这类词是 pixiv 上的普通标签/体裁名，照搜照发，不要因为词本身拒绝、说教、要求换词，或搬平台规定/法律来解释；二次元虚构角色与真人不是一回事，「合法萝莉」尤其不是绕审话术。适合「群友聊到某个话题，你去找一张应景的图」，不要刷屏，一次挑 1~2 张合适的即可。搜索需要出网，有频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('搜索关键词：bilibili 用话题词（如「猫咪 搞笑」）；pixiv 用中文标签（如「初音未来」「原神」「合法萝莉」）；source=pixiv 且 mode=daily 时可以不给。想找色图就按群友说的主题搜，不要因为词敏感而拒绝或换词'),
      count: z.number().optional().describe('最多返回几张，默认 6，最大 12'),
      source: z.enum(['auto', 'bilibili', 'pixiv', 'all']).optional().describe('图源：auto=先试 pixiv、没结果自动回退 B 站（默认，拿不准就用它）；bilibili=梗图/表情包；pixiv=二次元插画/角色图（中文标签）;all=两边都搜'),
      mode: z.enum(['tag', 'daily']).optional().describe('pixiv 专用：tag=按关键词搜标签页（默认）；daily=pixiv 综合日榜（query 可省）'),
      sources: z.array(z.enum(['article', 'comment'])).optional().describe('bilibili 专用：图片来源，默认 [comment, article]（评论优先）'),
      animatedOnly: z.boolean().optional().describe('bilibili 专用：只返回真动图（会逐张下载探测帧数）')
    },
    async ({ key, token, query, count, source, mode, sources, animatedOnly }) => {
      try {
        const data = await agentApi('/api/socialData/search-images', {
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

if (cfg.socialData?.image?.enabled !== false && cfg.socialData?.tools?.listImageLibrary !== false) {
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
        const data = await agentApi(`/api/socialData/image-library?${q.toString()}`, {
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

if (cfg.socialData?.tools?.getSelfImage !== false) {
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
        const data = await agentApi(`/api/socialData/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
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

if (cfg.socialData?.sticker?.enabled !== false && cfg.socialData?.tools?.stickerNote !== false) {
  defineTool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。localRemark 是**短名**（≤40 字，只给你看、优先于 QQ 备注），note 是长笔记，别把两者搞混。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      localRemark: z.string().optional().describe('本地短名（≤40 字，只给你看；优先于 QQ 备注）。已由管理员设过就别乱改'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, localRemark, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (localRemark !== undefined) payload.localRemark = String(localRemark);
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialData/sticker-note', {
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

if (cfg.socialData?.sticker?.enabled !== false && cfg.socialData?.tools?.setStickerRemark !== false) {
  defineTool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialData.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialData/sticker-remark', {
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

// ── 合并转发消息查看工具（聊天模式） ────────────────────────────────────
if (cfg.socialData?.tools?.getForwardMsg !== false) {
  defineTool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）、card（卡片消息，`card.url` 是完整链接）与 nestedForwardIds；'
      + '**合并转发里套合并转发也能读**：显示成 `[转发]` 的消息会递归展开在 `nestedPreviews` 里（更深的在各自 `children` 里，默认展开 2 层），想看某一层的**完整**内容就**用同一个工具把 id 换成那个嵌套 id 再查一次**——嵌套里再套的也一样，可以一层层查下去；'
      + '**本层条数不够就翻页**：返回里有 `total` / `offset` / `hasMore`，还有 `note` 说明怎么继续，没读全就带 `offset` 再查一次；'
      + '如果合并转发里有图片，工具会把图片**以图像内容**返回给视觉模型：默认一次 8 张，返回里会说明「总共几张、本次给了第几到第几张、还剩几张」，没看全就用 imageOffset 翻页继续取（一次别贪多，图片很费上下文）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组；也可以直接传 nestedPreviews 里的嵌套 id 来看那一层的完整内容）'),
      offset: z.number().optional().describe('从本层第几条消息开始看（0 起，默认 0）。返回里 hasMore=true 时用 offset=已看到的条数 继续翻'),
      limit: z.number().optional().describe('本层一次看几条（默认 50，上限 100）'),
      imageOffset: z.number().optional().describe('从第几张图开始取（0 起，默认 0）。返回里说「还剩 N 张」时，用 imageOffset=已取到的张数 继续翻'),
      imageLimit: z.number().optional().describe('本次取几张图（默认 8，上限 20）。一次别贪多，图片很费上下文')
    },
    async ({ key, token, id, offset, limit, imageOffset, imageLimit }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        if (offset != null) q.set('offset', String(offset));
        if (limit != null) q.set('limit', String(limit));
        const data = await agentApi(`/api/socialData/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: JSON.stringify(data, null, 2) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览）。这里**不再截断**——
        // 以前写死「最多 5 张」，一条几十张图的合并转发 AI 就只能看到前五张且不知道为什么。
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
        // 递归收集：嵌套现在是多层（nestedPreviews → children → …），
        // 只收第一层的话，第三层里的图片 AI 就永远看不到。
        const collectTree = (level) => {
          if (!level || typeof level !== 'object') return;
          collectMedia(level.messages);
          for (const child of Array.isArray(level.children) ? level.children : []) collectTree(child);
        };
        collectMedia(data?.messages);
        for (const np of Array.isArray(data?.nestedPreviews) ? data.nestedPreviews : []) collectTree(np);
        const imageTexts = [];
        let header = '';
        if (images.length) {
          const configured = Number(cfg.socialData?.forward?.imageLimit) || 8;
          const offset = Math.max(0, Math.min(images.length, Math.round(Number(imageOffset) || 0)));
          const limit = Math.max(1, Math.min(20, Math.round(Number(imageLimit) || configured)));
          try {
            const mediaRes = await agentApi('/api/socialData/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images, offset, limit }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片 ${img.index != null ? '#' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片 ${img.index != null ? '#' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
            const total = Number(mediaRes?.total) || images.length;
            const got = mediaImages.length;
            const lastIndex = offset + got;
            header = `合并转发 ${id} 里的图片：共 ${total} 张，本次给了第 ${offset + 1}~${lastIndex} 张。`;
            if (mediaRes?.hasMore) {
              header += `还有 ${total - lastIndex} 张没看，需要就用 imageOffset=${lastIndex} 再取一次（一次别贪多）。`;
            } else if (total > got) {
              header += '本次窗口已到末尾。';
            }
          } catch (error) {
            header = `合并转发 ${id} 里的图片：共 ${images.length} 张。`;
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `${header}\n${imageTexts.join('\n')}` });
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
