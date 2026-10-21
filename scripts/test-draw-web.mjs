// 测「headed + 真人节奏」下 3 次出图触发验证码的概率。
import fs from 'node:fs';
import { generateImageWeb } from '../src/draw-web.js';

const prompts = ['一只戴墨镜的蓝色鲸鱼，像素风，白底', '一只橘猫戴着飞行员护目镜，水彩风', '一个写着鱼群bot的霓虹灯招牌，赛博朋克'];
const rows = [];
for (let i = 0; i < prompts.length; i++) {
  const t = Date.now();
  const r = await generateImageWeb({ stateDir: './state', prompt: prompts[i], timeoutMs: 150000 });
  const sec = Math.round((Date.now() - t) / 1000);
  rows.push({ n: i + 1, ok: r.ok, captcha: !!r.captcha, sec, bytes: r.buffer?.length || 0, err: r.ok ? '' : r.error });
  if (r.ok) fs.writeFileSync(`state/draw-test-${i + 1}.png`, r.buffer);
  console.log(`#${i + 1} ${r.ok ? '✅出图' : (r.captcha ? '🛑验证码' : '❌失败')} ${sec}s${r.ok ? ' ' + r.buffer.length + 'B' : ' ' + r.error}`);
  if (i < prompts.length - 1) { console.log('  等 60 秒节流…'); await new Promise((r2) => setTimeout(r2, 60000)); }
}
console.log('\n汇总:', JSON.stringify(rows));
