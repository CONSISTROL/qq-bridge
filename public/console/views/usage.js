// 用量与余额：余额走 DeepSeek 官方只读接口；每日 token/花费是桥接本地记账的估算值。
import { api } from '../core/api.js';
import { $, esc } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

export const id = 'usage';
export const title = '用量与余额';
export const desc = 'DeepSeek 余额（官方）+ 每日 token / 花费（本地估算）';
export const icon = 'capabilities';
export const group = '系统';
export const order = 3;

const money = (n) => '¥' + (Number(n) || 0).toFixed(2);
const k = (n) => (Number(n) >= 1000 ? (Number(n) / 1000).toFixed(1) + 'k' : String(Math.round(Number(n) || 0)));

function renderChart(view, days) {
  const box = $('#uChart', view);
  if (!box) return;
  const max = Math.max(1, ...days.map((d) => d.inTokens + d.outTokens));
  box.innerHTML = days.map((d) => {
    const inH = Math.round((d.inTokens / max) * 100);
    const outH = Math.round((d.outTokens / max) * 100);
    const label = d.day.slice(5);
    return `<div class="usage-bar" title="${label} 输入 ${d.inTokens} / 输出 ${d.outTokens} tokens ≈ ${money(d.cost)}">
      <div class="usage-stack">
        <div class="usage-seg out" style="height:${outH}%"></div>
        <div class="usage-seg in" style="height:${inH}%"></div>
      </div>
      <span class="usage-day">${esc(label)}</span>
    </div>`;
  }).join('');
  const tot = days.reduce((a, d) => ({
    inTokens: a.inTokens + d.inTokens, outTokens: a.outTokens + d.outTokens,
    turns: a.turns + d.turns, cost: a.cost + d.cost
  }), { inTokens: 0, outTokens: 0, turns: 0, cost: 0 });
  const t = $('#uTotals', view);
  if (t) {
    t.innerHTML = `合计：输入 <b>${k(tot.inTokens)}</b> · 输出 <b>${k(tot.outTokens)}</b> tokens ·`
      + ` <b>${tot.turns}</b> 轮 · 约 <b>${money(tot.cost)}</b>`;
  }
}

async function load(view) {
  const days = Number($('#uDays', view)?.value || 14);
  const r = await api(`/api/usage/stats?days=${days}`).catch(() => null);
  const meta = $('#uBalMeta', view);
  if (!r || r.ok === false) {
    if (meta) meta.textContent = '读取失败';
    return;
  }
  const b = r.balance;
  if (b) {
    $('#uTotal', view).textContent = money(b.total);
    $('#uToppedUp', view).textContent = money(b.toppedUp);
    $('#uGranted', view).textContent = money(b.granted);
    if (meta) meta.textContent = b.available ? '可用 ✅' : '不可用 ⚠️';
  } else if (meta) {
    meta.textContent = '未配置 key / 查询失败';
  }
  renderChart(view, r.days || []);
}

export async function mount(root) {
  const view = await mountFragment(root, 'usage');
  await load(view);
  $('#uRefresh', view)?.addEventListener('click', () => load(view));
  $('#uDays', view)?.addEventListener('change', () => load(view));
}
