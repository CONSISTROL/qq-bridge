// 记忆库（统一）：所有"AI 记住的东西"都在一个 SQLite 里，一个页面查/改/删。
// 取代原来的「黑话 / 向量检索」「群知识库」「AI 记忆」三个页面。
export const id = 'memorydb';
export const title = '记忆库';
export const desc = '黑话 / 知识库 / 档案 / 成员备注 / 话题 / 想法 / 印象，全部在 state/memory.db';
export const icon = 'memory';
export const group = '记忆与素材';
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

  // ── 记忆笔记（MEMORY.md）：读 / 存 ──────────────────────────────
  const docBox = $('#mdDocText', view);
  const docMeta = $('#mdDocMeta', view);
  const loadDoc = async () => {
    if (!docBox) return;
    docMeta && (docMeta.textContent = '加载中…');
    const r = await api('/api/memory/doc').catch(() => null);
    if (!r || r.ok === false) { docMeta && (docMeta.textContent = '读取失败'); return; }
    docBox.value = r.content || '';
    docMeta && (docMeta.textContent = `${(r.content || '').length} 字 · 修改后点保存`);
  };
  const saveDoc = async () => {
    if (!docBox) return;
    docMeta && (docMeta.textContent = '保存中…');
    const r = await api('/api/memory/doc', 'POST', { content: docBox.value }).catch(() => null);
    if (r && r.ok) { docMeta && (docMeta.textContent = `已保存 · ${(docBox.value || '').length} 字`); toast?.('记忆笔记已保存'); }
    else { docMeta && (docMeta.textContent = '保存失败：' + (r?.error || '未知原因')); }
  };
  // ── 向量记忆（Qwen）：状态 / 重建 / 试检索 ──────────────────
  const mvMeta = $('#mvMeta', view);
  const mvHits = $('#mvHits', view);
  const loadVectorStatus = async () => {
    const r = await api('/api/memory/vector/status').catch(() => null);
    if (!r) { mvMeta && (mvMeta.textContent = '读取失败'); return; }
    const when = r.builtAt ? new Date(Number(r.builtAt)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未构建';
    mvMeta && (mvMeta.textContent = `${r.items || 0} 条 · ${r.dim || 0} 维 · ${r.model || '—'} · ${when}`
      + (r.keyConfigured ? '' : ' · ⚠ 未配置 DashScope key'));
  };
  const mvRun = async () => {
    const q = $('#mvQuery', view)?.value.trim() || '';
    if (!q) { toast?.('先写一句'); return; }
    mvHits && (mvHits.innerHTML = '<div class="meta">检索中…</div>');
    const r = await api('/api/memory/vector/query', 'POST', { q, limit: 5 }).catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) { mvHits && (mvHits.innerHTML = `<div class="meta">失败：${esc((r && r.error) || '未知')}</div>`); return; }
    const hits = r.hits || [];
    mvHits.innerHTML = hits.length
      ? hits.map((h) => `<div class="sim-line"><b>${Number(h.score || 0).toFixed(3)}</b>`
        + (h.bm25 ? ` <span class="tag">bm25 ${Number(h.bm25).toFixed(1)}</span>` : '')
        + ` <span class="meta">${esc(new Date(Number(h.from) || Date.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }))} · ${esc(h.key)}</span>`
        + `<div class="meta" style="white-space:pre-wrap">${esc(String(h.text || '').slice(0, 300))}</div></div>`).join('')
      : '<div class="meta">没有命中</div>';
    mvMeta && (mvMeta.textContent = `候选 ${r.candidates || 0} · ${r.reranked ? '已重排' : '仅向量排序'}${r.rewritten ? ' · 改写：' + r.rewritten : ''}`);
  };
  $('#mvReload', view)?.addEventListener('click', loadVectorStatus);
  $('#mvRun', view)?.addEventListener('click', mvRun);
  $('#mvQuery', view)?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') mvRun(); });
  $('#mvRebuild', view)?.addEventListener('click', async () => {
    mvMeta && (mvMeta.textContent = '重建中（约 15 秒）…');
    const r = await api('/api/memory/vector/rebuild', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    if (r && r.ok) { toast?.(`重建完成：${r.items} 条`); await loadVectorStatus(); }
    else { mvMeta && (mvMeta.textContent = '重建失败：' + ((r && r.error) || '未知')); }
  });
  void loadVectorStatus();

  // ── 它现在会想到什么：两路（常驻笔记 / 检索命中）────────────────
  const simRun = async () => {
    const key = $('#simKey', view)?.value.trim() || '';
    const q = $('#simQuery', view)?.value.trim() || '';
    const meta = $('#simMeta', view);
    if (!q) { meta && (meta.textContent = '先写一句话'); return; }
    meta && (meta.textContent = '模拟中…');
    const [hitRes, docRes] = await Promise.all([
      api('/api/memory/vector/query', 'POST', { q, limit: 5, key }).catch(() => null),
      api('/api/memory/doc').catch(() => null)
    ]);
    // ① 常驻笔记（全文注入，这里只挑相关行给人看）
    const docText = docRes?.content || '';
    const lines = docText.split('\n').filter((l) => l.trim().startsWith('- '));
    const hitLines = lines.filter((l) => q.split(/\s+/).some((w) => w.length >= 2 && l.includes(w)));
    const noteLines = (hitLines.length ? hitLines : lines).slice(0, 10);
    $('#simNotes', view).innerHTML = noteLines.length
      ? noteLines.map((l) => `<div class="sim-line">${esc(l)}</div>`).join('')
      : '<div class="meta">（笔记里还没有条目）</div>';
    // ② 检索命中（原文块 + 条目，同一个索引）
    const hits = hitRes?.hits || [];
    $('#simHits', view).innerHTML = hits.length
      ? hits.map((h) => `<div class="sim-line"><b>${Number(h.score || 0).toFixed(3)}</b> `
        + `<span class="tag">${esc(h.kind || (h.level === 'message' ? '原话' : '原文'))}</span> `
        + `<span class="meta">${esc(h.key)}</span>`
        + `<div class="meta" style="white-space:pre-wrap">${esc(String(h.text || '').slice(0, 260))}</div></div>`).join('')
      : '<div class="meta">（没有命中）</div>';
    meta && (meta.textContent = `常驻笔记 ${noteLines.length} 行 · 检索命中 ${hits.length} 条`
      + (hitRes ? `（候选 ${hitRes.candidates || 0} · ${hitRes.reranked ? '已重排' : '仅向量'}）` : '（检索失败）'));
  };
  $('#simRun', view)?.addEventListener('click', simRun);
  $('#simQuery', view)?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') simRun(); });




  await loadDoc();
  $('#mdDocReload', view)?.addEventListener('click', loadDoc);
  $('#mdDocSave', view)?.addEventListener('click', saveDoc);


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
    if (!state.items.length) { box.innerHTML = '<div class="empty">还没有条目<br><b>用上方输入框添加</b><br>或等 AI 自主沉淀。</div>'; return; }
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
