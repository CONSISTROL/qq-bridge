// 唱歌/音乐"鉴赏"：把"好不好听"拆成可测量的客观指标，再交给模型解读。
// 模型本身听不到声音，所以这里用信号处理算出事实，不让它瞎评。
//
// 指标：
//  · 音准：与参考人声（原唱）的 F0 逐帧对比，统计偏移的音分中位数/大偏差比例
//  · 沙哑：谐噪比 HNR（越低越粗）、高频能量比例（过低=闷）
//  · 稳定：F0 抖动（相邻帧差）、响度动态
//  · 可懂：ASR 转写与原歌词的字级相似度（可选，调用方给歌词）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PY = '/root/rvc/venv/bin/python';
const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'song-score.py');

function runPy(args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } reject(new Error('评测超时')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d).slice(0, 2000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`评测失败（${code}）：${err.slice(-300)}`));
    });
  });
}

/** 评测一个唱段：candidate 是 AI 唱的人声，reference 是原唱人声（二者同长、同起点）。 */
export async function scoreSinging({ candidate, reference, expectedShift = 0 }) {
  if (!candidate || !fs.existsSync(candidate)) return { ok: false, error: '候选音频不存在' };
  if (!reference || !fs.existsSync(reference)) return { ok: false, error: '参考人声不存在' };
  try {
    const out = await runPy([candidate, reference, String(Number(expectedShift) || 0)]);
    const j = JSON.parse(String(out).trim().split('\n').pop());
    if (!j || j.error) return { ok: false, error: j?.error || '评测无输出' };
    return { ok: true, ...j };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 把客观指标翻译成人话（给模型/群友看的结论，不给"好不好听"的武断评价）。 */
export function summarizeScore(r) {
  if (!r?.ok) return `评测失败：${r?.error || '未知原因'}`;
  const parts = [];
  if (Number.isFinite(r.centsMedianAbs)) {
    const grade = r.centsMedianAbs < 20 ? '很准' : r.centsMedianAbs < 45 ? '基本准' : r.centsMedianAbs < 90 ? '有偏差' : '明显跑调';
    parts.push(`音准：中位偏差 ${Math.round(r.centsMedianAbs)} 音分（${grade}）`);
  }
  if (Number.isFinite(r.offRatio)) parts.push(`大偏差帧 ${Math.round(r.offRatio * 100)}%`);
  if (Number.isFinite(r.breathiness)) {
    const grade = r.breathiness < 0.02 ? '干净' : r.breathiness < 0.06 ? '略气声' : '明显沙哑/气声';
    parts.push(`2-6kHz 平坦度 ${r.breathiness.toFixed(3)}（${grade}）`);
  }
  if (Number.isFinite(r.flatness)) parts.push(`整体平坦度 ${r.flatness.toFixed(3)}`);
  if (Number.isFinite(r.highFreqRatio)) parts.push(`高频占比 ${(r.highFreqRatio * 100).toFixed(1)}%`);
  if (Number.isFinite(r.f0JitterCents)) parts.push(`音高抖动 ${r.f0JitterCents.toFixed(1)} 音分`);
  return parts.join('；');
}
