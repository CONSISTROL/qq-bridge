// 记忆库（统一）：所有"AI 记住的东西"都在一个 SQLite 里，一个页面查/改/删。
// 取代原来的「黑话 / 向量检索」「群知识库」「AI 记忆」三个页面。
export const id = 'memorydb';
export const title = '记忆库';
export const desc = '黑话 / 知识库 / 档案 / 成员备注 / 话题 / 想法 / 印象，全部在 state/memory.db';
export const icon = 'memory';
export const group = '语料';
export const order = 1;

import { api } from '../core/api.js';
import { $, esc, setMsg, toast, confirmDanger, delegate, debounce, fmtClock } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

const KIND_CLASS = { slang: 'b', knowledge: 'g', fact: 'y', remark: 'r', topic: 'b', thought: '', impression: 'y' };

const KINDS = [
  ['', '全部'],
  ['slang', '黑话'],
  ['knowledge', '知识库'],
  ['fact', '档案'],
  ['remark', '成员备注'],
  ['topic', '话题'],
  ['thought', '想法'],
  ['impression', '印象']
];

export async function mount(root) {
  const view = await mountFragment(root, 'memorydb');
  let state = { kind: '', q: '', items: [], counts: {} };

  const renderTabs = () => {
    const box = $('#mdTabs', view);
    if (!box) return;
    box.textContent = '';
    for (const [k, label] of KINDS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'album-tab' + (state.kind === k ? ' active' : '');
      btn.textContent = k ? `${label} ${state.counts[k] || 0}` : `全部 ${Object.values(state.counts).reduce((a, b) => a + b, 0)}`;
      btn.dataset.kind = k;
      box.append(btn);
    }
  };

  const render = () => {
    const box = $('#mdList', view);
    if (!box) return;
    if (!state.items.length) { box.innerHTML = '<div class="empty">还没有条目<br><b>用上方输入框添加</b>，或等 AI 自主沉淀。</div>'; return; }
    box.innerHTML = '';
    for (const it of state.items) {
      const row = document.createElement('div');
      row.className = 'md-item';
      const time = it.updated || it.at ? fmtClock(new Date(Number(it.updated || it.at))) : '';
      row.innerHTML = `<div class="md-head"><span class="pill ${KIND_CLASS[it.kind] || ''}">${esc(it.kind)}</span> <b>${esc(String(it.text).slice(0, 80))}</b> <span class="meta">${esc(it.scope || '')} ${esc(time)}</span></div>`
        + (it.answer ? `<div class="md-answer">${esc(String(it.answer).slice(0, 300))}</div>` : '')
        + `<div class="row tight mt-6"><button class="small" type="button" data-md-edit="${esc(it.id)}">改</button><button class="small danger-ghost" type="button" data-md-del="${esc(it.id)}">删</button></div>`;
      box.append(row);
    }
  };

  const load = async () => {
    const params = new URLSearchParams({ limit: '300' });
    if (state.kind) params.set('kind', state.kind);
    if (state.q) params.set('q', state.q);
    const r = await api(`api/memdb?${params.toString()}`, 'GET').catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { setMsg($('#mdMsg', view), '❌ ' + ((r && r.error) || '加载失败')); return; }
    state.items = r.items || [];
    state.counts = r.counts || {};
    renderTabs();
    render();
  };

  delegate(view, 'click', '[data-kind]', (ev, btn) => { state.kind = btn.dataset.kind; load(); });
  delegate(view, 'input', '#mdSearch', debounce((ev) => { state.q = ev.target.value.trim(); load(); }, 350));
  delegate(view, 'click', '[data-md-del]', async (ev, btn) => {
    if (!confirmDanger('删掉这条记忆？')) return;
    const r = await api('api/memdb/delete', 'POST', { id: btn.dataset.mdDel }).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { toast('❌ 删除失败', 'err'); return; }
    await load();
  });
  delegate(view, 'click', '[data-md-edit]', async (ev, btn) => {
    const it = state.items.find((x) => x.id === btn.dataset.mdEdit);
    if (!it) return;
    const text = prompt('内容（text）：', it.text);
    if (text === null) return;
    const answer = prompt('解释/答案（answer，可空）：', it.answer || '');
    if (answer === null) return;
    const r = await api('api/memdb/update', 'POST', { id: it.id, kind: it.kind, scope: it.scope, text, answer }).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { toast('❌ 保存失败', 'err'); return; }
    await load();
  });
  delegate(view, 'click', '#mdAdd', async () => {
    const kind = state.kind || 'fact';
    const text = $('#mdNewText', view).value.trim();
    if (!text) { toast('先写内容', 'err'); return; }
    const r = await api('api/memdb/add', 'POST', { kind, text, scope: $('#mdNewScope', view).value.trim() || 'all' }).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { toast('❌ ' + ((r && r.error) || '失败'), 'err'); return; }
    $('#mdNewText', view).value = '';
    await load();
  });

  await load();
  return () => {};
}
