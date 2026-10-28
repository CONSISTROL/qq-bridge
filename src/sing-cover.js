// 「用 ai 的声音唱」：B站音频 → 分离人声 → 找"唱得最响的那段"（近似副歌）→ RVC 换音色 → 混回伴奏
//
// 实测环境（tzd = GTX1650 4GB，还有 rvc-webui/TTS 共用显存）：
// · demucs htdemucs 分离走 CPU（GPU 会 OOM），--segment 7，30 秒素材约 20 秒；
// · RVC 按 10 秒分块、也走 CPU（CUDA 初始化会和 webui 抢显存），30 秒约 60 秒；
// · 结果按音频哈希缓存，同一段不重复跑。
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
  let out = '', err = '';
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } reject(new Error(`${path.basename(cmd)} 超时`)); }, timeoutMs);
  child.stdout.on('data', (d) => { out += String(d).slice(0, 4000); });
  child.stderr.on('data', (d) => { err += String(d).slice(0, 4000); });
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve({ out, err });
    else reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${(err || out).slice(-400)}`));
  });
});

const hashOf = (buf, extra = '') => crypto.createHash('sha1').update(buf).update(extra).digest('hex').slice(0, 16);

/** 用 python 读 wav 的逐秒 RMS，找"持续唱得最响"的窗口（近似副歌）。 */
async function pickChorusWindow({ vocalsPath, targetSec, searchLimitSec }) {
  const py = `
import soundfile as sf, numpy as np, json, sys
d, sr = sf.read(${JSON.stringify(vocalsPath)})
if d.ndim > 1: d = d.mean(axis=1)
hop = 1600  # 0.1s @16k
frames = np.abs(d).reshape(-1, hop).mean(axis=1) if len(d) >= hop else np.array([0.0])
sr_eff = sr / hop  # frames per second
win = int(round(${targetSec} * sr_eff)); lim = int(round(${searchLimitSec} * sr_eff))
best, best_i = -1, 0
csum = np.concatenate([[0.0], np.cumsum(frames)])
for i in range(0, max(1, min(lim, len(frames)) - win + 1)):
    s = csum[i + win] - csum[i]
    if s > best: best, best_i = s, i
