// 从 B站视频取音频，并按片长切成多段（"唱歌"用：放原唱/切片发语音条）。
//
// 复用思路：pagelist → cid → playurl(fnval=16) → dash.audio.baseUrl → 下载 →
// ffmpeg 转 16k 单声道 wav → -f segment 切段。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const BILI_HEADERS = { 'user-agent': UA, referer: 'https://www.bilibili.com' };

const run = (cmd, args, timeoutMs = 120000) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } reject(new Error(`${cmd} 超时`)); }, timeoutMs);
  child.stderr.on('data', (d) => { err += String(d).slice(0, 500); });
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve(true); else reject(new Error(`${cmd} 退出码 ${code}：${err.slice(-200)}`));
  });
});

export function extractBvid(text) {
  const s = String(text ?? '').trim();
  const m = /BV[0-9A-Za-z]{10}/.exec(s);
  return m ? m[0] : '';
}

/** 关键词搜一个视频（取第一条），返回 bvid。 */
export async function searchBiliVideo(keyword, { timeoutMs = 15000 } = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return '';
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(kw)}`;
  const r = await fetch(url, { headers: BILI_HEADERS, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  if (!r || !r.ok) return '';
  const j = await r.json().catch(() => null);
  const list = j?.data?.result || [];
  return String(list[0]?.bvid || '');
}

/** 拿视频标题（发语音前报个名字）。 */
export async function biliVideoTitle(bvid, { timeoutMs = 15000 } = {}) {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    headers: BILI_HEADERS, signal: AbortSignal.timeout(timeoutMs)
  }).catch(() => null);
  if (!r || !r.ok) return '';
  const j = await r.json().catch(() => null);
  return String(j?.data?.title || '');
}

/**
 * 下载并把音频切成若干段 wav（16k 单声道）。
 * @returns {{ok:true, segments:string[], title:string}|{ok:false, error:string}}
 */
export async function biliAudioSegments({ bvid, stateDir = './state', segmentSec = 30, maxSegments = 8, ffmpeg = 'ffmpeg' } = {}) {
  const id = String(bvid || '').trim();
  if (!/^BV[0-9A-Za-z]{10}$/.test(id)) return { ok: false, error: '需要 bvid（形如 BV1xx411c7mD）' };
  try {
    const pg = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${id}`, { headers: BILI_HEADERS, signal: AbortSignal.timeout(15000) })
      .then((r) => r.json()).catch(() => null);
    const cid = pg?.data?.[0]?.cid;
    if (!cid) return { ok: false, error: '拿不到分P信息（视频不存在或被限流）' };
    const pu = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${id}&cid=${cid}&fnval=16`, { headers: BILI_HEADERS, signal: AbortSignal.timeout(15000) })
      .then((r) => r.json()).catch(() => null);
    const auds = (pu?.data?.dash?.audio || []).slice().sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
    if (!auds.length) return { ok: false, error: '这个视频没有音轨' };
    const ab = await fetch(auds[0].baseUrl, { headers: BILI_HEADERS, signal: AbortSignal.timeout(60000) });
    if (!ab.ok) return { ok: false, error: `下载音轨失败（HTTP ${ab.status}）` };
    const raw = Buffer.from(await ab.arrayBuffer());
    fs.mkdirSync(stateDir, { recursive: true });
    const stamp = Date.now();
    const src = path.join(stateDir, `sing-${stamp}.m4a`);
    const outDir = path.join(stateDir, `sing-${stamp}`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(src, raw);
    // 转 16k 单声道并切段
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000',
      '-f', 'segment', '-segment_time', String(Math.max(10, Number(segmentSec) || 30)), '-reset_timestamps', '1',
      path.join(outDir, 'seg-%03d.wav')]);
    const segments = fs.readdirSync(outDir).filter((f) => f.endsWith('.wav')).sort()
      .slice(0, Math.max(1, Number(maxSegments) || 8)).map((f) => path.join(outDir, f));
    fs.unlink(src, () => {});
    if (!segments.length) return { ok: false, error: '切段后没有产物（视频可能没有声音）' };
    return { ok: true, segments, title: await biliVideoTitle(id) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
