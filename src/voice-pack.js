// 语音包：把「某个音色的参考音频」收成一个个包，放在控制台「语料 → 语音包」里管理。
//
// 为什么要有它：现在 TTS 走 edge-tts + RVC(aiyi)，但 aiyi 的模仿不够像；想更像，得先有
// **干净的目标音色参考音频**（B站视频里的片段就是最好的来源）。这里负责：
//   · 建包（名字/说明）→ state/voice-packs/<id>/meta.json
//   · 从 B站视频抽音频加进包（ffmpeg 转 16k 单声道 wav，体积小、RVC/训练都能直接用）
//   · 列表/试听/删除；后续接 RVC 训练或作为变声参考时，直接扫这些目录即可。
import fs from 'node:fs';
import path from 'node:path';

export const VOICE_PACK_DIR = 'voice-packs';
const AUDIO_RE = /\.(wav|mp3|m4a|flac|ogg)$/i;

export function safeId(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pack';
}

export function packDir({ stateDir, id }) {
  return path.join(stateDir, VOICE_PACK_DIR, safeId(id));
}

export function listPacks({ stateDir } = {}) {
  const root = path.join(stateDir, VOICE_PACK_DIR);
  let ids = [];
  try { ids = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  const out = [];
  for (const id of ids) {
    const dir = path.join(root, id);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { /* 没 meta 也能列 */ }
    let clips = [];
    try {
      clips = fs.readdirSync(path.join(dir, 'clips'))
        .filter((n) => AUDIO_RE.test(n))
        .map((n) => {
          const st = fs.statSync(path.join(dir, 'clips', n));
          return { file: n, bytes: st.size, addedAt: Math.round(st.mtimeMs) };
        })
        .sort((a, b) => b.addedAt - a.addedAt);
    } catch { /* 还没有片段 */ }
    out.push({ id, name: meta.name || id, notes: meta.notes || '', engine: meta.engine || '', createdAt: meta.createdAt || 0, clips, bytes: clips.reduce((n, c) => n + c.bytes, 0) });
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

export function createPack({ stateDir, name, id, notes = '', engine = '', now = Date.now() } = {}) {
  const pid = safeId(id || name);
  const dir = packDir({ stateDir, id: pid });
  try {
    fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });
    const metaFile = path.join(dir, 'meta.json');
    if (fs.existsSync(metaFile)) return { ok: false, error: '同名语音包已存在' };
    fs.writeFileSync(metaFile, JSON.stringify({ name: String(name || pid).slice(0, 60), notes: String(notes).slice(0, 500), engine: String(engine).slice(0, 40), createdAt: now }, null, 2) + '\n');
    return { ok: true, id: pid, dir };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 保存一段音频进包（buffer 由调用方从 B站/上传拿到；文件名带时间戳）。 */
export function addClip({ stateDir, id, buffer, ext = 'wav', label = '', now = Date.now() } = {}) {
  if (!buffer || !buffer.length) return { ok: false, error: '音频为空' };
  const dir = path.join(packDir({ stateDir, id }), 'clips');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const safeLabel = String(label || '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 30);
    const file = `${now}-${safeLabel || 'clip'}.${String(ext).replace(/^\./, '')}`;
    fs.writeFileSync(path.join(dir, file), buffer);
    return { ok: true, file, bytes: buffer.length };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

export function removeClip({ stateDir, id, file } = {}) {
  const name = String(file ?? '');
  if (!AUDIO_RE.test(name) || name.includes('/') || name.includes('..')) return { ok: false, error: '文件名不合法' };
  try { fs.unlinkSync(path.join(packDir({ stateDir, id }), 'clips', name)); return { ok: true }; }
  catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
}

export function clipPath({ stateDir, id, file } = {}) {
  const name = String(file ?? '');
  if (!AUDIO_RE.test(name) || name.includes('/') || name.includes('..')) return null;
  return path.join(packDir({ stateDir, id }), 'clips', name);
}

export function removePack({ stateDir, id } = {}) {
  try { fs.rmSync(packDir({ stateDir, id }), { recursive: true, force: true }); return { ok: true }; }
  catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
}
