// 「用 ai 的声音唱」：B站音频 → 分离人声（demucs）→ RVC 换成 aiyi 音色 → 16k 单声道 wav
//
// 限制说明（实测 tzd = GTX1650 4GB）：
// · demucs htdemucs 分离 30 秒音频约 2.5 分钟（GPU/CPU 差不多，模型本身重）；
// · RVC 按 10 秒分块跑（整段会 OOM），3 块约 20 秒；
// · 所以一首 30 秒的"唱"大约 3 分钟，结果按音频哈希缓存，同一段不重复跑。
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
  child.stdout.on('data', (d) => { out += String(d).slice(0, 2000); });
  child.stderr.on('data', (d) => { err += String(d).slice(0, 2000); });
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve({ out, err });
    else reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${(err || out).slice(-300)}`));
  });
});

const hashOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);

/** demucs 分离人声（带缓存）。 */
async function separateVocals({ wavPath, cacheDir, hash }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const vocalsOut = path.join(cacheDir, `${hash}-vocals.wav`);
  if (fs.existsSync(vocalsOut) && fs.statSync(vocalsOut).size > 1024) return vocalsOut;
  const outDir = path.join(cacheDir, `${hash}-demucs`);
  // GPU 只有 4GB 且共享，demucs 上 GPU 会 OOM；CPU 速度差不多（模型本身重），所以固定走 CPU
  await run(RVC_PY, ['-m', 'demucs', '--two-stems=vocals', '-n', 'htdemucs', '-d', 'cpu', '-j', '2', '--segment', '7', '-o', outDir, wavPath],
    // 断网环境：让 demucs 只用本地缓存的模型，别去 HF 拉元数据（会超时 10s×N）
    { timeoutMs: 900000, env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_ENDPOINT: 'https://hf-mirror.com' } });
  const stem = path.join(outDir, 'htdemucs', path.basename(wavPath, '.wav'), 'vocals.wav');
  if (!fs.existsSync(stem)) throw new Error('demucs 没产出 vocals.wav');
  fs.copyFileSync(stem, vocalsOut);
  fs.rmSync(outDir, { recursive: true, force: true });
  return vocalsOut;
}

/** 切成 N 秒小块，逐块 RVC 转换（整段会 OOM），再拼接。 */
async function convertChunks({ srcWav, cacheDir, hash, chunkSec = 10 }) {
  const outFinal = path.join(cacheDir, `${hash}-aiyi.wav`);
  if (fs.existsSync(outFinal) && fs.statSync(outFinal).size > 1024) return outFinal;
  const chunkDir = path.join(cacheDir, `${hash}-chunks`);
  const rvcOut = path.join(cacheDir, `${hash}-rvc`);
  fs.mkdirSync(chunkDir, { recursive: true });
  fs.rmSync(rvcOut, { recursive: true, force: true });
  fs.mkdirSync(rvcOut, { recursive: true });
  // 1) 切块
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', srcWav,
    '-f', 'segment', '-segment_time', String(chunkSec), '-ac', '2', '-ar', '44100',
    path.join(chunkDir, 'c%03d.wav')]);
  // 2) 逐块 RVC（CLI 支持目录输入，内部顺序处理）
  // 4GB 显卡要和 rvc-webui/TTS 共用，CUDA 初始化容易失败；分块小、CPU 也就几十秒，直接走 CPU 最稳
  await run(RVC_PY, ['-m', 'infer.cli', '--model', RVC_MODEL, '--input', chunkDir, '--output', rvcOut,
    '--speaker-id', '0', '--f0-method', 'rmvpe', '--index', RVC_INDEX, '--index-rate', '0.75'],
    { cwd: RVC_DIR, timeoutMs: 900000, env: { CUDA_VISIBLE_DEVICES: '' } });
  const files = fs.readdirSync(rvcOut).filter((f) => f.endsWith('.wav')).sort();
  if (!files.length) throw new Error('RVC 没有产出文件');
  // 3) 拼接 + 转 16k 单声道
  const listFile = path.join(cacheDir, `${hash}-list.txt`);
  fs.writeFileSync(listFile, files.map((f) => `file '${path.join(rvcOut, f)}'`).join('\n'));
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0',
    '-i', listFile, '-ac', '1', '-ar', '16000', outFinal]);
  fs.rmSync(chunkDir, { recursive: true, force: true });
  fs.rmSync(rvcOut, { recursive: true, force: true });
  fs.rmSync(listFile, { force: true });
  return outFinal;
}

/**
 * 主流程：给一段音频 wav，产出 aiyi 音色的"清唱"wav（16k 单声道）。
 * @returns {Promise<{ok:true, path:string, seconds:number}|{ok:false, error:string}>}
 */
export async function singCover({ wavPath, stateDir = './state', chunkSec = 10 } = {}) {
  try {
    if (!fs.existsSync(wavPath)) return { ok: false, error: '源音频不存在' };
    const buf = fs.readFileSync(wavPath);
    const hash = hashOf(buf);
    const cacheDir = path.join(stateDir, 'sing-cache');
    const vocals = await separateVocals({ wavPath, cacheDir, hash });
    const out = await convertChunks({ srcWav: vocals, cacheDir, hash, chunkSec });
    const size = fs.statSync(out).size;
    if (size < 1024) return { ok: false, error: '转换结果是空音频' };
    // 静音检测：RVC 有时会输出全静音（人声分离失败时），别把哑巴音频发出去
    try {
      const chk = await run(RVC_PY, ['-c', `import soundfile as sf,numpy as np;d,sr=sf.read('${out}');print(round(float(np.abs(d).max()),4))`], { timeoutMs: 60000 });
      if (Number(String(chk.out).trim().split('\n').pop()) < 0.01) return { ok: false, error: '转换结果是静音（人声分离失败）' };
    } catch { /* 忽略检测失败 */ }
    return { ok: true, path: out, seconds: Math.round((size - 44) / 32000) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