print(json.dumps({"start": best_i / sr_eff, "rms": float(best / max(1, win))}))
`;
  const r = await run(RVC_PY, ['-c', py], { timeoutMs: 120000 });
  const line = String(r.out).trim().split('\n').pop();
  try { return JSON.parse(line); } catch { return { start: 0, rms: 0 }; }
}

/** demucs 分离（带缓存），返回 {vocals, instrumental}。 */
async function separate({ wavPath, cacheDir, hash, searchSec }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const vocalsOut = path.join(cacheDir, `${hash}-vocals.wav`);
  const instOut = path.join(cacheDir, `${hash}-inst.wav`);
  if (fs.existsSync(vocalsOut) && fs.existsSync(instOut)
      && fs.statSync(vocalsOut).size > 1024 && fs.statSync(instOut).size > 1024) {
    return { vocals: vocalsOut, instrumental: instOut };
  }
  const outDir = path.join(cacheDir, `${hash}-demucs`);
  await run(RVC_PY, ['-m', 'demucs', '--two-stems=vocals', '-n', 'htdemucs', '-d', 'cpu', '-j', '2',
    '--segment', '7', '-o', outDir, wavPath],
    { timeoutMs: 900000, env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_ENDPOINT: 'https://hf-mirror.com' } });
  const base = path.join(outDir, 'htdemucs', path.basename(wavPath, '.wav'));
  const v = path.join(base, 'vocals.wav');
  const i = path.join(base, 'no_vocals.wav');
  if (!fs.existsSync(v)) throw new Error('demucs 没产出 vocals.wav');
  fs.copyFileSync(v, vocalsOut);
  if (fs.existsSync(i)) fs.copyFileSync(i, instOut);
  fs.rmSync(outDir, { recursive: true, force: true });
  return { vocals: vocalsOut, instrumental: fs.existsSync(instOut) ? instOut : '' };
}

/** 切块 → RVC（10 秒/块，CPU）→ 拼接。 */
async function convert({ srcWav, cacheDir, hash, chunkSec = 10, indexRate = 0.5, protect = 0.5, pitch = 0 }) {
  const outFinal = path.join(cacheDir, `${hash}-aiyi.wav`);
  if (fs.existsSync(outFinal) && fs.statSync(outFinal).size > 1024) return outFinal;
  const chunkDir = path.join(cacheDir, `${hash}-chunks`);
  const rvcOut = path.join(cacheDir, `${hash}-rvc`);
  fs.rmSync(chunkDir, { recursive: true, force: true });
  fs.rmSync(rvcOut, { recursive: true, force: true });
  fs.mkdirSync(chunkDir, { recursive: true });
  fs.mkdirSync(rvcOut, { recursive: true });
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', srcWav,
    '-f', 'segment', '-segment_time', String(chunkSec), '-ac', '2', '-ar', '44100',
    path.join(chunkDir, 'c%03d.wav')]);
  await run(RVC_PY, ['-m', 'infer.cli', '--model', RVC_MODEL, '--input', chunkDir, '--output', rvcOut,
    '--speaker-id', '0', '--f0-method', 'rmvpe', '--index', RVC_INDEX,
    '--index-rate', String(indexRate), '--protect', String(protect), '--pitch', String(pitch)],
    { cwd: RVC_DIR, timeoutMs: 900000, env: { CUDA_VISIBLE_DEVICES: '' } });
  const files = fs.readdirSync(rvcOut).filter((f) => f.endsWith('.wav')).sort();
  if (!files.length) throw new Error('RVC 没有产出文件');
  const listFile = path.join(cacheDir, `${hash}-list.txt`);
  fs.writeFileSync(listFile, files.map((f) => `file '${path.join(rvcOut, f)}'`).join('\n'));
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0',
    '-i', listFile, '-ac', '1', '-ar', '16000', outFinal]);
  fs.rmSync(chunkDir, { recursive: true, force: true });
  fs.rmSync(rvcOut, { recursive: true, force: true });
  fs.rmSync(listFile, { force: true });
  return outFinal;
}

/** 把"唱"和伴奏混在一起（唱 1.0 / 伴奏 0.45），输出 16k 单声道。 */
async function mixWithInstrumental({ vocalWav, instWav, outWav }) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-i', vocalWav, '-i', instWav,
    '-filter_complex', '[0:a]volume=1.0[v];[1:a]volume=0.45[m];[v][m]amix=inputs=2:duration=first:dropout_transition=0[out]',
    '-map', '[out]', '-ac', '1', '-ar', '16000', outWav]);
  return outWav;
}

/**
 * 主流程。
 * @param {string} wavPath     较长的一段原始音频（建议 ≥ 目标时长×2，用来找副歌）
 * @param {number} targetSec   要唱的时长（默认 30）
 */
export async function singCover({
  wavPath, stateDir = './state', targetSec = 30, searchSec = 90,
  chunkSec = 10, indexRate = 0.5, protect = 0.5, pitch = 0, withInstrumental = true
} = {}) {
  try {
    if (!fs.existsSync(wavPath)) return { ok: false, error: '源音频不存在' };
    const buf = fs.readFileSync(wavPath);
    const tag = `${targetSec}|${indexRate}|${protect}|${pitch}|${withInstrumental ? 'mix' : 'dry'}`;
    const hash = hashOf(buf, tag);
    const cacheDir = path.join(stateDir, 'sing-cache');
    fs.mkdirSync(cacheDir, { recursive: true });

    const { vocals, instrumental } = await separate({ wavPath, cacheDir, hash, searchSec });

    // 找副歌窗口（唱得最响的持续段）
    let start = 0;
    try {
      const picked = await pickChorusWindow({ vocalsPath: vocals, targetSec, searchLimitSec: Math.max(targetSec, searchSec) });
      start = Math.max(0, Number(picked.start) || 0);
    } catch { /* 忽略，从头开始 */ }
    const vocalWin = path.join(cacheDir, `${hash}-vwin.wav`);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-t', String(targetSec),
      '-i', vocals, '-ar', '44100', '-ac', '2', vocalWin]);

    const sung = await convert({ srcWav: vocalWin, cacheDir, hash, chunkSec, indexRate, protect, pitch });
    const size = fs.statSync(sung).size;
    if (size < 1024) return { ok: false, error: '转换结果是空音频' };

    let finalPath = sung;
    if (withInstrumental && instrumental) {
      const instWin = path.join(cacheDir, `${hash}-iwin.wav`);
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-t', String(targetSec),
        '-i', instrumental, '-ar', '16000', '-ac', '1', instWin]);
      finalPath = path.join(cacheDir, `${hash}-mix.wav`);
      await mixWithInstrumental({ vocalWav: sung, instWav: instWin, outWav: finalPath });
      fs.rmSync(instWin, { force: true });
    }

    // 静音检测（别把哑巴音频发出去）
    try {
      const chk = await run(RVC_PY, ['-c', `import soundfile as sf,numpy as np;d,sr=sf.read('${finalPath}');print(round(float(np.abs(d).max()),4))`], { timeoutMs: 60000 });
      const peak = Number(String(chk.out).trim().split('\n').pop());
      if (!(peak > 0.01)) return { ok: false, error: '结果是静音（人声分离或转换失败）' };
    } catch { /* 忽略 */ }

    const sec = Math.round((fs.statSync(finalPath).size - 44) / 32000);
    return { ok: true, path: finalPath, seconds: sec, chorusStart: Math.round(start), withInstrumental: Boolean(withInstrumental && instrumental) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
