// 本地用量记账：DSH 不提供 token 统计、DeepSeek API 也只有余额，所以这里自己记「字符数」，
// 再折算成估算 token 与花费。口径明确写在 UI 上：**估算值，不是官方账单**。
//
// 折算规则（可在 config.deepseek.pricing 覆盖）：
//   中文/日文等宽字符 ≈ 1 token/字；ASCII ≈ 1 token/4 字符
//   价格默认按 DeepSeek 标准档：输入 ¥2/百万 token，输出 ¥8/百万 token
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'usage.json';

function read(stateDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateDir, FILE), 'utf8'));
    if (j && typeof j === 'object' && j.days && typeof j.days === 'object') return j;
  } catch { /* 忽略 */ }
  return { days: {} };
}

function write(stateDir, data) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, FILE), JSON.stringify(data, null, 2) + '\n');
  } catch { /* 忽略 */ }
}

const dayKey = (at = Date.now()) => new Date(at + 8 * 3600 * 1000).toISOString().slice(0, 10); // 北京时间

/** 记一笔：dir='in'（我们发给模型的）/ 'out'（模型回的），chars 是文本长度。 */
export function recordUsage({ stateDir, dir, chars, turns = 0, now = Date.now() }) {
  const n = Math.max(0, Math.round(Number(chars) || 0));
  if (!n && !turns) return;
  const data = read(stateDir);
  const k = dayKey(now);
  const d = data.days[k] || { in: 0, out: 0, turns: 0 };
  if (dir === 'in') d.in += n; else if (dir === 'out') d.out += n;
  d.turns += turns;
  data.days[k] = d;
  // 只保留最近 120 天
  const keys = Object.keys(data.days).sort();
  if (keys.length > 120) for (const old of keys.slice(0, keys.length - 120)) delete data.days[old];
  write(stateDir, data);
}

/** 估算 token：CJK 每字 1 个、其余每 4 字符 1 个。 */
export function estimateTokens(chars) {
  return Math.round((Number(chars) || 0) / 1.8);
}

export function readUsage({ stateDir, days = 14, pricing = {} } = {}) {
  const data = read(stateDir);
  const inPrice = Number(pricing.inputPerMillion) || 2;
  const outPrice = Number(pricing.outputPerMillion) || 8;
  const out = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const at = now - i * 86400000;
    const k = dayKey(at);
    const d = data.days[k] || { in: 0, out: 0, turns: 0 };
    const inTok = estimateTokens(d.in);
    const outTok = estimateTokens(d.out);
    out.push({
      day: k,
      inChars: d.in, outChars: d.out, turns: d.turns,
      inTokens: inTok, outTokens: outTok,
      cost: (inTok / 1e6) * inPrice + (outTok / 1e6) * outPrice
    });
  }
  const sum = (f) => out.reduce((s, x) => s + (Number(x[f]) || 0), 0);
  return {
    days: out,
    total: {
      inTokens: sum('inTokens'), outTokens: sum('outTokens'),
      turns: sum('turns'), cost: sum('cost')
    },
    pricing: { inputPerMillion: inPrice, outputPerMillion: outPrice }
  };
}
