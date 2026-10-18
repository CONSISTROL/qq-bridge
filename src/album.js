// 相册：把散落在各处、跟图片有关的东西收成**一个索引 + 一份元数据**。
//
// 为什么要有它：图片相关的功能以前是散的——本地图库 assets/stickers（AI 存图/发图的来源）、
// pixiv 抓取样例 state/pixiv-picks、B站视频帧 state/video-cache、AI 发过的图 state/sent-images，
// 还有聊天里别人发的图（以前只下载到临时目录看完就删）。控制台里也分成「AI 图片」和「表情包」
// 两个页面。现在统一成一个相册：**同一份索引、同一套元数据（添加时间/来源/备注/标签）**。
//
// 元数据落在 state/album-meta.json（按 "来源:文件名" 做 key），这样文件本身不用动，
// 重扫也不会把备注冲掉。
import fs from 'node:fs';
import path from 'node:path';

export const ALBUM_META_FILE = 'album-meta.json';
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** 相册里的"来源"：每个来源就是一个目录（外加可选的索引文件）。 */
export const ALBUM_SOURCES = [
  { id: 'chat', label: '聊天收到的图', dir: (ctx) => path.join(ctx.stateDir, 'album-inbox') },
  { id: 'sent', label: 'AI 发出的图', dir: (ctx) => path.join(ctx.stateDir, 'sent-images') },
  { id: 'library', label: '本地图库', dir: (ctx) => path.join(ctx.root, 'assets', 'stickers'), indexFile: 'index.json' },
  { id: 'pixiv', label: 'pixiv 抓取', dir: (ctx) => path.join(ctx.stateDir, 'pixiv-picks') },
  { id: 'video', label: '视频帧', dir: (ctx) => path.join(ctx.stateDir, 'video-cache') }
];

export function itemId(sourceId, fileName) {
  return `${sourceId}:${fileName}`;
}

export function isAlbumImageName(name) {
  return IMAGE_RE.test(String(name ?? ''));
}

/** 读一个来源目录里的图片文件名（不递归；跳过索引文件）。 */
export function listSourceFiles(dir, indexFile = '') {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && isAlbumImageName(e.name) && e.name !== indexFile)
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** 读来源的索引（本地图库有 index.json，带标题/来源/尺寸），解析失败就当没有。 */
export function readSourceIndex(dir, indexFile = '') {
  if (!indexFile) return new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, indexFile), 'utf8'));
    const items = Array.isArray(raw?.items) ? raw.items : [];
    const map = new Map();
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const file = String(it.file ?? it.name ?? '').trim();
      if (file) map.set(file, it);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * 汇总相册条目（纯逻辑，stat/save 都可注入，便于测试）。
 * @param {{ ctx:{root:string,stateDir:string}, meta:object, now?:number,
 *           stat?: (file:string)=>{size:number,mtimeMs:number},
 *           metaFor?: (id:string)=>object }} input
 */
export function collectAlbumItems({ ctx, meta = {}, now = Date.now(), stat = null, listFiles = listSourceFiles } = {}) {
  const items = [];
  const doStat = stat ?? ((file) => { try { const s = fs.statSync(file); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; } });
  for (const def of ALBUM_SOURCES) {
    const dir = def.dir(ctx);
    const index = def.indexFile ? readSourceIndex(dir, def.indexFile) : new Map();
    for (const name of listFiles(dir, def.indexFile)) {
      const abs = path.join(dir, name);
      const st = doStat(abs);
      if (!st) continue;
      const id = itemId(def.id, name);
      const custom = meta && typeof meta === 'object' ? meta[id] : null;
      const fromIndex = index.get(name) || {};
      items.push({
        id,
        file: name,
        source: def.id,
        sourceLabel: def.label,
        bytes: st.size,
        addedAt: Number(custom?.addedAt) || Number(st.mtimeMs) || now,
        notes: String(custom?.notes ?? fromIndex.title ?? fromIndex.origin ?? ''),
        tags: Array.isArray(custom?.tags) ? custom.tags : (Array.isArray(fromIndex.tags) ? fromIndex.tags : []),
        width: Number(fromIndex.width) || 0,
        height: Number(fromIndex.height) || 0,
        indexed: Boolean(fromIndex.title || fromIndex.origin),
        hasCustomMeta: Boolean(custom && (custom.notes || (custom.tags && custom.tags.length)))
      });
    }
  }
  items.sort((a, b) => b.addedAt - a.addedAt);
  return items;
}

/** 更新一条元数据（备注/标签），返回新的 meta 对象（不改入参）。 */
export function updateAlbumMeta(meta, id, patch = {}, now = Date.now()) {
  const next = { ...(meta && typeof meta === 'object' ? meta : {}) };
  const prev = next[id] && typeof next[id] === 'object' ? next[id] : {};
  const entry = { ...prev };
  if (patch.notes !== undefined) entry.notes = String(patch.notes ?? '').trim().slice(0, 500);
  if (patch.tags !== undefined) {
    const tags = Array.isArray(patch.tags) ? patch.tags : String(patch.tags ?? '').split(/[,，\s]+/);
    entry.tags = [...new Set(tags.map((t) => String(t ?? '').trim()).filter(Boolean))].slice(0, 20);
  }
  entry.updatedAt = now;
  if (!entry.notes && (!entry.tags || !entry.tags.length)) delete next[id];
  else next[id] = entry;
  return next;
}

