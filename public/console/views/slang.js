// 黑话库（08）+ 本地向量检索 RAG（08b）
import { api } from '../core/api.js';
import { $, $$, esc, toast, setMsg, confirmDanger } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';
import { trackDirty } from '../core/dirty.js';

export const id = 'slang';
export const title = '黑话 / 向量检索';
export const desc = '黑话候选确认、批量研究、黑话参数与本地向量检索调试';
export const icon = '📚';
export const group = '语料';
export const order = 1;

const TAB_INFO = {
  candidate: { list: 'slangCandidateList', search: 'slangSearchCand', limit: 'slangLimitCand', selectAll: 'slangCandidateSelectAll' },
  confirmed: { list: 'slangConfirmedList', search: 'slangSearchConfirmed', limit: 'slangLimitConfirmed', selectAll: 'slangConfirmedSelectAll' },
  rejected: { list: 'slangRejectedList', search: 'slangSearchRejected', limit: 'slangLimitRejected', selectAll: 'slangRejectedSelectAll' }
};

// 开关：拨动即写盘（/api/slang/config 是字段级合并）；其余参数走「保存黑话参数」。
const SLANG_SWITCHES = { slangEnabled: 'enabled', slangAutoResearch: 'autoResearch' };
const SLANG_MANUAL_SELECTOR = [
  '#slangExtractMin', '#slangCooldown', '#slangThresholds',
  '#slangInjectMax', '#slangLearnerPreset', '#slangWorkspaceTitle'
].join(', ');

const state = {
  view: null,
  entries: [],
  selected: new Set(),
  tab: 'candidate',
  modalId: null,
  modalMode: 'confirm'
};

const ragEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── 列表 ─────────────────────────────────────────────────────────────
function statusLabel(status) {
  return { candidate: '候选', confirmed: '已确认', rejected: '已拒绝' }[status] || esc(status);
}
function statusClass(status) {
  return { candidate: 'pill b', confirmed: 'pill g', rejected: 'pill r' }[status] || 'pill';
}
function sourceLabel(e) {
  if (e.source === 'manual') return '手动';
  if (Array.isArray(e.evidence) && e.evidence.some((ev) => ev.sender === 'AI提交')) return 'AI提交';
  return '自动提取';
}
function evidenceHtml(e) {
  return Array.isArray(e.evidence) && e.evidence.length
    ? e.evidence.slice(-2).map((ev) => `<span class="meta">${esc(String(ev.sender || '未知'))}：${esc(String(ev.text || '').slice(0, 30))}</span>`).join('<br>')
    : '<span class="meta">—</span>';
}
function sourcesHtml(e) {
  return Array.isArray(e.sources) && e.sources.length
    ? e.sources.slice(0, 5).map((s) => `<span class="meta">🔗 ${esc(s)}</span>`).join('<br>')
    : '';
}
function searchFields(e) {
  return [e.content, e.meaning, e.usage, e.example, e.risk,
    Array.isArray(e.sources) ? e.sources.join(' ') : '',
    Array.isArray(e.evidence) ? e.evidence.map((x) => x.text || '').join(' ') : ''].join(' ').toLowerCase();
}
function currentMeta() { return TAB_INFO[state.tab]; }
function currentLimit() {
  return Math.max(10, Number($('#' + currentMeta().limit, state.view)?.value) || 100);
}
function currentSearch() {
  return String($('#' + currentMeta().search, state.view)?.value || '').trim().toLowerCase();
}
function filteredFor(status) {
  const list = state.entries.filter((e) => e.status === status);
  const q = currentSearch();
  return q ? list.filter((e) => searchFields(e).includes(q)) : list;
}
function selectedIdsForStatus(status) {
  return [...state.selected].filter((id) => state.entries.some((e) => e.id === id && e.status === status));
}
function setSlangMsg(text, ok = true) {
  setMsg($('#slangMsg', state.view), text, ok);
}

function updateSelectAll(status) {
  const el = $('#' + TAB_INFO[status].selectAll, state.view);
  if (!el) return;
  const filtered = filteredFor(status);
  el.checked = filtered.length > 0 && filtered.every((e) => state.selected.has(e.id));
  el.indeterminate = filtered.some((e) => state.selected.has(e.id)) && !el.checked;
}

