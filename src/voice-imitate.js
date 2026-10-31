// 「模仿语气」：把视频里那个人说的话拿过来，只把自己的音色换上去。
//
// 为什么这样才对：TTS 是"自己念稿"，语速/重音/情绪由 TTS 决定，模仿不了别人的语气；
// RVC 只换音色、**保留原声的语调与节奏**。所以"语气模仿"= 取原视频人声 → demucs 分离 →
// RVC(aiyi) 换音色 → 发语音条。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const RVC_DIR = '/root/rvc/RVC';
const RVC_PY = '/root/rvc/venv/bin/python';
const RVC_MODEL = path.join(RVC_DIR, 'assets/weights/aiyi.pth');
const RVC_INDEX = path.join(RVC_DIR, 'logs/aiyi.index');

const run = (cmd, args, { timeoutMs = 600000, cwd, env } = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } reject(new Error(`${path.basename(cmd)} 超时`)); }, timeoutMs);
  child.stderr.on('data', (d) => { err += String(d).slice(0, 1500); });
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve(true);
    else reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${err.slice(-300)}`));
  });
});

const hashOf = (buf, extra = '') => crypto.createHash('sha1').update(buf).update(extra).digest('hex').slice(0, 16);

/**
 * @param {string} wavPath 已裁好的源音频（人说话的那段）
 * @param {number} pitch   移调半音（男声转爱音一般 +12；同性别 0）
 */
export async function imitateVoice({ wavPath, stateDir = './state', pitch = 12, chunkSec = 10 } = {}) {
  try {
    if (!fs.existsSync(wavPath)) return { ok: false, error: '源音频不存在' };
    const buf = fs.readFileSync(wavPath);
    const cacheDir = path.join(stateDir, 'imitate-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const srcHash = hashOf(buf, 'src');
    const vocals = path.join(cacheDir, `${srcHash}-vocals.wav`);

    if (!fs.existsSync(vocals) || fs.statSync(vocals).size < 1024) {
      const outDir = path.join(cacheDir, `${srcHash}-demucs`);
      await run(RVC_PY, ['-m', 'demucs', '--two-stems=vocals', '-n', 'htdemucs', '-d', 'cpu', '-j', '2',
        '--segment', '7', '-o', outDir, wavPath],
        { timeoutMs: 900000, env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
      const stem = path.join(outDir, 'htdemucs', path.basename(wavPath, '.wav'), 'vocals.wav');
      if (!fs.existsSync(stem)) return { ok: false, error: '人声分离失败' };
      fs.copyFileSync(stem, vocals);
      fs.rmSync(outDir, { recursive: true, force: true });
    }

    const tag = hashOf(buf, `p${pitch}`);
    const chunkDir = path.join(cacheDir, `${tag}-chunks`);
    const rvcOut = path.join(cacheDir, `${tag}-rvc`);
    const finalWav = path.join(cacheDir, `${tag}.wav`);
    if (fs.existsSync(finalWav) && fs.statSync(finalWav).size > 1024) return { ok: true, path: finalWav };
    fs.rmSync(chunkDir, { recursive: true, force: true });
    fs.rmSync(rvcOut, { recursive: true, force: true });
    fs.mkdirSync(chunkDir, { recursive: true });
    fs.mkdirSync(rvcOut, { recursive: true });
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', vocals,
      '-f', 'segment', '-segment_time', String(chunkSec), '-ac', '2', '-ar', '44100',
      path.join(chunkDir, 'c%03d.wav')]);
    await run(RVC_PY, ['-m', 'infer.cli', '--model', RVC_MODEL, '--input', chunkDir, '--output', rvcOut,
      '--speaker-id', '0', '--f0-method', 'rmvpe', '--index', RVC_INDEX,
      '--index-rate', '0.75', '--protect', '0.33', '--pitch', String(Number(pitch) || 0), '--rms-mix-rate', '0.25'],
      { cwd: RVC_DIR, timeoutMs: 900000, env: { RVC_CUDA_GRAPH: '0' } });
    const files = fs.readdirSync(rvcOut).filter((f) => f.endsWith('.wav')).sort();
    if (!files.length) return { ok: false, error: 'RVC 没有产出' };
    const listFile = path.join(cacheDir, `${tag}.list`);
    fs.writeFileSync(listFile, files.map((f) => `file '${path.join(rvcOut, f)}'`).join('\n'));
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0',
      '-i', listFile, '-ac', '1', '-ar', '16000', finalWav]);
    fs.rmSync(chunkDir, { recursive: true, force: true });
    fs.rmSync(rvcOut, { recursive: true, force: true });
    fs.rmSync(listFile, { force: true });
    return { ok: true, path: finalWav, seconds: Math.round((fs.statSync(finalWav).size - 44) / 32000) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
