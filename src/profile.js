// 档案（取代原来的"日记"）：跨会话共享的事实型记忆。
//
// 为什么不用日记：日记是"按天写一篇叙事"，私聊和群各写各的，同一个人的信息永远对不上。
// 档案是"关于某人/某群的一条条事实"（偏好、约定、梗、忌讳、待办），scope 标清来源，
// 读取时把"全局 + 当前会话"两层拼起来注入，所以私聊里学到的事在群里也能用。
//
// 结构：state/profile.json = { items: [{ id, scope, text, tags, at, from }] }
//   scope: 'all'（任何会话都能看到）| 'owner'（只对主人相关）| 'group:<id>' | 'private:<qq>'
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'profile.json';
const read = (stateDir) => { try { const j = JSON.parse(fs.readFileSync(path.join(stateDir, FILE), 'utf8')); return Array.isArray(j?.items) ? j : { items: [] }; } catch { return { items: [] }; } };
const write = (stateDir, data) => { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, FILE), JSON.stringify(data, null, 2) + '\n'); };

export function listProfile({ stateDir, scope = '', q = '', limit = 60 } = {}) {
  const { items } = read(stateDir);
  const needle = String(q || '').toLowerCase();
  return items
    .filter((it) => (!scope || it.scope === scope || it.scope === 'all'))
    .filter((it) => !needle || `${it.text} ${(it.tags || []).join(' ')}`.toLowerCase().includes(needle))
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, Math.max(1, Math.min(300, limit)));
}

export function addProfile({ stateDir, text, scope = 'all', tags = [], from = 'ai', now = Date.now() } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, error: '内容不能为空' };
  const data = read(stateDir);
  // 近似去重：同 scope 下文本高度重合就不重复记
  const norm = (s) => s.replace(/\s+/g, '');
  if (data.items.some((it) => it.scope === scope && norm(it.text).includes(norm(body).slice(0, 20)))) {
    return { ok: false, error: '这条档案已经有了' };
  }
  const item = {
    id: `p${now.toString(36)}`,
    scope: String(scope).slice(0, 40),
    text: body.slice(0, 500),
    tags: Array.isArray(tags) ? tags.map(String).slice(0, 8) : [],
    at: now,
    from: String(from).slice(0, 20)
  };
  data.items.push(item);
  if (data.items.length > 800) data.items.splice(0, data.items.length - 800);
  write(stateDir, data);
  return { ok: true, item };
}

export function removeProfile({ stateDir, id }) {
  const data = read(stateDir);
  const before = data.items.length;
  data.items = data.items.filter((it) => it.id !== String(id));
  if (data.items.length === before) return { ok: false, error: '没有这条档案' };
  write(stateDir, data);
  return { ok: true };
}

/** 给提示词用：全局 + 当前会话，各取最近若干条。 */
export function profileForPrompt({ stateDir, key = '', limit = 12 }) {
  const data = read(stateDir);
  const pick = (scopes) => data.items.filter((it) => scopes.includes(it.scope)).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit).map((x) => x.text);
  // 全局 + 主人档案永远注入；当前会话的档案额外一份
  const shared = pick(['all', 'owner']);
  const local = key ? data.items.filter((it) => it.scope === key).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, limit).map((x) => x.text) : [];
  return { shared, local };
}