function renderPanel() {
  const status = state.tab;
  const box = $('#' + currentMeta().list, state.view);
  if (!box) return;
  const all = state.entries.filter((e) => e.status === status);
  const filtered = filteredFor(status);
  if (!filtered.length) {
    const empty = all.length ? '没有符合条件的词条'
      : status === 'candidate' ? '暂无候选黑话，等 DSH 自动提取、AI 提交或手动添加'
        : status === 'confirmed' ? '暂无已确认黑话' : '暂无已拒绝词条';
    box.innerHTML = `<div class="meta" style="padding:8px">${empty}</div>`;
    updateSelectAll(status);
    return;
  }
  const shown = filtered.slice(0, currentLimit());
  let html = `<div class="meta" style="padding:6px 8px">共 ${filtered.length} 条，显示 ${shown.length} 条（可滚动查找）</div>`;
  html += '<table><tr><th>选择</th><th>词条</th><th>次数</th><th>来源</th><th>含义 / 用法 / 示例</th><th>参考来源</th><th>语境证据</th><th>操作</th></tr>';
  for (const e of shown) {
    const meaning = e.meaning ? esc(e.meaning) : (status === 'candidate' ? '<span class="meta">待研究</span>' : '<span class="meta">无</span>');
    const checked = state.selected.has(e.id) ? ' checked' : '';
    const actions = [];
    if (status === 'candidate') {
      actions.push(`<button class="small" data-slang-confirm="${esc(e.id)}">确认</button>`);
      actions.push(`<button class="small" data-slang-edit="${esc(e.id)}">编辑</button>`);
      actions.push(`<button class="small" data-slang-reject="${esc(e.id)}">拒绝</button>`);
    } else if (status === 'confirmed') {
      actions.push(`<button class="small" data-slang-edit="${esc(e.id)}">编辑</button>`);
    } else {
      actions.push(`<button class="small" data-slang-restore="${esc(e.id)}">恢复候选</button>`);
    }
    actions.push(`<button class="small danger" data-slang-del="${esc(e.id)}">删</button>`);
    html += `<tr>
      <td><input type="checkbox" data-slang-select="${esc(e.id)}"${checked}></td>
      <td><b>${esc(e.content)}</b><br><span class="${statusClass(status)}">${statusLabel(status)}</span></td>
      <td>${esc(e.count)}</td>
      <td>${esc(sourceLabel(e))}</td>
      <td>${meaning}${e.usage ? '<br><span class="meta">用法：' + esc(e.usage) + '</span>' : ''}${e.example ? '<br><span class="meta">例：' + esc(e.example) + '</span>' : ''}${e.risk ? '<br><span class="meta">风险：' + esc(e.risk) + '</span>' : ''}</td>
      <td>${sourcesHtml(e) || '<span class="meta">—</span>'}</td>
      <td>${evidenceHtml(e)}</td>
      <td class="row">${actions.join('')}</td>
    </tr>`;
  }
  box.innerHTML = html + '</table>';
  updateSelectAll(status);
}

async function refreshSlang() {
  const r = await api('/api/slang').catch(() => null);
  if (!r) {
    const box = $('#slangCandidateList', state.view);
    if (box) box.innerHTML = '<span class="meta">加载失败</span>';
    return;
  }
  state.entries = r.entries || [];
  renderPanel();
}

function setTab(tab) {
  state.tab = tab;
  $$('.slang-tab', state.view).forEach((btn) => btn.classList.toggle('active', btn.dataset.slangTab === tab));
  $$('.slang-panel', state.view).forEach((panel) => panel.classList.toggle('active', panel.id === 'slangPanel' + tab[0].toUpperCase() + tab.slice(1)));
  renderPanel();
}

