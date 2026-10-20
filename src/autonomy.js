// 自主性（L2）：自己的目标 + 每日自由行动预算 + 行动日志。
//
// 为什么要"预算"：给它"想做什么就做什么"的能力，如果没有配额，它会把"有作为"当成刷屏理由。
// 设计：
//   · self-goals：它自己的待办（从聊天里长出来，也可以自己划掉），存 state/self-goals.json
//   · 预算：每天 N 次"自由行动"（说话不算，算的是发动态/刷B站/学东西这类对外可见的动作），
//     存 state/autonomy-budget.json，跨天自动重置
//   · 日志：每次自由行动记一条 state/autonomy-log.jsonl，控制台可查、可回滚
//   · "什么都不做"永远是合法选项
import fs from 'node:fs';
import path from 'node:path';

const GOALS = 'self-goals.json';
const BUDGET = 'autonomy-budget.json';
const LOG = 'autonomy-log.jsonl';

const dayKey = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地时区）
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

export function listGoals({ stateDir }) {
  const file = path.join(stateDir, GOALS);
  const data = readJson(file, { goals: [] });
  const goals = Array.isArray(data.goals) ? data.goals : [];
  return goals.filter((g) => !g.doneAt);
}

export function addGoal({ stateDir, text, source = 'ai', now = Date.now() }) {
  const file = path.join(stateDir, GOALS);
  const data = readJson(file, { goals: [] });
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, error: '目标不能为空' };
  const goals = Array.isArray(data.goals) ? data.goals : [];
  if (goals.filter((g) => !g.doneAt).length >= 30) return { ok: false, error: '未完成目标已满 30 条，先完成或删掉一些' };
  const goal = { id: `g${now.toString(36)}`, text: body.slice(0, 300), source: String(source).slice(0, 20), createdAt: now };
  goals.push(goal);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ goals }, null, 2) + '\n');
  return { ok: true, goal };
}

export function completeGoal({ stateDir, id, now = Date.now() }) {
  const file = path.join(stateDir, GOALS);
  const data = readJson(file, { goals: [] });
  const goals = Array.isArray(data.goals) ? data.goals : [];
  const g = goals.find((x) => x.id === String(id));
  if (!g) return { ok: false, error: '没有这个目标' };
  g.doneAt = now;
  fs.writeFileSync(file, JSON.stringify({ goals }, null, 2) + '\n');
  return { ok: true, goal: g };
}

/** 今日预算状态。 */
export function budgetStatus({ stateDir, limit = 5, now = Date.now() } = {}) {
  const file = path.join(stateDir, BUDGET);
  const data = readJson(file, {});
  const day = dayKey(now);
  const used = data.day === day ? Number(data.used) || 0 : 0;
  return { day, used, limit: Math.max(0, Number(limit) || 0), left: Math.max(0, (Number(limit) || 0) - used) };
}

/** 花一次预算（返回是否成功；超预算就拒绝）。 */
export function spendBudget({ stateDir, limit = 5, what = '', now = Date.now() } = {}) {
  const st = budgetStatus({ stateDir, limit, now });
  if (st.left <= 0) return { ok: false, error: `今天的自由行动预算用完了（${st.used}/${st.limit}），只能聊天`, ...st };
  const used = st.used + 1;
  fs.writeFileSync(path.join(stateDir, BUDGET), JSON.stringify({ day: st.day, used }, null, 2) + '\n');
  logAction({ stateDir, kind: 'action', what, now });
  return { ok: true, day: st.day, used, limit: st.limit, left: st.limit - used };
}

export function logAction({ stateDir, kind = 'action', what = '', extra = {}, now = Date.now() }) {
  try {
    fs.appendFileSync(path.join(stateDir, LOG), JSON.stringify({ t: now, kind, what: String(what).slice(0, 200), ...extra }) + '\n');
    return { ok: true };
  } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
}

export function recentLog({ stateDir, limit = 50 }) {
  try {
    const lines = fs.readFileSync(path.join(stateDir, LOG), 'utf8').trim().split('\n');
    return lines.slice(-Math.max(1, Math.min(500, limit))).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}
