// 自主性（L2）：今日自由行动预算 / 它自己的待办目标 / 最近的自主行动日志。
//
// 只读为主：预算和日志不可改（改了就等于变相发预算），目标可以人工补一条或划掉。
export const id = 'autonomy';
export const title = '自主性';
export const desc = '它自己的目标、每天的自由行动预算、做过什么（L2）';
export const icon = '🧭';
export const group = '运行';
export const order = 3;

import { api } from '../core/api.js';
import { $, esc, setMsg, toast, fmtClock, delegate } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

const fmtTime = (t) => { try { return fmtClock(new Date(Number(t))); } catch { return '-'; } };

export async function mount(root) {
  const view = await mountFragment(root, 'autonomy');

  const render = (data) => {
    const b = data.budget || { used: 0, limit: 0, left: 0, day: '' };
    const pct = b.limit ? Math.round((b.used / b.limit) * 100) : 0;
    const bar = $('#auBudget', view);
    if (bar) {
      bar.innerHTML = `<div class="au-bar"><div class="au-bar-fill" style="width:${Math.min(100, pct)}%"></div></div>`
        + `<div class="meta">今日 ${b.used} / ${b.limit} 次（剩 ${b.left}）${b.day ? ' · ' + esc(b.day) : ''}</div>`;
    }
    const goals = $('#auGoals', view);
    if (goals) {
      const list = data.goals || [];
      goals.innerHTML = list.length ? '' : '<div class="meta">（没有未完成的目标）</div>';
      for (const g of list) {
        const row = document.createElement('div');
        row.className = 'au-goal';
        row.innerHTML = `<span>${esc(g.text)}</span><span class="meta">${fmtTime(g.createdAt)}</span>`
          + `<button class="small" type="button" data-au-done="${esc(g.id)}">完成</button>`;
        goals.append(row);
      }
    }
    const log = $('#auLog', view);
    if (log) {
      const rows = data.log || [];
      log.innerHTML = rows.length
        ? `<table><tr><th>时间</th><th>类型</th><th>做了什么</th></tr>${rows.map((l) => `<tr><td class="meta">${esc(fmtTime(l.t))}</td><td class="meta">${esc(l.kind || '')}</td><td>${esc(l.what || '')}</td></tr>`).join('')}</table>`
        : '<div class="meta">（还没有自主行动记录）</div>';
    }
  };

  const load = async () => {
    const r = await api('/api/socialV2/autonomy', 'GET').catch(() => null);
    if (!r || !r.ok) { setMsg($('#auMsg', view), '❌ 加载失败'); return; }
    setMsg($('#auMsg', view), '');
    render(r);
  };

  delegate(view, 'click', '#auAdd', async () => {
    const text = $('#auText', view).value.trim();
    if (!text) { toast('先写目标内容', 'err'); return; }
    const r = await api('/api/socialV2/autonomy/goal-add', 'POST', { text, source: 'owner' }).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { toast('❌ ' + ((r && r.error) || '失败'), 'err'); return; }
    $('#auText', view).value = '';
    toast('已加进它的目标', 'ok');
    await load();
  });
  delegate(view, 'click', '[data-au-done]', async (ev, btn) => {
    const r = await api('/api/socialV2/autonomy/goal-done', 'POST', { id: btn.dataset.auDone }).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { toast('❌ ' + ((r && r.error) || '失败'), 'err'); return; }
    await load();
  });

  await load();
  const timer = setInterval(load, 30000);
  return () => clearInterval(timer);
}