// ── 弹窗 ─────────────────────────────────────────────────────────────
function openModal(id, mode) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  state.modalId = id;
  state.modalMode = mode;
  $('#slangModalTitle', state.view).textContent = mode === 'confirm' ? `确认黑话：${e.content}` : `编辑黑话：${e.content}`;
  $('#slangModalContent', state.view).textContent = mode === 'confirm'
    ? '你可以直接填写含义/用法并转正，也可以先送 DSH 深度联网研究，研究结果回来后在此处删改再确认。'
    : '修改后保存；候选不会转正，已确认仍保持已确认。';
  $('#slangModalMeaning', state.view).value = e.meaning || '';
  $('#slangModalUsage', state.view).value = e.usage || '';
  $('#slangModalExample', state.view).value = e.example || '';
  $('#slangModalRisk', state.view).value = e.risk || '';
  $('#slangModalSources', state.view).value = Array.isArray(e.sources) ? e.sources.join('\n') : '';
  $('#slangModalDirectConfirm', state.view).textContent = mode === 'confirm' ? '直接确认（转正）' : '保存修改';
  $('#slangModalSendResearch', state.view).style.display = mode === 'confirm' && e.status === 'candidate' ? '' : 'none';
  $('#slangModalOverlay', state.view).classList.add('open');
}

function closeModal() {
  $('#slangModalOverlay', state.view)?.classList.remove('open');
  state.modalId = null;
}

function modalPayload() {
  return {
    meaning: $('#slangModalMeaning', state.view).value.trim(),
    usage: $('#slangModalUsage', state.view).value.trim(),
    example: $('#slangModalExample', state.view).value.trim(),
    risk: $('#slangModalRisk', state.view).value.trim(),
    sources: $('#slangModalSources', state.view).value.split(/\n/).map((s) => s.trim()).filter(Boolean)
  };
}

// ── 批量操作 ─────────────────────────────────────────────────────────
async function batchDelete(status, label) {
  const ids = selectedIdsForStatus(status);
  if (!ids.length) { toast(`请先勾选要删除的${label}`, 'err'); return; }
  if (!confirmDanger(`确定删除 ${ids.length} 条${label}？此操作不可恢复！`)) return;
  const r = await api('/api/slang/batch-delete', 'POST', { ids }).catch((e) => ({ ok: false, error: e.message }));
  setSlangMsg(r.ok ? `✅ 已删除 ${r.removedCount} 条${label}` : ('❌ ' + (r.error || '失败')), r.ok);
  if (r.ok) { state.selected.clear(); refreshSlang(); }
}

// ── RAG 面板 ─────────────────────────────────────────────────────────
async function loadRagStatus() {
  const el = $('#ragStatus', state.view);
  const r = await api('/api/slang/rag-status').catch((e) => ({ ok: false, error: e.message }));
  if (!r || !r.ok) { el.textContent = '状态获取失败' + (r?.error ? '：' + r.error : ''); return; }
  const info = r.embedder || {};
  const mem = info.mem ? `常驻 ${info.mem.rssMB}MB / 峰值 ${info.mem.peakMB}MB` : '未启动';
  const st = r.stats || {};
  const avg = st.requests ? (st.totalMs / st.requests).toFixed(1) : '—';
  el.innerHTML = [
    r.enabled ? (r.ready ? '<span class="ok">● 已启用</span>' : '<span class="err">● 已启用但子进程不可用</span>') : '<span class="muted">○ 已关闭</span>',
    `模型 <b>${ragEsc(r.model)}</b>${r.dim ? `（${r.dim} 维）` : ''}`,
    `已索引 <b>${r.indexed}</b>/${r.entries} 条`,
    r.stale ? `<span class="err">待补 ${r.stale} 条</span>` : '待补 0 条',
    r.orphans ? `孤儿 ${r.orphans} 条` : '',
    r.builtAt ? `构建于 ${ragEsc(new Date(r.builtAt).toLocaleString('zh-CN', { hour12: false }))}` : '尚未构建',
    `embedder ${ragEsc(mem)}`,
    st.requests ? `累计编码 ${st.requests} 次（均值 ${avg}ms）` : '',
    r.lastError ? `<span class="err">最近错误：${ragEsc(r.lastError)}</span>` : ''
  ].filter(Boolean).join(' · ');
}

