// Web 应用（给管理员请求做的小页面）：AI 写一个静态页，桥接对外提供 /apps/<slug>。
//
// 用途：群里/管理员提出"帮我做个 XX 查询页/看板/表单"，AI 直接生成一个静态页，
// 给出公网链接（经反代 https://anihub.xin/qq/apps/<slug>），谁都能点开看。
// 安全：只放静态 HTML/CSS（<script> 允许但**不能**跨域请求桥接内部接口；页面在浏览器里跑，
// 与服务端隔离）；大小限制 200KB；slug 白名单；写入 state/webapps/<slug>/index.html。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'webapps';
const MAX_BYTES = 200 * 1024;

export const safeSlug = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function listApps({ stateDir }) {
  const dir = path.join(stateDir, ROOT);
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  return names.map((slug) => {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, slug, 'meta.json'), 'utf8')); } catch { /* ignore */ }
    let bytes = 0;
    try { bytes = fs.statSync(path.join(dir, slug, 'index.html')).size; } catch { /* ignore */ }
    return { slug, title: meta.title || slug, description: meta.description || '', createdAt: meta.createdAt || 0, bytes };
  }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function saveApp({ stateDir, slug, title = '', description = '', html = '', now = Date.now() }) {
  const id = safeSlug(slug);
  if (!id) return { ok: false, error: 'slug 只能用小写字母/数字/短横线' };
  const body = String(html ?? '');
  if (!body.trim()) return { ok: false, error: 'html 不能为空' };
  if (Buffer.byteLength(body) > MAX_BYTES) return { ok: false, error: `页面太大（>${Math.round(MAX_BYTES / 1024)}KB）` };
  const dir = path.join(stateDir, ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), body);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ slug: id, title: String(title || id).slice(0, 80), description: String(description).slice(0, 300), createdAt: now, updatedAt: now }, null, 2) + '\n');
  return { ok: true, slug: id, url: `/apps/${id}` };
}

export function readApp({ stateDir, slug }) {
  const id = safeSlug(slug);
  if (!id) return null;
  try { return fs.readFileSync(path.join(stateDir, ROOT, id, 'index.html'), 'utf8'); } catch { return null; }
}

export function removeApp({ stateDir, slug }) {
  const id = safeSlug(slug);
  if (!id) return { ok: false, error: 'slug 不合法' };
  try { fs.rmSync(path.join(stateDir, ROOT, id), { recursive: true, force: true }); return { ok: true }; }
  catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
}
