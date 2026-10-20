// 统一记忆库（一个 SQLite 数据库管所有"AI 记住的东西"）。
//
// 为什么合：黑话、群知识库、档案、轻量记忆（话题/想法/印象）、群成员备注、表情笔记原本各存各的
// JSON，查一次要读好几个文件、也做不了统一搜索。现在全部进 state/memory.db 的 items 表，
// 用 kind 区分类型，控制台只用一个页面查/改。
//
// 结构：items(id, kind, scope, text, answer, tags, status, at, updated, extra)
//   kind: slang(黑话) | knowledge(知识库) | fact(档案) | topic(话题) | thought(想法)
//         | impression(印象) | remark(成员备注) | sticker(表情笔记)
//   scope: all | owner | group:<id> | private:<qq> | ''（不限）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'memory.db';
let db = null;

export function openMemoryDb({ stateDir }) {
  if (db) return db;
  fs.mkdirSync(stateDir, { recursive: true });
  db = new DatabaseSync(path.join(stateDir, FILE));
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      scope TEXT DEFAULT '',
      text TEXT NOT NULL,
      answer TEXT DEFAULT '',
      tags TEXT DEFAULT '',
      status TEXT DEFAULT '',
      at INTEGER DEFAULT 0,
      updated INTEGER DEFAULT 0,
      extra TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_items_kind ON items(kind);
    CREATE INDEX IF NOT EXISTS idx_items_scope ON items(scope);
  `);
  return db;
}

const row2item = (r) => ({
  id: r.id, kind: r.kind, scope: r.scope, text: r.text, answer: r.answer,
  tags: r.tags ? String(r.tags).split(',').filter(Boolean) : [],
  status: r.status, at: r.at, updated: r.updated,
  extra: r.extra ? (() => { try { return JSON.parse(r.extra); } catch { return {}; } })() : {}
});

export function listItems({ stateDir, kind = '', scope = '', q = '', limit = 200, offset = 0 } = {}) {
  const d = openMemoryDb({ stateDir });
  const where = [];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (scope) { where.push('(scope = ? OR scope = \'\')'); args.push(scope); }
  if (q) { where.push('(text LIKE ? OR answer LIKE ? OR tags LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const sql = `SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(updated, at) DESC LIMIT ? OFFSET ?`;
  args.push(Math.max(1, Math.min(2000, Number(limit) || 200)), Math.max(0, Number(offset) || 0));
  return d.prepare(sql).all(...args).map(row2item);
}

export function countItems({ stateDir, kind = '' } = {}) {
  const d = openMemoryDb({ stateDir });
  const rows = kind
    ? d.prepare('SELECT kind, COUNT(*) c FROM items WHERE kind = ? GROUP BY kind').all(kind)
    : d.prepare('SELECT kind, COUNT(*) c FROM items GROUP BY kind').all();
  const out = {};
  for (const r of rows) out[r.kind] = r.c;
  return out;
}

export function upsertItem({ stateDir, item = {}, now = Date.now() } = {}) {
  const d = openMemoryDb({ stateDir });
  const kind = String(item.kind || '').trim();
  const text = String(item.text || '').trim();
  if (!kind || !text) return { ok: false, error: 'kind / text 不能为空' };
  const id = String(item.id || `i${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`);
  const tags = Array.isArray(item.tags) ? item.tags.join(',') : String(item.tags || '');
  d.prepare(`INSERT INTO items (id, kind, scope, text, answer, tags, status, at, updated, extra)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, scope=excluded.scope, text=excluded.text,
               answer=excluded.answer, tags=excluded.tags, status=excluded.status, updated=excluded.updated, extra=excluded.extra`)
    .run(id, kind, String(item.scope || ''), text, String(item.answer || ''), tags, String(item.status || ''), Number(item.at) || now, now, JSON.stringify(item.extra || {}));
  return { ok: true, id };
}

export function deleteItem({ stateDir, id }) {
  const d = openMemoryDb({ stateDir });
  const r = d.prepare('DELETE FROM items WHERE id = ?').run(String(id));
  return { ok: r.changes > 0 };
}

/** 从旧的 JSON 文件一次性导入（可重复执行，按 id 幂等）。 */
export function migrateFromJson({ stateDir, log = () => {} } = {}) {
  const d = openMemoryDb({ stateDir });
  const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8')); } catch { return fb; } };
  let n = 0;
  const put = (item) => { const r = upsertItem({ stateDir, item }); if (r.ok) n += 1; };

  for (const s of readJson('slang.json', [])) put({ id: `slang:${s.id}`, kind: 'slang', text: s.content || '', answer: s.meaning || '', status: s.status || '', tags: s.tags, at: s.at || s.createdAt });
  for (const k of readJson('knowledge.json', [])) put({ id: `kb:${k.id}`, kind: 'knowledge', text: k.question || '', answer: k.answer || '', status: k.status || '', tags: k.tags, at: k.at || k.createdAt });
  for (const p of (readJson('profile.json', { items: [] }).items || [])) put({ id: `fact:${p.id}`, kind: 'fact', scope: p.scope || 'all', text: p.text || '', tags: p.tags, at: p.at });
  const remarks = readJson('member-remarks.json', { conversations: {} });
  for (const [conv, members] of Object.entries(remarks.conversations || {})) {
    for (const [qq, m] of Object.entries(members || {})) {
      put({ id: `remark:${conv}:${qq}`, kind: 'remark', scope: conv, text: `${m.remark || ''}|${m.note || ''}`.replace(/^\|/, '') || qq, extra: { qq, nick: m.nick || '' } });
    }
  }
  const s2 = readJson('social-v2.json', { conversations: {} });
  for (const [conv, st] of Object.entries(s2.conversations || {})) {
    for (const t of (st.topics || [])) put({ id: `topic:${conv}:${t.id || t.at}`, kind: 'topic', scope: conv, text: t.text || '', at: t.at, extra: { participants: t.participants || [] } });
    for (const t of (st.thoughts || [])) put({ id: `thought:${conv}:${t.id || t.at}`, kind: 'thought', scope: conv, text: t.text || '', at: t.at });
    for (const [name, im] of Object.entries(st.impressions || {})) put({ id: `impression:${conv}:${name}`, kind: 'impression', scope: conv, text: `${name}：${(im.traits || []).join('、')}`, extra: { name, interactionCount: im.interactionCount || 0 } });
  }
  log(`[memdb] 迁移完成：共 ${n} 条（${Object.entries(countItems({ stateDir })).map(([k, v]) => k + '=' + v).join(' ') }）`);
  return { ok: true, count: n, byKind: countItems({ stateDir }) };
}