async function ragReindex(force) {
  const msg = $('#ragMsg', state.view);
  setMsg(msg, force ? '强制全量重建中…（会清空后重编码，几十秒）' : '补齐中…', true);
  try {
    const r = await api('/api/slang/rag-rebuild', 'POST', { force });
    if (!r.ok) throw new Error(r.error || '重建失败');
    setMsg(msg, `完成：新编码 ${r.embedded} 条，清理 ${r.orphans} 条，库内 ${r.total} 条，耗时 ${r.ms}ms`, true);
    await loadRagStatus();
  } catch (e) {
    setMsg(msg, `失败：${e.message}`, false);
  }
}

async function ragDebug() {
  const q = $('#ragQuery', state.view).value.trim();
  const key = $('#ragKey', state.view).value.trim();
  const msg = $('#ragMsg', state.view);
  if (!q) { setMsg(msg, '先填一个查询', false); return; }
  setMsg(msg, '检索中…', true);
  try {
    const r = await api('/api/slang/debug-search', 'POST', { query: q, key });
    $('#ragDebugOut', state.view).style.display = '';
    $('#ragBaselineList', state.view).innerHTML = r.baseline.length
      ? r.baseline.map((e) => `<div class="rag-row"><span class="rag-name">${ragEsc(e.content)}</span></div>`).join('')
      : '<div class="meta">（库中无已确认词条）</div>';
    const v = r.vector;
    const box = $('#ragVectorList', state.view);
    if (!v) {
      box.innerHTML = `<div class="meta err">向量检索不可用${r.error ? `：${ragEsc(r.error)}` : ''}</div>`;
    } else {
      const rows = v.picked.map((p) => `<div class="rag-row">
          <span class="rag-score">${p.sem.toFixed(3)}</span>
          <span class="rag-name">${ragEsc(p.content)}</span>
          <span class="rag-why">sem=${p.sem.toFixed(3)} conv=${p.conv} score=${p.score.toFixed(3)}${p.filler ? ' · 补位' : ''}</span>
        </div>`).join('') || '<div class="meta">没有条目达到相关门槛（会退回按频次）</div>';
      const near = v.runnersUp.length
        ? `<div class="meta" style="margin-top:6px">差一点没进（门槛 ${v.minCosine}）：</div>` + v.runnersUp.map((p) =>
          `<div class="rag-row"><span class="rag-score">${p.sem.toFixed(3)}</span><span class="rag-name">${ragEsc(p.content)}</span></div>`).join('')
        : '';
      box.innerHTML = rows + near;
    }
    setMsg(msg, v ? `候选 ${v.eligible} 条达标，选中 ${v.picked.length} 条` : '', true);
  } catch (e) {
    setMsg(msg, `失败：${e.message}`, false);
  }
}

async function ragNearDuplicates() {
  const threshold = $('#ragDupThreshold', state.view).value || 0.6;
  const msg = $('#ragDupMsg', state.view);
  msg.textContent = '计算中…';
  try {
    const r = await api(`/api/slang/near-duplicates?threshold=${encodeURIComponent(threshold)}`);
    const box = $('#ragDupList', state.view);
    box.style.display = '';
    box.innerHTML = r.pairs.length
      ? '<table><thead><tr><th style="width:70px">余弦</th><th>词条 A</th><th>词条 B</th></tr></thead><tbody>'
        + r.pairs.map((p) => `<tr><td>${p.sim.toFixed(3)}</td><td>${ragEsc(p.a.content)}</td><td>${ragEsc(p.b.content)}</td></tr>`).join('')
        + '</tbody></table>'
      : '<div class="meta" style="padding:8px">没有超过该阈值的词条对</div>';
    msg.textContent = `共 ${r.pairs.length} 对`;
  } catch (e) {
    msg.textContent = `失败：${e.message}`;
  }
}

// ── 黑话系统参数 ─────────────────────────────────────────────────────
// view 由调用方传入而不是读 state.view：这个函数在 mount 里是不 await 的，
// 用户可能在请求返回前就切走分区，那时 state.view 已经指向别处（或为空）。
async function loadSlangConfig(view) {
  const r = await api('/api/slang').catch(() => null);
  if (!r) return;
  const c = r.config || {};
  $('#slangEnabled', view).checked = c.enabled !== false;
  $('#slangExtractMin', view).value = c.extractMinMessages ?? 10;
  $('#slangCooldown', view).value = c.extractCooldownMs ?? 300000;
  $('#slangThresholds', view).value = (c.inferenceThresholds || [2, 4, 8]).join(', ');
  $('#slangInjectMax', view).value = c.injectMax ?? 8;
  $('#slangLearnerPreset', view).value = c.learnerPreset || 'qq-chat';
  $('#slangWorkspaceTitle', view).value = c.workspaceTitle || 'QQ 黑话学习';
  $('#slangAutoResearch', view).checked = c.autoResearch !== false;
}

