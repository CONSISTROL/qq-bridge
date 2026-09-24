// AI 图片管理：把「AI 从网上抓下来、落在本机磁盘上的图片」收成一个可管理的入口。
//
// 为什么需要它：AI 会往本机落图——本地图库 assets/stickers（发图/存表情的来源）、
// pixiv 抓取样例 state/pixiv-picks、B站视频帧缓存 state/video-cache。这些目录以前只有
// 「写」没有「管」：控制台看不到占了多少盘，想删只能去 shell 里 rm。这个模块把它们
// 统一列出来，并提供逐张删 / 按来源清空 / 按时间或容量自然清理。
//
// 与 memory-admin 的关键区别：记忆是 JSON，删错能整份快照回滚；图片动辄几十上百 MB，
// 每次删除都复制一份不现实。所以这里用**回收站**：删除 = 移动到 state/image-trash/<批次>/，
// 批次带 manifest，能逐张或整批还原、也能彻底清空。任何删除都不会直接 unlink 掉文件。
//
// 安全边界：
// - 只认注册过的 source（默认三个目录），名字必须是纯文件名 + 图片后缀，路径解析后
//   必须仍在来源目录内（符号链接也按 realpath 核），杜绝 `../` 与软链逃逸；
// - 破坏性动作全部只给控制台用（bridge 侧带 x-agent-token 一律 403）——AI 可以看图、
//   发图，但不该能删管理员的图库；
// - 回收站超预算时按批次从最旧的开始丢（先丢回收站，不碰在用文件）。
//
// 设计约束：纯函数 + 注入依赖，scripts/test-image-admin.mjs 可在临时目录里端到端跑。

import fs from 'node:fs';
import path from 'node:path';

/** 受管的图片后缀。目录扫描、删除、回收站还原都按它过滤。 */
export const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i;

const MIME_BY_EXT = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
});

const MANIFEST_NAME = 'manifest.json';
const TRASH_STAMP_RE = /^img-[0-9]{8}-[0-9]{6}(?:-[0-9]+)?$/;
const MAX_NAME_LEN = 200;
const MAX_ITEMS_PER_CALL = 500;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
/** 单张图片给控制台预览/下载的上限：本机自己下的图，超过这个体积大概率是误操作。 */
export const MAX_SERVE_BYTES = 32 * 1024 * 1024;

export function isImageFileName(name) {
  return IMAGE_EXT_RE.test(String(name ?? '').trim());
}

/**
 * 归一化一个「纯文件名」：不安全（带路径/`..`/隐藏文件/超长/非图片后缀）时返回空串。
 * 这是所有按名字操作的唯一入口，先过它再过路径前缀校验。
 */
export function safeImageName(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > MAX_NAME_LEN) return '';
  if (raw.includes('\0') || raw.includes('/') || raw.includes('\\')) return '';
  if (raw === '.' || raw === '..' || raw.startsWith('.')) return '';
  if (!isImageFileName(raw)) return '';
  return raw;
}

/** 目录 + 纯文件名 → 绝对路径（先做纯文件名校验，再确认解析结果没跑出目录）。 */
export function resolveInsideDir(baseDir, name) {
  const safe = safeImageName(name);
  if (!safe) throw new Error(`非法图片文件名：${String(name ?? '').slice(0, 80)}`);
  const base = path.resolve(baseDir);
  const abs = path.resolve(base, safe);
  if (abs !== path.join(base, safe) || !abs.startsWith(base + path.sep)) throw new Error('图片路径越界');
  return abs;
}

/** 用 realpath 再核一遍（防符号链接逃逸）；来源目录/文件不存在时给一句人话错误。 */
export function assertInsideDir(baseDir, abs) {
  let baseReal;
  try {
    baseReal = fs.realpathSync(baseDir);
  } catch {
    throw new Error('来源目录不存在');
  }
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new Error('文件不存在');
  }
  if (real !== baseReal && !real.startsWith(baseReal + path.sep)) throw new Error('图片路径越界（符号链接指向来源目录之外）');
  return real;
}

