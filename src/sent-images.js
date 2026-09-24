// AI 发出去的网络图：把桥接自己下载并发到 QQ（或存进收藏表情）的图片在本机留一份。
//
// 为什么需要它：qq_send_image / qq_save_sticker 的链路是「下载 → 校验 → base64 → 网关」，
// 图片字节只在内存里过一遍就没了。后果是——群里发过的那张图，本地再也找不回来：
// 会话记录里只剩一条 URL（临时链接会过期、QQ 审核吞掉的那张连群友都没见过），
// 控制台「AI 图片」里自然也「没找到之前发的色图」。
//
// 所以这里在发送/保存成功解析出字节后就落一份到 state/sent-images/，并在 index.json 里记
// 来源 URL、哪个会话、什么档位、是否真的送达。它同时是控制台「AI 图片」的一个受管来源，
// 删除/回收站/自然清理都由 image-admin 统一负责（本模块只管写与索引）。
//
// 与图库 index.json 用同一套字段形状（file/bytes/sha256/title/origin/url/source），
// 这样 image-admin 不用认识第二种格式。
//
// 设计约束：纯函数 + 注入依赖；不 import 桥接；单测在临时目录里跑。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const INDEX_NAME = 'index.json';
const MAX_INDEX_BYTES = 8 * 1024 * 1024;

function nowIso() { return new Date().toISOString(); }

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${String(date.getMilliseconds()).padStart(3, '0')}`;
}

/** 按字节嗅探后缀：URL 后缀和真实格式经常不一致（pixiv 的 .png 里常常是 JPEG）。 */
export function extFromBuffer(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b.length >= 6 && b.slice(0, 4).toString('latin1') === 'GIF8') return '.gif';
  if (b.length >= 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return '.bmp';
  return '';
}

function extFromUrl(url) {
  try {
    const ext = path.extname(new URL(String(url)).pathname).toLowerCase();
    return /^\.(png|jpe?g|gif|webp|bmp|avif)$/.test(ext) ? ext : '';
  } catch {
    return '';
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readJsonSafe(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 给控制台看的一行出处：谁让它发的、什么类型。 */
export function originLabel({ key = '', kind = '' } = {}) {
  const where = String(key || '').trim() || '（未知会话）';
  const what = kind === 'sticker' ? '存表情' : kind === 'backfill' ? '补抓历史' : kind === 'collect' ? '收藏聊天图' : '发图';
  return `${where} · ${what}`;
}

/**
 * @param {object} deps
 * @param {string} deps.dir            存放目录（默认 state/sent-images）
 * @param {number} [deps.maxBytes]     总量上限（超了从最旧的开始丢），0 = 不限
 * @param {number} [deps.maxItems]     条数上限
 * @param {Function} [deps.log]
 */
export function createSentImageStore({ dir, maxBytes = 300 * 1024 * 1024, maxItems = 1000, log = () => {} } = {}) {
  const root = path.resolve(String(dir));
  const indexFile = path.join(root, INDEX_NAME);
  const capBytes = Math.max(0, Number(maxBytes) || 0);
  const capItems = Math.max(1, Number(maxItems) || 1000);
  // 建目录：让控制台「AI 图片」一进来就能看到这个来源（而不是「目录不存在」）。
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* 权限问题留给 store() 报错 */ }

  function readIndex() {
    const parsed = readJsonSafe(indexFile);
    const items = Array.isArray(parsed?.items) ? parsed.items.filter((x) => x && x.file) : [];
    return { version: 1, updatedAt: parsed?.updatedAt || nowIso(), items };
  }

  function save(obj) {
    atomicWriteJson(indexFile, obj);
  }

  function records() {
    return readIndex().items;
  }

  function removeEntry(file) {
    const idx = readIndex();
    const next = idx.items.filter((item) => item.file !== file);
    if (next.length === idx.items.length) return false;
    save({ ...idx, items: next, updatedAt: nowIso() });
    return true;
  }

  /**
   * 落一份图片。同一张（sha256 相同）已经存过就只更新元数据，不重复占盘。
   * @returns {object|null} 索引条目（带 duplicate 标记）
   */
  function store({ buffer, url = '', key = '', kind = 'send', delivered = null, messageId = '', rendition = '', artworkId = '', at = 0, width = 0, height = 0 } = {}) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
    if (!buf.length) return null;
    fs.mkdirSync(root, { recursive: true });
    const hash = sha256(buf);
    const idx = readIndex();
    const dup = idx.items.find((item) => item.sha256 === hash);
    if (dup) {
      dup.at = Number(at) || Date.now();
      if (delivered !== null && delivered !== undefined) dup.delivered = delivered === true;
      if (url) dup.url = url;
      if (key) dup.origin = originLabel({ key, kind });
      save({ ...idx, updatedAt: nowIso() });
      return { ...dup, duplicate: true };
    }
    const ext = extFromBuffer(buf) || extFromUrl(url) || '.jpg';
    const file = `${stamp()}-${hash.slice(0, 8)}${ext}`;
    fs.writeFileSync(path.join(root, file), buf);
    const item = {
      file,
      sha256: hash,
      bytes: buf.length,
      width: Number(width) || 0,
      height: Number(height) || 0,
      source: 'sent',
      title: artworkId ? `pixiv ${artworkId}${rendition ? ` · ${rendition}` : ''}` : (path.basename(String(url).split('?')[0]) || '网络图'),
      origin: originLabel({ key, kind }),
      url: String(url || ''),
      key: String(key || ''),
      kind: String(kind || 'send'),
      artworkId: String(artworkId || ''),
      rendition: String(rendition || ''),
      delivered: delivered === null || delivered === undefined ? null : delivered === true,
      messageId: messageId ? String(messageId) : '',
      at: Number(at) || Date.now()
    };
    idx.items.push(item);
    prune(idx);
    save({ ...idx, updatedAt: nowIso() });
    return item;
  }

  /** 发送完成后回填「到底送没送达」（网关回 ok ≠ QQ 收下了）。 */
  function update(file, patch = {}) {
    const idx = readIndex();
    const item = idx.items.find((x) => x.file === file);
    if (!item) return null;
    Object.assign(item, patch);
    save({ ...idx, updatedAt: nowIso() });
    return item;
  }

  /** 超上限就从最旧的开始丢（同时删文件与索引条目）。 */
  function prune(idx) {
    let total = idx.items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
    idx.items.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    let dropped = 0;
    while (idx.items.length > capItems || (capBytes > 0 && total > capBytes && idx.items.length > 1)) {
      const victim = idx.items.shift();
      if (!victim) break;
      total -= Number(victim.bytes) || 0;
      dropped += 1;
      try { fs.unlinkSync(path.join(root, victim.file)); } catch { /* 文件可能已被控制台删进回收站 */ }
    }
    if (dropped) log(`[sent-images] 超出上限，丢弃最旧 ${dropped} 张`);
    return dropped;
  }

  return { dir: root, indexFile, store, update, records, removeEntry, prune };
}