/** 统计（给相册页头部用）。 */
export function albumStats(items = []) {
  const bySource = {};
  let bytes = 0;
  for (const it of items) {
    bySource[it.source] = (bySource[it.source] || 0) + 1;
    bytes += Number(it.bytes) || 0;
  }
  return { count: items.length, bytes, bySource };
}

/** 相册写入聊天图（桥接收到 AI 要看图时调用）：落盘 + 返回条目 id。 */
export function saveChatImage({ ctx, buffer, name, ext = 'jpg' } = {}) {
  const dir = path.join(ctx.stateDir, 'album-inbox');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name ?? '').replace(/[^\w.-]/g, '_').slice(0, 80) || `img-${Date.now()}`;
  const fileName = isAlbumImageName(safe) ? safe : `${safe}.${ext}`;
  fs.writeFileSync(path.join(dir, fileName), buffer);
  return itemId('chat', fileName);
}

// ── 回收站 ────────────────────────────────────────────────────────────────
// 删除不抹盘：文件挪到 state/album-trash/<来源>/<时间戳>-<原名>，这里提供查看/还原/彻底删。
export const TRASH_DIR = 'album-trash';

export function trashPath({ stateDir, source, trashName }) {
  return path.join(stateDir, TRASH_DIR, String(source), String(trashName));
}

/** 解析回收站文件名：`<毫秒时间戳>-<原名>`（原名里可能有 `-`，只切第一个）。 */
export function parseTrashName(trashName) {
  const m = /^(\d{10,})-(.+)$/.exec(String(trashName ?? ''));
  if (!m) return { deletedAt: 0, file: String(trashName ?? '') };
  return { deletedAt: Number(m[1]) || 0, file: m[2] };
}

/** 列出回收站（可按来源过滤），新的在前。 */
export function listTrash({ stateDir, source = '', stat = null } = {}) {
  const root = path.join(stateDir, TRASH_DIR);
  const doStat = stat ?? ((f) => { try { const s = fs.statSync(f); return { size: s.size }; } catch { return null; } });
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
  for (const src of dirs) {
    if (source && src !== source) continue;
    let names = [];
    try { names = fs.readdirSync(path.join(root, src)); } catch { continue; }
    for (const trashName of names) {
      if (!isAlbumImageName(trashName.replace(/^\d{10,}-/, ''))) continue;
      const st = doStat(path.join(root, src, trashName));
      const parsed = parseTrashName(trashName);
      out.push({ source: src, trashName, file: parsed.file, deletedAt: parsed.deletedAt, bytes: st ? st.size : 0 });
    }
  }
  out.sort((a, b) => b.deletedAt - a.deletedAt);
  return out;
}

/** 把回收站里的文件还原回它的来源目录（同名已存在时加时间戳后缀，不覆盖）。 */
export function restoreTrash({ stateDir, root, source, trashName, now = Date.now() }) {
  const def = ALBUM_SOURCES.find((d) => d.id === source);
  if (!def) return { ok: false, error: '未知来源' };
  const from = trashPath({ stateDir, source, trashName });
  const dir = def.dir({ root, stateDir });
  const parsed = parseTrashName(trashName);
  let target = path.join(dir, parsed.file);
  let n = 1;
  while (fs.existsSync(target)) target = path.join(dir, `${parsed.file.replace(/(\.[^.]+)$/, '')}-${now}-${n++}$1`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(from, target);
    return { ok: true, file: path.basename(target) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 彻底删除一条（回收站内）。 */
export function purgeTrash({ stateDir, source, trashName }) {
  try { fs.unlinkSync(trashPath({ stateDir, source, trashName })); return { ok: true }; }
  catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
}

/** 清空回收站（可按来源）。 */
export function emptyTrash({ stateDir, source = '' } = {}) {
  const items = listTrash({ stateDir, source });
  let removed = 0;
  for (const it of items) if (purgeTrash({ stateDir, source: it.source, trashName: it.trashName }).ok) removed += 1;
  return { removed };
}

// ── QQ 收藏表情（不是本地文件，是 QQ 上的图 + 本地笔记）────────────────────
// 单列一个来源 `sticker`：id 就是表情的 emoji_id/md5，笔记直接来自 stickers.json
// （localRemark / desc / localNote / tags）——这就是「AI 记忆里的表情笔记」，
// 搬进相册统一管理，改这里等于改 AI 的记忆。
export const STICKER_SOURCE = { id: 'sticker', label: '收藏表情' };

export function collectStickerItems({ stickers = [], meta = {} } = {}) {
  const items = [];
  for (const s of Array.isArray(stickers) ? stickers : []) {
    const id = String(s?.id ?? s?.emojiId ?? s?.md5 ?? '').trim();
    if (!id) continue;
    // 笔记真源是相册的 album-meta（sticker:<id>）；stickers.json 只保留 QQ 官方 desc 作为兜底标签。
    const custom = meta && typeof meta === 'object' ? meta[itemId('sticker', id)] : null;
    const notes = String(custom?.notes || s.localRemark || s.localNote || s.desc || '').trim();
    items.push({
      id: itemId('sticker', id),
      file: id,
      source: 'sticker',
      sourceLabel: STICKER_SOURCE.label,
      bytes: 0,
      addedAt: Number(s.lastUsedAt) || 0,
      notes,
      tags: Array.isArray(custom?.tags) && custom.tags.length ? custom.tags : (Array.isArray(s.tags) ? s.tags : []),
      useCount: Number(s.useCount) || 0,
      isSticker: true
    });
  }
  return items;
}