export function mimeOfImageName(name) {
  return MIME_BY_EXT[path.extname(String(name ?? '')).toLowerCase()] || 'application/octet-stream';
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 默认受管来源。library 的目录由调用方传入（桥接用 resolveImageConfig().libraryDir，
 * 这样管理员在控制台改了「本地图库目录」后，两边永远指着同一个地方）。
 */
export function defaultImageSources({ root, stateDir, libraryDir = '' } = {}) {
  const base = path.resolve(String(root ?? '.'));
  const state = path.resolve(String(stateDir ?? path.join(base, 'state')));
  return [
    {
      id: 'library',
      title: '本地图库',
      dir: libraryDir || path.join(base, 'assets', 'stickers'),
      index: 'index.json',
      note: 'AI 发图 / 存表情时用的本地图库。这里删掉文件会同步摘掉 index.json 里的条目，回收站还原时条目也会一起回来。'
    },
    {
      id: 'pixivPicks',
      title: 'pixiv 抓取样例',
      dir: path.join(state, 'pixiv-picks'),
      note: '抓 pixiv 榜单时落盘的样图（研究/选题用），删掉不影响 AI 发图。'
    },
    {
      id: 'videoCache',
      title: 'B站视频帧缓存',
      dir: path.join(state, 'video-cache'),
      note: 'AI 看 B站视频时下载的雪碧图帧缓存；删掉只是下次再看同一期时重新下载。'
    },
    {
      id: 'sentImages',
      title: 'AI 发出去的网络图',
      dir: path.join(state, 'sent-images'),
      index: 'index.json',
      note: '桥接自己下载并发给 QQ（或存进收藏表情）的网络图，落盘留一份；删掉只影响本地回看，QQ 里已发出的消息不受影响。历史遗留的（改动前发的）可用「补抓历史发过的图」从会话记录与日志里重新捞回来。'
    }
  ];
}

/** 来源声明归一化：非法 id/目录直接丢弃（配置写错不该让整页起不来）。 */
export function normalizeImageSources(sources, root) {
  const base = path.resolve(String(root ?? '.'));
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(sources) ? sources : []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id ?? '').trim();
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(id) || seen.has(id)) continue;
    const dir = String(raw.dir ?? '').trim();
    if (!dir) continue;
    seen.add(id);
    out.push({
      id,
      title: String(raw.title ?? id).trim().slice(0, 60) || id,
      note: String(raw.note ?? '').trim().slice(0, 300),
      dir: path.resolve(base, dir),
      index: raw.index ? String(raw.index).trim().slice(0, 80) : ''
    });
  }
  return out;
}

function nowIso() { return new Date().toISOString(); }

