// 自主升级（Self-upgrade）：从对话里发现"我缺什么/我总答不好什么"，自己记下来并升级。
//
// 为什么要分级：
//   · prompt-hint（提示词补充）：低风险，立即生效（比如"群友老问价格，我应该先说不确定再查"）
//   · skill（技能/插件）：要写 manifest、可能调新接口，必须人工批准（沿用 AI 插件待批准流程）
//   · tune（参数微调，如表情冷却、冒泡间隔）：中风险，记成建议，管理员一键应用
// 所有升级都进 state/self-upgrades.json，带来源对话、理由、状态，可审计可回滚。
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'self-upgrades.json';
const read = (stateDir) => { try { const j = JSON.parse(fs.readFileSync(path.join(stateDir, FILE), 'utf8')); return Array.isArray(j?.items) ? j : { items: [] }; } catch { return { items: [] }; } };
const write = (stateDir, data) => { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, FILE), JSON.stringify(data, null, 2) + '\n'); };

export function listUpgrades({ stateDir, status = '', limit = 50 } = {}) {
  const { items } = read(stateDir);
  return items
    .filter((x) => !status || x.status === status)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, Math.max(1, Math.min(200, limit)));
}

/** 现在生效的提示词补充（最多取最近 12 条，总长 ≤ 1500 字，避免提示词失控）。 */
export function activePromptHints({ stateDir }) {
  const hits = listUpgrades({ stateDir, status: 'applied', limit: 50 }).filter((x) => x.kind === 'prompt-hint');
  const out = [];
  let total = 0;
  for (const h of hits) {
    const t = String(h.content || '').slice(0, 200);
    if (total + t.length > 1500 || out.length >= 12) break;
    out.push(t); total += t.length;
  }
  return out;
}

export function proposeUpgrade({ stateDir, kind = 'prompt-hint', content = '', reason = '', key = '', now = Date.now() } = {}) {
  const body = String(content || '').trim();
  if (!body) return { ok: false, error: 'content 不能为空' };
  const k = ['prompt-hint', 'skill', 'tune'].includes(kind) ? kind : 'prompt-hint';
  const data = read(stateDir);
  // 去重：同 kind 且内容高度重合就不再记
  if (data.items.some((x) => x.kind === k && x.status !== 'rejected' && String(x.content).slice(0, 40) === body.slice(0, 40))) {
    return { ok: false, error: '这条升级已经有了' };
  }
  const item = {
    id: `u${now.toString(36)}`,
    kind: k,
    content: body.slice(0, 800),
    reason: String(reason || '').slice(0, 300),
    key: String(key || '').slice(0, 40),
    status: k === 'prompt-hint' ? 'applied' : 'pending', // 提示词补充立即生效；技能/参数等人工批准
    at: now
  };
  data.items.push(item);
  if (data.items.length > 300) data.items.splice(0, data.items.length - 300);
  write(stateDir, data);
  return { ok: true, item };
}

export function decideUpgrade({ stateDir, id, approve = true, now = Date.now() } = {}) {
  const data = read(stateDir);
  const it = data.items.find((x) => x.id === String(id));
  if (!it) return { ok: false, error: '没有这条升级' };
  it.status = approve ? 'applied' : 'rejected';
  it.decidedAt = now;
  write(stateDir, data);
  return { ok: true, item: it };
}