export async function mount(root) {
  const view = await mountFragment(root, 'slang');
  state.view = view;
  // 基线只能在表单填好之后建（见函数末尾），所以这里先声明、稍后赋值；
  // 保存按钮在那之前不可能被点到，用可选链兜底。
  let dirty = null;
  state.selected.clear();
  state.entries = [];

  const num = (id, d) => Number($('#' + id, view).value) || d;

  // 标签页 / 搜索 / 每页条数
  for (const btn of $$('.slang-tab', view)) {
    btn.addEventListener('click', () => setTab(btn.dataset.slangTab));
  }
  for (const info of Object.values(TAB_INFO)) {
    $('#' + info.search, view).addEventListener('input', renderPanel);
    $('#' + info.limit, view).addEventListener('change', renderPanel);
  }
  for (const status of Object.keys(TAB_INFO)) {
    $('#' + TAB_INFO[status].selectAll, view).addEventListener('change', (e) => {
      for (const x of filteredFor(status)) {
        if (e.target.checked) state.selected.add(x.id); else state.selected.delete(x.id);
      }
      renderPanel();
    });
  }

  // 列表里的行内操作（一个委托搞定，旧实现每次重渲染都重新 bind 一遍）
  view.addEventListener('change', (e) => {
    const cb = e.target instanceof Element ? e.target.closest('[data-slang-select]') : null;
    if (!cb) return;
    const id = cb.dataset.slangSelect;
    if (cb.checked) state.selected.add(id); else state.selected.delete(id);
    updateSelectAll(state.tab);
  });
  view.addEventListener('click', async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const hit = (attr) => t.closest(`[${attr}]`);
    const confirmBtn = hit('data-slang-confirm');
    if (confirmBtn) { openModal(confirmBtn.dataset.slangConfirm, 'confirm'); return; }
    const editBtn = hit('data-slang-edit');
    if (editBtn) { openModal(editBtn.dataset.slangEdit, 'edit'); return; }
    const rejectBtn = hit('data-slang-reject');
    if (rejectBtn) {
      const r = await api('/api/slang/' + rejectBtn.dataset.slangReject + '/reject', 'POST', {}).catch((err) => ({ ok: false, error: err.message }));
      setSlangMsg(r.ok ? '✅ 已拒绝' : ('❌ ' + (r.error || '失败')), r.ok);
      refreshSlang();
      return;
    }
    const restoreBtn = hit('data-slang-restore');
    if (restoreBtn) {
      const entry = state.entries.find((x) => x.id === restoreBtn.dataset.slangRestore);
      if (!entry) return;
      const r = await api('/api/slang/' + entry.id, 'PATCH', { status: 'candidate' }).catch((err) => ({ ok: false, error: err.message }));
      setSlangMsg(r.ok ? '✅ 已恢复为候选' : ('❌ ' + (r.error || '失败')), r.ok);
      refreshSlang();
      return;
    }
    const delBtn = hit('data-slang-del');
    if (delBtn) {
      if (!confirmDanger('确定删除该黑话？')) return;
      const r = await api('/api/slang/' + delBtn.dataset.slangDel, 'DELETE', {}).catch((err) => ({ ok: false, error: err.message }));
      setSlangMsg(r.ok ? '✅ 已删除' : ('❌ ' + (r.error || '失败')), r.ok);
      state.selected.delete(delBtn.dataset.slangDel);
      refreshSlang();
    }
  });

  // 批量操作
  $('#slangBatchResearch', view).addEventListener('click', async () => {
    const ids = selectedIdsForStatus('candidate');
    if (!ids.length) { toast('请先勾选要研究的候选词', 'err'); return; }
    const r = await api('/api/slang/research', 'POST', { ids }).catch((e) => ({ ok: false, error: e.message }));
    setSlangMsg(r.ok ? `✅ 已送 ${r.count} 条候选到 DSH 深度联网研究，完成后刷新查看结果` : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) refreshSlang();
  });
  $('#slangBatchConfirm', view).addEventListener('click', async () => {
    const ids = selectedIdsForStatus('candidate');
    if (!ids.length) { toast('请先勾选要确认的候选词', 'err'); return; }
    if (!confirmDanger(`确定批量确认 ${ids.length} 条候选？缺少含义的会被跳过。`)) return;
    const r = await api('/api/slang/batch-confirm', 'POST', { ids }).catch((e) => ({ ok: false, error: e.message }));
    setSlangMsg(r.ok ? `✅ 已确认 ${r.confirmedCount} 条，跳过 ${r.skippedCount} 条` : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) { state.selected.clear(); refreshSlang(); }
  });
  $('#slangBatchReject', view).addEventListener('click', async () => {
    const ids = selectedIdsForStatus('candidate');
    if (!ids.length) { toast('请先勾选要拒绝的候选词', 'err'); return; }
    if (!confirmDanger(`确定拒绝 ${ids.length} 条候选？`)) return;
    const r = await api('/api/slang/batch-reject', 'POST', { ids }).catch((e) => ({ ok: false, error: e.message }));
    setSlangMsg(r.ok ? `✅ 已拒绝 ${r.rejectedCount} 条` : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) { state.selected.clear(); refreshSlang(); }
  });
  $('#slangBatchDeleteCand', view).addEventListener('click', () => batchDelete('candidate', '候选'));
  $('#slangBatchDeleteConfirmed', view).addEventListener('click', () => batchDelete('confirmed', '已确认'));
  $('#slangBatchDeleteRejected', view).addEventListener('click', () => batchDelete('rejected', '已拒绝'));
  $('#slangBatchRestore', view).addEventListener('click', async () => {
    const ids = selectedIdsForStatus('rejected');
    if (!ids.length) { toast('请先勾选要恢复的已拒绝词条', 'err'); return; }
    let okCount = 0;
    for (const id of ids) {
      const r = await api('/api/slang/' + id, 'PATCH', { status: 'candidate' }).catch(() => ({ ok: false }));
      if (r.ok) okCount += 1;
    }
    setSlangMsg(`✅ 已恢复 ${okCount}/${ids.length} 条为候选`, true);
    if (okCount) { state.selected.clear(); refreshSlang(); }
  });
  $('#slangExtract', view).addEventListener('click', async () => {
    const r = await api('/api/slang/extract', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    setSlangMsg(r.ok ? '✅ 已触发提取' : ('❌ ' + (r.error || '失败')), r.ok);
  });
  $('#slangResearch', view).addEventListener('click', async () => {
    const r = await api('/api/slang/research', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    setSlangMsg(r.ok ? ('✅ 已触发研究 ' + r.count + ' 条') : ('❌ ' + (r.error || '失败')), r.ok);
  });

  // 手动添加
  $('#slangAdd', view).addEventListener('click', async () => {
    const content = $('#slangContent', view).value.trim();
    const meaning = $('#slangMeaning', view).value.trim();
    const usage = $('#slangUsage', view).value.trim();
    const example = $('#slangExample', view).value.trim();
    if (!content) { toast('词条不能为空', 'err'); return; }
    const r = await api('/api/slang', 'POST', { content, meaning, usage, example }).catch((e) => ({ ok: false, error: e.message }));
    setSlangMsg(r.ok ? '✅ 已添加' : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) {
      $('#slangContent', view).value = '';
      $('#slangMeaning', view).value = '';
      $('#slangUsage', view).value = '';
      $('#slangExample', view).value = '';
      refreshSlang();
    }
  });

  // 黑话参数
  $('#slangConfigSave', view).addEventListener('click', async () => {
    const r = await api('/api/slang/config', 'POST', {
      enabled: $('#slangEnabled', view).checked,
      extractMinMessages: num('slangExtractMin', 10),
      extractCooldownMs: num('slangCooldown', 300000),
      inferenceThresholds: $('#slangThresholds', view).value.split(/[,，\s]+/).map(Number).filter(Boolean),
      injectMax: num('slangInjectMax', 8),
      learnerPreset: $('#slangLearnerPreset', view).value.trim(),
      workspaceTitle: $('#slangWorkspaceTitle', view).value.trim(),
      autoResearch: $('#slangAutoResearch', view).checked
    }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#slangConfigMsg', view), r.ok ? '✅ 已保存' : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) { await loadSlangConfig(view); dirty?.markClean(); }
  });

  // 弹窗
  $('#slangModalCancel', view).addEventListener('click', closeModal);
  $('#slangModalOverlay', view).addEventListener('click', (e) => { if (e.target.id === 'slangModalOverlay') closeModal(); });
  $('#slangModalDirectConfirm', view).addEventListener('click', async () => {
    if (!state.modalId) return;
    const payload = modalPayload();
    if (!payload.meaning) { toast('请先填写含义，确认后才会注入 AI 上下文', 'err'); return; }
    const entry = state.entries.find((x) => x.id === state.modalId);
    if (!entry) return;
    const isConfirm = state.modalMode === 'confirm';
    const path = isConfirm ? `/api/slang/${entry.id}/confirm` : `/api/slang/${entry.id}`;
    const r = await api(path, isConfirm ? 'POST' : 'PATCH', payload).catch((e) => ({ ok: false, error: e.message }));
    setSlangMsg(r.ok ? (isConfirm ? '✅ 已确认转正' : '✅ 已保存') : ('❌ ' + (r.error || '失败')), r.ok);
    closeModal();
    refreshSlang();
  });
  $('#slangModalSendResearch', view).addEventListener('click', async () => {
    if (!state.modalId) return;
    const r = await api('/api/slang/research', 'POST', { ids: [state.modalId] }).catch((e) => ({ ok: false, error: e.message }));
    const word = state.entries.find((x) => x.id === state.modalId)?.content || '';
    setSlangMsg(r.ok ? `✅ 已送「${word}」到 DSH 深度联网研究，稍后刷新查看结果` : ('❌ ' + (r.error || '失败')), r.ok);
    closeModal();
    refreshSlang();
  });

  // RAG
  $('#ragRefresh', view).addEventListener('click', loadRagStatus);
  $('#ragRebuild', view).addEventListener('click', () => ragReindex(false));
  $('#ragRebuildForce', view).addEventListener('click', () => ragReindex(true));
  $('#ragDebugBtn', view).addEventListener('click', ragDebug);
  $('#ragQuery', view).addEventListener('keydown', (e) => { if (e.key === 'Enter') ragDebug(); });
  $('#ragDupBtn', view).addEventListener('click', ragNearDuplicates);

  setTab(state.tab);
  await refreshSlang();
  // 必须 await：基线要在表单填好之后建，否则刚加载出来的值会被当成用户改动
  await loadSlangConfig(view);
  loadRagStatus();

  // 两个开关：拨动即写盘，失败就拨回去
  view.addEventListener('change', async (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || el.type !== 'checkbox') return;
    const key = SLANG_SWITCHES[el.id];
    if (!key) return;
    el.classList.add('saving');
    const r = await api('/api/slang/config', 'POST', { [key]: el.checked }).catch((err) => ({ ok: false, error: err.message }));
    el.classList.remove('saving');
    if (!r.ok) {
      el.checked = !el.checked;
      toast(r.error || '保存失败', 'err');
    }
  });

  dirty = trackDirty(view, {
    selector: SLANG_MANUAL_SELECTOR,
    label: '黑话参数',
    onChange: (n) => {
      $('#slangDirtyHint', state.view).textContent = n ? `● 有 ${n} 项未保存` : '';
      $('#slangConfigSave', state.view).classList.toggle('dirty', n > 0);
    }
  });

  // 故意不在卸载时把 state.view 置空：有些异步加载（如 loadRagStatus）可能在切走
  // 之后才回来，置空会让它们拿到 null 根节点直接抛错；保留旧元素最多写到已脱离文档的
  // 片段上，用户看不到，也不会报错。
  return undefined;
}
