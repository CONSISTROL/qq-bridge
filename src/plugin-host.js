// 桥接插件宿主：把「插件」做成**声明式的**（manifest.json 描述能力，不执行任意代码）。
//
// 为什么不用「AI 写一段 JS 跑在桥接进程里」：那等于给它任意代码执行权，能读 token、能发任意消息。
// 声明式插件只能声明三类能力，每一类都由桥实现并受限：
//   · tool  : 一个 HTTP 请求（GET/POST，可选 JSON body 模板）→ 结果作为工具返回给 AI
//   · job   : 定时任务（每 N 分钟请求一次 URL，命中 match 正则就通知某个会话）
// 这样 AI「给自己造功能」时写的是 JSON + 一个 URL，而不是能碰桥接内部的可执行代码。
import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST = 'manifest.json';
const ORIGINS = new Set(['user', 'ai']);

export function pluginRoot({ root, aiRoot = '' } = {}) {
  return {
    user: path.join(root, 'plugins'),
    ai: aiRoot || path.join(root, 'state', 'ai-plugins')
  };
}

export function readManifest(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!m || typeof m !== 'object' || !m.id) return null;
    const origin = ORIGINS.has(m.origin) ? m.origin : 'user';
    return {
      id: String(m.id),
      name: String(m.name || m.id),
      description: String(m.description || ''),
      origin,
      version: String(m.version || '0'),
      enabled: m.enabled !== false,
      tools: Array.isArray(m.tools) ? m.tools.filter((t) => t && t.name && (t.url || t.kind === 'phone')).map((t) => ({
        name: String(t.name),
        description: String(t.description || ''),
        // kind=phone：不跑 HTTP，而是调用桥接的手机动作（白名单 action），用于 App 类能力
        kind: t.kind === 'phone' ? 'phone' : 'http',
        action: t.kind === 'phone' ? String(t.action || '') : '',
        // 手机动作的附加参数（例如 shopping 的 app=jd/douyin）要保留，否则全落到默认值
        app: t.kind === 'phone' ? String(t.app || '') : '',
        method: String(t.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
        url: String(t.url || ''),
        body: t.body && typeof t.body === 'object' ? t.body : null,
        timeoutMs: Math.max(1000, Math.min(60000, Number(t.timeoutMs) || 15000)),
        maxChars: Math.max(200, Math.min(20000, Number(t.maxChars) || 4000))
      })) : [],
      jobs: Array.isArray(m.jobs) ? m.jobs.filter((j) => j && j.url).map((j) => ({
        name: String(j.name || 'job'),
        everyMin: Math.max(5, Math.min(1440, Number(j.everyMin) || 30)),
        url: String(j.url),
        match: String(j.match || ''),
        notifyKey: String(j.notifyKey || ''),
        prompt: String(j.prompt || '')
      })) : []
    };
  } catch {
    return null;
  }
}

/** 扫描 user（仓库 plugins/）与 ai（state/ai-plugins/）两个根，合并成一份清单。 */
export function scanPlugins({ root, aiRoot = '', enabledState = {} } = {}) {
  const roots = pluginRoot({ root, aiRoot });
  const out = [];
  for (const [origin, dir] of Object.entries(roots)) {
    let ids = [];
    try { ids = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
    for (const id of ids) {
      const file = path.join(dir, id, MANIFEST);
      const m = readManifest(file);
      if (!m) continue;
      // 来源以**所在目录**为准（防止 AI 在 manifest 里把自己写成 user）
      m.origin = origin;
      const key = `${origin}:${m.id}`;
      m.path = path.join(dir, id);
      m.enabled = Object.prototype.hasOwnProperty.call(enabledState, key) ? !!enabledState[key] : m.enabled;
      out.push(m);
    }
  }
  out.sort((a, b) => (a.origin === b.origin ? a.id.localeCompare(b.id) : a.origin === 'user' ? -1 : 1));
  return out;
}

/** 工具名：plugin__<origin>__<pluginId>__<toolName>（避免与 qq_* 撞名）。 */
export function pluginToolName(plugin, tool) {
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40);
  return `plugin__${safe(plugin.origin)}__${safe(plugin.id)}__${safe(tool.name)}`;
}