function statSafe(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function moveFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    // 跨设备（回收站被指到别的盘）：退化成复制 + 删源，失败时保证源文件还在。
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

function readJsonFile(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function stampString(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `img-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

/**
 * AI 图片管理模块。
 *
 * @param {object} deps
 * @param {string} deps.root            仓库根目录（相对来源目录的解析基准）
 * @param {string} deps.stateDir        state 目录（回收站放这里）
 * @param {Array}  [deps.sources]       来源声明；缺省用 defaultImageSources
 * @param {string} [deps.trashDir]      回收站目录，默认 state/image-trash
 * @param {number} [deps.trashMaxBytes] 回收站容量上限（超了从最旧批次开始丢），0 = 不限
 * @param {Function} [deps.log]
 * @param {Function} [deps.onMutate]    发生删除/还原后回调（{ action, source }），桥接用它刷新图库缓存
 */
export function createImageAdmin(deps = {}) {
  const {
    root = '.',
    stateDir,
    sources = defaultImageSources({ root, stateDir }),
    trashDir = path.join(String(stateDir ?? path.join(root, 'state')), 'image-trash'),
    trashMaxBytes = 500 * 1024 * 1024,
    log = () => {},
    onMutate = () => {}
  } = deps;

  const registry = normalizeImageSources(sources, root);
  const byId = new Map(registry.map((s) => [s.id, s]));
  const maxTrashBytes = Math.max(0, Number(trashMaxBytes) || 0);

  function sourceOf(id) {
    const src = byId.get(String(id ?? '').trim());
    if (!src) throw new Error(`未知的图片来源：${String(id ?? '').trim() || '(空)'}`);
    return src;
  }

  // ── 目录扫描 / 索引 ────────────────────────────────────────────────
  function scanSource(src) {
    let entries = [];
    let exists = true;
    try {
      entries = fs.readdirSync(src.dir, { withFileTypes: true });
    } catch {
      exists = false;
      entries = [];
    }
    const files = [];
    let otherFiles = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!isImageFileName(entry.name)) { otherFiles += 1; continue; }
      const st = statSafe(path.join(src.dir, entry.name));
      if (!st) continue;
      files.push({ name: entry.name, bytes: st.size, mtime: st.mtimeMs });
    }
    files.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    return { exists, files, otherFiles };
  }

  function readIndex(src) {
    if (!src.index) return { file: '', entries: new Map(), raw: null };
    const file = path.join(src.dir, src.index);
    const st = statSafe(file);
    if (!st || st.size > MAX_INDEX_BYTES) return { file, entries: new Map(), raw: null };
    const parsed = readJsonFile(file);
    const entries = new Map();
    for (const item of Array.isArray(parsed?.items) ? parsed.items : []) {
      if (item && item.file) entries.set(String(item.file), item);
    }
    return { file, entries, raw: parsed && typeof parsed === 'object' ? parsed : null };
  }

  /** 摘掉索引里已删文件的条目（只在有索引文件的来源上做事）。 */
  function dropIndexEntries(src, removedNames) {
    if (!src.index || !removedNames.length) return;
    const idx = readIndex(src);
    if (!idx.raw || !Array.isArray(idx.raw.items)) return;
    const gone = new Set(removedNames);
    const kept = idx.raw.items.filter((item) => !(item && item.file && gone.has(String(item.file))));
    if (kept.length === idx.raw.items.length) return;
    try {
      atomicWriteJson(idx.file, { ...idx.raw, items: kept, updatedAt: nowIso() });
    } catch (error) {
      log(`[image-admin] 索引更新失败 ${idx.file}：${error?.message ?? error}`);
    }
  }

  /** 还原时把当初摘下来的索引条目放回去（按 file 去重）。 */
  function restoreIndexEntries(src, entries) {
    if (!src.index || !entries.length) return;
    const idx = readIndex(src);
    const raw = idx.raw && Array.isArray(idx.raw.items) ? idx.raw : { version: 1, items: [] };
    const have = new Set(raw.items.filter((i) => i && i.file).map((i) => String(i.file)));
    let added = 0;
    for (const item of entries) {
      if (!item || !item.file || have.has(String(item.file))) continue;
      raw.items.push(item);
      have.add(String(item.file));
      added += 1;
    }
    if (!added) return;
    try {
      atomicWriteJson(idx.file, { ...raw, items: raw.items, updatedAt: nowIso() });
    } catch (error) {
      log(`[image-admin] 索引还原失败 ${idx.file}：${error?.message ?? error}`);
    }
  }

  // ── 回收站 ────────────────────────────────────────────────────────
  function batchDirs() {
    let entries = [];
    try { entries = fs.readdirSync(trashDir, { withFileTypes: true }); } catch { return []; }
    return entries
      .filter((e) => e.isDirectory() && TRASH_STAMP_RE.test(e.name))
      .map((e) => path.join(trashDir, e.name));
  }

  function readManifest(dir) {
    const manifest = readJsonFile(path.join(dir, MANIFEST_NAME));
    if (manifest && Array.isArray(manifest.files)) return manifest;
    // manifest 丢了也要能列出来：退化成扫目录（文件名带来源 id 前缀无法还原归属，只能整批清）
    const files = [];
    let bytes = 0;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name === MANIFEST_NAME) continue;
        const st = statSafe(path.join(dir, entry.name));
        if (!st) continue;
        files.push({ source: '', name: entry.name, bytes: st.size });
        bytes += st.size;
      }
    } catch { /* 目录没了 */ }
    return { stamp: path.basename(dir), at: 0, reason: '（manifest 缺失）', files, bytes, broken: true };
  }

  function listTrashBatches() {
    return batchDirs()
      .map((dir) => ({ dir, ...readManifest(dir) }))
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0) || String(b.stamp).localeCompare(String(a.stamp)));
  }

  function trashUsage() {
    let bytes = 0;
    let files = 0;
    const dirs = batchDirs();
    for (const dir of dirs) {
      const manifest = readManifest(dir);
      bytes += Number(manifest.bytes) || 0;
      files += Array.isArray(manifest.files) ? manifest.files.length : 0;
    }
    return { batches: dirs.length, files, bytes };
  }

  /**
   * 回收站超预算：从最旧的批次开始整批丢掉（先丢回收站，不碰在用文件）。
   * **最新那一批永远留着**：刚删的东西如果因为「上限比它还小」被立刻抹掉，
   * 回收站就成了摆设——上限再紧也该保住最近一次删除的可还原性。
   */
  function pruneTrash() {
    if (!maxTrashBytes) return 0;
    const newestFirst = listTrashBatches(); // 新 → 旧
    const candidates = newestFirst.slice(1).reverse(); // 旧 → 新，且不含最新那批
    let total = newestFirst.reduce((sum, b) => sum + (Number(b.bytes) || 0), 0);
    let dropped = 0;
    for (const batch of candidates) {
      if (total <= maxTrashBytes) break;
      try { fs.rmSync(batch.dir, { recursive: true, force: true }); } catch { continue; }
      total -= Number(batch.bytes) || 0;
      dropped += 1;
    }
    if (dropped) log(`[image-admin] 回收站超 ${formatBytes(maxTrashBytes)}，丢弃最旧 ${dropped} 个批次`);
    return dropped;
  }

  /** 新建一个回收站批次并返回写入句柄（写入 manifest 后这批才算数）。 */
  function createBatch(reason) {
    const base = stampString();
    for (let i = 1; i < 100; i += 1) {
      const stamp = i === 1 ? base : `${base}-${i}`;
      const dir = path.join(trashDir, stamp);
      if (fs.existsSync(dir)) continue;
      fs.mkdirSync(dir, { recursive: true });
      return {
        stamp,
        dir,
        files: [],
        bytes: 0,
        settle() {
          if (!this.files.length) {
            try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* 空批次 */ }
            return null;
          }
          const manifest = { version: 1, stamp: this.stamp, at: Date.now(), reason: String(reason ?? '').slice(0, 120), bytes: this.bytes, files: this.files };
          atomicWriteJson(path.join(this.dir, MANIFEST_NAME), manifest);
          return manifest;
        }
      };
    }
    throw new Error('回收站批次号冲突，请稍后再试');
  }

  // ── 删除（统一走回收站）──────────────────────────────────────────
  /**
   * @param {Array<{source: string, name: string}>} entries
   * @param {string} reason
   */
  function moveToTrash(entries, reason) {
    const batch = createBatch(reason);
    const removed = [];
    const failed = [];
    const removedBySource = new Map();
    for (const entry of entries) {
      let src;
      let abs;
      try {
        src = sourceOf(entry.source);
        const name = safeImageName(entry.name);
        if (!name) throw new Error('非法文件名');
        abs = resolveInsideDir(src.dir, name);
        assertInsideDir(src.dir, abs);
      } catch (error) {
        failed.push({ source: String(entry.source ?? ''), name: String(entry.name ?? ''), error: String(error?.message ?? error) });
        continue;
      }
      const name = path.basename(abs);
      const st = statSafe(abs);
      if (!st) { failed.push({ source: src.id, name, error: '文件不存在' }); continue; }
      const indexEntry = src.index ? readIndex(src).entries.get(name) || null : null;
      const dest = path.join(batch.dir, src.id, name);
      try {
        moveFile(abs, dest);
      } catch (error) {
        failed.push({ source: src.id, name, error: `移入回收站失败：${error?.message ?? error}` });
        continue;
      }
      batch.files.push({ source: src.id, name, bytes: st.size, entry: indexEntry });
      batch.bytes += st.size;
      removed.push({ source: src.id, name, bytes: st.size });
      if (!removedBySource.has(src.id)) removedBySource.set(src.id, []);
      removedBySource.get(src.id).push(name);
    }
    const manifest = batch.settle();
    for (const [sid, names] of removedBySource) dropIndexEntries(byId.get(sid), names);
    if (removed.length) pruneTrash();
    if (removed.length) {
      log(`[image-admin] ${reason || '删除'}：${removed.length} 张 / ${formatBytes(batch.bytes)} → 回收站 ${manifest?.stamp ?? ''}`);
      try { onMutate({ action: 'remove', sources: [...removedBySource.keys()] }); } catch { /* 回调失败不影响删除结果 */ }
    }
    return { removed, failed, bytes: batch.bytes, stamp: manifest?.stamp ?? '' };
  }

  /** 来源里的全部图片 → 回收站（整目录清空）。 */
  function clearSource(src, reason) {
    const { files } = scanSource(src);
    return moveToTrash(files.map((f) => ({ source: src.id, name: f.name })), reason);
  }

  // ── 对外接口 ──────────────────────────────────────────────────────
  function inventory() {
    const list = registry.map((src) => {
      const { exists, files, otherFiles } = scanSource(src);
      const idx = readIndex(src);
      const nameSet = new Set(files.map((f) => f.name));
      let indexed = 0;
      let missing = 0;
      for (const [file] of idx.entries) {
        if (nameSet.has(file)) indexed += 1;
        else missing += 1;
      }
      const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
      return {
        id: src.id,
        title: src.title,
        note: src.note,
        dir: src.dir,
        hasIndex: Boolean(src.index),
        exists,
        count: files.length,
        bytes,
        otherFiles,
        indexed,
        orphan: src.index ? files.length - indexed : 0,
        missing,
        newestAt: files.length ? files[0].mtime : 0,
        oldestAt: files.length ? files[files.length - 1].mtime : 0
      };
    });
    const trash = trashUsage();
    return {
      ok: true,
      generatedAt: nowIso(),
      sources: list,
      totals: {
        count: list.reduce((s, x) => s + x.count, 0),
        bytes: list.reduce((s, x) => s + x.bytes, 0),
        trashFiles: trash.files,
        trashBytes: trash.bytes,
        trashBatches: trash.batches
      },
      trash: { dir: trashDir, maxBytes: maxTrashBytes, ...trash, latest: listTrashBatches().slice(0, 5).map((b) => ({ stamp: b.stamp, at: b.at, bytes: b.bytes, files: b.files.length, reason: b.reason })) }
    };
  }

  function items({ source, q = '', sort = 'time', limit = 300 } = {}) {
    const src = sourceOf(source);
    const { exists, files, otherFiles } = scanSource(src);
    const idx = readIndex(src);
    const needle = String(q ?? '').trim().toLowerCase();
    const max = Math.max(1, Math.min(2000, Number(limit) || 300));
    let list = files.map((f) => {
      const meta = idx.entries.get(f.name) || {};
      return {
        source: src.id,
        name: f.name,
        bytes: f.bytes,
        mtime: f.mtime,
        ext: path.extname(f.name).slice(1).toLowerCase(),
        indexed: Boolean(idx.entries.get(f.name)),
        title: String(meta.title || '').trim(),
        origin: String(meta.origin || '').trim(),
        url: String(meta.url || '').trim(),
        sha256: String(meta.sha256 || ''),
        width: Number(meta.width) || 0,
        height: Number(meta.height) || 0
      };
    });
    if (needle) {
      list = list.filter((it) => [it.name, it.title, it.origin, it.url].some((v) => String(v ?? '').toLowerCase().includes(needle)));
    }
    const total = list.length;
    const mode = String(sort || 'time').trim();
    if (mode === 'size') list.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
    else if (mode === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else list.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    const page = list.slice(0, max);
    return {
      ok: true,
      source: { id: src.id, title: src.title, note: src.note, dir: src.dir, exists },
      total,
      matched: total,
      truncated: total > page.length,
      otherFiles,
      index: src.index ? { file: path.join(src.dir, src.index), entries: idx.entries.size } : null,
      items: page.map((it) => ({
        ...it,
        // 故意**不带开头的 /**：控制台可能被反代在子路径下（如
        // https://host/local-web/http/127.0.0.1:3100/），根绝对地址会跑出前缀、打到反代自己的
        // 接口上（实测就是 {"error":{"code":"NOT_FOUND","message":"接口不存在"}}）。
        // 相对地址由浏览器按当前页面解析，直连与子路径反代都能用。
        thumb: `api/ai-images/file?source=${encodeURIComponent(src.id)}&name=${encodeURIComponent(it.name)}`
      }))
    };
  }

  /** 给控制台预览/下载单张图片用的定位（真正的字节流由 bridge 负责写响应）。 */
  function fileFor({ source, name } = {}) {
    const src = sourceOf(source);
    const safe = safeImageName(name);
    if (!safe) throw new Error('非法图片文件名');
    const abs = resolveInsideDir(src.dir, safe);
    const real = assertInsideDir(src.dir, abs);
    const st = statSafe(real);
    if (!st || !st.isFile()) throw new Error('图片不存在');
    if (st.size > MAX_SERVE_BYTES) throw new Error(`图片过大（${formatBytes(st.size)}），不在控制台预览`);
    return { abs: real, name: safe, bytes: st.size, mime: mimeOfImageName(safe), mtime: st.mtimeMs };
  }

  function remove({ source, names = [], reason = '控制台删除' } = {}) {
    const src = sourceOf(source);
    const list = (Array.isArray(names) ? names : [names]).map(String).filter(Boolean);
    if (!list.length) return { ok: false, error: '没有指定要删除的图片' };
    if (list.length > MAX_ITEMS_PER_CALL) return { ok: false, error: `一次最多删 ${MAX_ITEMS_PER_CALL} 张（这次 ${list.length} 张）` };
    const result = moveToTrash(list.map((name) => ({ source: src.id, name })), reason);
    return {
      ok: result.removed.length > 0 || result.failed.length === 0,
      source: src.id,
      removed: result.removed,
      failed: result.failed,
      bytes: result.bytes,
      trash: result.stamp,
      error: result.removed.length === 0 && result.failed.length ? `没有文件被删除：${result.failed[0].error}` : '',
      inventory: inventory()
    };
  }

  function clear({ source, reason = '控制台清空' } = {}) {
    const src = sourceOf(source);
    const result = clearSource(src, reason);
    return {
      ok: true,
      source: src.id,
      removed: result.removed,
      failed: result.failed,
      bytes: result.bytes,
      trash: result.stamp,
      inventory: inventory()
    };
  }

  /**
   * 自然清理：先按「保留天数」清太旧的，再按「总容量上限」从最旧的开始补删到预算内。
   * 两个规则都是 0 = 不启用；至少要启用一个，否则拒绝（避免「点了没反应」）。
   */
  function forget({ source = '', olderThanDays = 30, maxTotalMB = 0, reason = '自然清理' } = {}) {
    const days = Number(olderThanDays);
    const budgetMB = Number(maxTotalMB);
    const ageOn = Number.isFinite(days) && days > 0;
    const budgetOn = Number.isFinite(budgetMB) && budgetMB > 0;
    if (!ageOn && !budgetOn) return { ok: false, error: '至少要启用一条规则（保留天数 或 总容量上限）' };
    const selected = source ? [sourceOf(source)] : registry;
    if (!selected.length) return { ok: false, error: '没有可清理的图片来源' };

    const ageMs = ageOn ? days * 24 * 60 * 60 * 1000 : 0;
    const cutoff = ageOn ? Date.now() - ageMs : 0;
    const victims = new Map(); // sourceId -> names[]
    let keptBytes = 0;
    const keepPool = [];
    for (const src of selected) {
      const { files } = scanSource(src);
      const picked = [];
      for (const f of files) {
        if (ageOn && f.mtime < cutoff) picked.push(f);
        else { keptBytes += f.bytes; keepPool.push({ source: src.id, ...f }); }
      }
      victims.set(src.id, picked);
    }
    let budgetDropped = 0;
    if (budgetOn) {
      const budget = budgetMB * 1024 * 1024;
      if (keptBytes > budget) {
        keepPool.sort((a, b) => a.mtime - b.mtime);
        for (const item of keepPool) {
          if (keptBytes <= budget) break;
          victims.get(item.source).push({ name: item.name, bytes: item.bytes, mtime: item.mtime });
          keptBytes -= item.bytes;
          budgetDropped += 1;
        }
      }
    }
    const entries = [];
    const bySource = {};
    for (const [sid, list] of victims) {
      if (!list.length) continue;
      entries.push(...list.map((f) => ({ source: sid, name: f.name })));
      bySource[sid] = { count: list.length, bytes: list.reduce((s, f) => s + f.bytes, 0) };
    }
    if (!entries.length) {
      return { ok: true, forgotten: { files: 0, bytes: 0, bySource: {}, ageDropped: 0, budgetDropped: 0 }, trash: '', inventory: inventory() };
    }
    const result = moveToTrash(entries, reason);
    const ageDropped = result.removed.length - budgetDropped;
    return {
      ok: true,
      forgotten: { files: result.removed.length, bytes: result.bytes, bySource, ageDropped: Math.max(0, ageDropped), budgetDropped },
      applied: { olderThanDays: ageOn ? days : 0, maxTotalMB: budgetOn ? budgetMB : 0 },
      failed: result.failed,
      trash: result.stamp,
      inventory: inventory()
    };
  }

  function listTrash() {
    const batches = listTrashBatches().map((b) => ({
      stamp: b.stamp,
      at: Number(b.at) || 0,
      reason: String(b.reason || ''),
      broken: b.broken === true,
      bytes: Number(b.bytes) || (Array.isArray(b.files) ? b.files.reduce((s, f) => s + (Number(f.bytes) || 0), 0) : 0),
      files: Array.isArray(b.files) ? b.files.length : 0,
      items: (Array.isArray(b.files) ? b.files : []).map((f) => ({ source: String(f.source || ''), name: String(f.name || ''), bytes: Number(f.bytes) || 0 }))
    }));
    return { ok: true, dir: trashDir, maxBytes: maxTrashBytes, usage: trashUsage(), batches };
  }

  function batchDirFor(stamp) {
    const clean = String(stamp ?? '').trim();
    if (!TRASH_STAMP_RE.test(clean)) throw new Error('非法的回收站批次号');
    const dir = path.join(trashDir, clean);
    if (!fs.existsSync(dir)) throw new Error('回收站批次不存在');
    return dir;
  }

  /** 还原：整批或指定几张。目标文件已存在时跳过（不覆盖在用文件）。 */
  function restore({ stamp, items: wanted = [] } = {}) {
    let dir;
    try {
      dir = batchDirFor(stamp);
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
    const manifest = readManifest(dir);
    const wantedKeys = new Set(
      (Array.isArray(wanted) ? wanted : []).map((it) => `${String(it?.source ?? '')}\u0000${String(it?.name ?? '')}`)
    );
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const targets = wantedKeys.size ? files.filter((f) => wantedKeys.has(`${f.source}\u0000${f.name}`)) : files;
    if (!targets.length) return { ok: false, error: '这批回收站里没有匹配的文件' };
    const restored = [];
    const failed = [];
    const stillThere = [];
    const indexBack = new Map(); // sourceId -> entries
    for (const item of files) {
      const selected = targets.includes(item);
      if (!selected) { stillThere.push(item); continue; }
      let src;
      try {
        src = sourceOf(item.source);
        const name = safeImageName(item.name);
        if (!name) throw new Error('非法文件名');
        const from = path.join(dir, src.id, name);
        if (!fs.existsSync(from)) throw new Error('回收站里找不到这个文件（可能已被彻底删除）');
        const to = resolveInsideDir(src.dir, name);
        if (fs.existsSync(to)) throw new Error('目标目录里已有同名文件，先改名或删掉它');
        moveFile(from, to);
        restored.push({ source: src.id, name, bytes: Number(item.bytes) || 0 });
        if (item.entry) {
          if (!indexBack.has(src.id)) indexBack.set(src.id, []);
          indexBack.get(src.id).push(item.entry);
        }
      } catch (error) {
        failed.push({ source: String(item.source ?? ''), name: String(item.name ?? ''), error: String(error?.message ?? error) });
      }
    }
    for (const [sid, entries] of indexBack) restoreIndexEntries(byId.get(sid), entries);
    // 还有没还原的 → 重写 manifest；全还原了 → 整批清掉
    if (stillThere.length) {
      atomicWriteJson(path.join(dir, MANIFEST_NAME), { ...manifest, files: stillThere, bytes: stillThere.reduce((s, f) => s + (Number(f.bytes) || 0), 0) });
    } else {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理空批次 */ }
    }
    if (restored.length) {
      log(`[image-admin] 从回收站 ${stamp} 还原 ${restored.length} 张`);
      try { onMutate({ action: 'restore', sources: [...new Set(restored.map((r) => r.source))] }); } catch { /* 忽略 */ }
    }
    return { ok: restored.length > 0, restored, failed, stamp, inventory: inventory() };
  }

  /** 彻底删除回收站：stamp='' 或 'all' = 清空整个回收站。 */
  function purge({ stamp = '' } = {}) {
    const clean = String(stamp ?? '').trim();
    let dirs;
    try {
      dirs = !clean || clean === 'all' ? batchDirs() : [batchDirFor(clean)];
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
    let files = 0;
    let bytes = 0;
    for (const dir of dirs) {
      const manifest = readManifest(dir);
      files += Array.isArray(manifest.files) ? manifest.files.length : 0;
      bytes += Number(manifest.bytes) || 0;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { log(`[image-admin] 彻底删除失败 ${dir}：${error?.message ?? error}`); }
    }
    if (dirs.length) log(`[image-admin] 彻底删除回收站 ${clean || '全部'}：${dirs.length} 个批次 / ${files} 张`);
    return { ok: true, purged: { batches: dirs.length, files, bytes }, inventory: inventory() };
  }

  return {
    inventory,
    items,
    fileFor,
    remove,
    clear,
    forget,
    listTrash,
    restore,
    purge,
    /** 供测试/控制台看当前注册了哪些来源 */
    sources: () => registry.map((s) => ({ ...s })),
    trashDir,
    maxTrashBytes
  };
}
