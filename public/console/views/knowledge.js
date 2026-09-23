// 群知识库（09）：问题→答案 的沉淀、复用与人工纠错。
//
// 与黑话库（views/slang.js）的分工：黑话管「词什么意思」，这里管「问题答案是什么」。
// 本视图的重点是**纠错**：AI 全自动写入，所以一眼能看出「哪条被反复问」「哪条答案互相矛盾」
// 比管理流程更重要——列表默认按命中次数排序，冲突单独置顶一块。
import { api } from '../core/api.js';
import { $, $$, toast, setMsg, confirmDanger } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';
import { trackDirty } from '../core/dirty.js';

export const id = 'knowledge';
export const title = '群知识库';
export const desc = '问题→答案 沉淀：重复问题自动命中，AI 全自动写入并可随时删改';
export const icon = '🧠';
export const group = '语料';
export const order = 2;

const KIND_LABEL = { fact: '事实', rule: '群规', person: '人物', howto: '操作' };
const KIND_CLASS = { fact: 'pill', rule: 'pill b', person: 'pill g', howto: 'pill' };

const state = {
  view: null,
  entries: [],
  stats: null,
  conflicts: [],
  selected: new Set(),
  // 标签页直接对应「状态」，比下拉框更贴近实际工作流：候选要确认、冲突要裁定、生效的要盯准确性。
  // conflict 是唯一一个不是真实 status 的伪标签（= 带冲突标记的条目）。
  tab: 'confirmed',
};

const escAll = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function setKbMsg(text, ok = true) {
  setMsg($('#kbMsg', state.view), text, ok);
}

function splitList(value) {
  return String(value ?? '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
}

function searchFields(e) {
  return [
    e.question, e.answer, e.kind,
    Array.isArray(e.tags) ? e.tags.join(' ') : '',
    Array.isArray(e.aliases) ? e.aliases.join(' ') : '',
    Array.isArray(e.sources) ? e.sources.join(' ') : '',
  ].join(' ').toLowerCase();
}

function currentList() {
  const view = state.view;
  const q = String($('#kbSearch', view)?.value || '').trim().toLowerCase();
  const kind = String($('#kbKindFilter', view)?.value || '');
  const limit = Math.max(10, Number($('#kbLimit', view)?.value) || 100);
  let list = state.entries.slice();
  if (state.tab === 'conflict') list = list.filter((e) => e.conflict);
  else if (state.tab !== 'all') list = list.filter((e) => e.status === state.tab);
  if (kind) list = list.filter((e) => e.kind === kind);
  if (q) list = list.filter((e) => searchFields(e).includes(q));
  // 被反复问的排前面：这既是最该保证准确的，也是最值得人工过一眼的
  list.sort((a, b) => (Number(b.hitCount) || 0) - (Number(a.hitCount) || 0));
  return { list, limit };
}

function renderStats() {
  const el = $('#kbStats', state.view);
  if (!el) return;
  const s = state.stats || {};
  el.innerHTML = [
    `共 <b>${s.total ?? 0}</b> 条`,
    `已生效 <b>${s.confirmed ?? 0}</b> 条`,
    s.candidates ? `<span class="err">待确认 ${s.candidates} 条</span>` : '待确认 0 条',
    s.archived ? `已停用 ${s.archived} 条` : '',
    `累计命中 <b>${s.totalHits ?? 0}</b> 次`,
    s.repeats ? `<span class="err">反复被问 ${s.repeats} 条</span>` : '反复被问 0 条',
    s.conflicts ? `<span class="err">待裁定冲突 ${s.conflicts} 条</span>` : '待裁定冲突 0 条',
  ].join(' · ');
}

function renderConflicts() {
  const box = $('#kbConflictBox', state.view);
  const list = $('#kbConflictList', state.view);
  if (!box || !list) return;
  if (!state.conflicts.length) { box.style.display = 'none'; list.innerHTML = ''; return; }
  box.style.display = '';
  list.innerHTML = '<table><thead><tr><th>问题</th><th>当前答案</th><th>AI 报告的另一答案</th><th>原因</th><th>操作</th></tr></thead><tbody>'
    + state.conflicts.map((c) => `<tr>
        <td>${escAll(c.question)}</td>
        <td>${escAll(String(c.answer || '').slice(0, 200))}</td>
        <td>${escAll(String(c.conflict?.withAnswer || '').slice(0, 200))}</td>
        <td>${escAll(c.conflict?.reason || '')}<br><span class="meta">${escAll(c.conflict?.by || '')}</span></td>
        <td class="row">
          <button class="small" data-kb-edit="${escAll(c.id)}">去裁定（编辑）</button>
          <button class="small" data-kb-resolve="${escAll(c.id)}">保留当前、清除标记</button>
        </td>
      </tr>`).join('')
    + '</tbody></table>';
}

function renderList() {
  const box = $('#kbList', state.view);
  if (!box) return;
  const { list, limit } = currentList();
  if (!list.length) {
    box.innerHTML = `<div class="meta" style="padding:8px">${state.entries.length ? '没有符合条件的条目' : '知识库还是空的。等 AI 沉淀，或在下面手动加一条。'}</div>`;
    return;
  }
  const shown = list.slice(0, limit);
  let html = `<div class="meta" style="padding:6px 8px">共 ${list.length} 条，显示 ${shown.length} 条（按被问次数排序）</div>`;
  html += '<table><tr><th>选择</th><th>问题</th><th>被问</th><th>答案</th><th>标签 / 来源</th><th>操作</th></tr>';
  for (const e of shown) {
    const checked = state.selected.has(e.id) ? ' checked' : '';
    const repeat = (Number(e.hitCount) || 0) >= 3 && (e.askerCount || 0) >= 2
      ? ' <span class="err">反复被问</span>' : '';
    const kindPill = `<span class="${KIND_CLASS[e.kind] || 'pill'}">${escAll(KIND_LABEL[e.kind] || e.kind || '事实')}</span>`;
    const statusPill = e.status === 'candidate' ? '<span class="pill b">待确认</span>'
      : e.status === 'archived' ? '<span class="pill r">已停用</span>'
        : '<span class="pill g">生效中</span>';
    const conflictPill = e.conflict ? ' <span class="pill r">冲突待裁定</span>' : '';
    const tags = (e.tags || []).filter((t) => t !== e.kind).slice(0, 4);
    html += `<tr>
      <td><input type="checkbox" data-kb-select="${escAll(e.id)}"${checked}></td>
      <td>${kindPill} ${statusPill}${conflictPill}${repeat}<br><b>${escAll(e.question)}</b>
        ${Array.isArray(e.aliases) && e.aliases.length ? `<br><span class="meta">其他问法：${escAll(e.aliases.join('、'))}</span>` : ''}</td>
      <td>${escAll(e.hitCount)} 次<br><span class="meta">${escAll(e.askerCount || 0)} 人${Number(e.revision) ? ` · 改过 ${escAll(e.revision)} 次` : ''}</span></td>
      <td>${escAll(e.answer)}</td>
      <td>${tags.length ? `<span class="meta">${escAll(tags.join('、'))}</span><br>` : ''}
        <span class="meta">${escAll(e.source === 'manual' ? '手动' : 'AI')} · ${escAll(String(e.updatedAt || '').slice(0, 10))}</span>
        ${Array.isArray(e.sources) && e.sources.length ? `<br><span class="meta">🔗 ${escAll(e.sources[e.sources.length - 1])}</span>` : ''}</td>
      <td class="row">
        <button class="small" data-kb-edit="${escAll(e.id)}">编辑</button>
        ${e.status === 'candidate' ? `<button class="small" data-kb-confirm="${escAll(e.id)}">确认生效</button>` : ''}
        <button class="small" data-kb-toggle="${escAll(e.id)}">${e.status === 'archived' ? '启用' : '停用'}</button>
        <button class="small danger" data-kb-del="${escAll(e.id)}">删</button>
      </td>
    </tr>`;
  }
  box.innerHTML = html + '</table>';
}

async function refresh() {
  const r = await api('/api/knowledge').catch(() => null);
  if (!r) { setKbMsg('加载失败', false); return; }
  state.entries = r.entries || [];
  state.stats = r.stats || null;
  state.conflicts = r.conflicts || [];
  state.kbConfig = r.config || {};
  state.rag = r.rag || null;
  renderStats();
  renderConflicts();
  renderList();
  renderRag();
}

function renderRag() {
  const el = $('#kbRagStatus', state.view);
  const r = state.rag;
  if (!el || !r) return;
  el.innerHTML = [
    r.enabled ? (r.ready ? '<span class="ok">● 向量检索已启用</span>' : '<span class="err">● 已启用但子进程不可用</span>') : '<span class="muted">○ 已关闭</span>',
    `已索引 <b>${r.indexed}</b> 条`,
    r.stale ? `<span class="err">待补 ${r.stale} 条</span>` : '待补 0 条',
    r.orphans ? `孤儿 ${r.orphans} 条` : '',
    r.builtAt ? `构建于 ${escAll(new Date(r.builtAt).toLocaleString('zh-CN', { hour12: false }))}` : '尚未构建',
    r.lastError ? `<span class="err">最近错误：${escAll(r.lastError)}</span>` : '',
  ].filter(Boolean).join(' · ');
}

async function loadConfig(view) {
  const r = await api('/api/knowledge').catch(() => null);
  if (!r) return;
  const c = r.config || {};
  $('#kbEnabled', view).checked = c.enabled !== false;
  $('#kbAutoWrite', view).checked = c.autoWrite !== false;
  $('#kbInjectMax', view).value = c.injectMax ?? 6;
  $('#kbRemindHit', view).value = c.remindHitCount ?? 3;
  $('#kbRemindAskers', view).value = c.remindMinAskers ?? 2;
  $('#kbSimThreshold', view).value = c.similarityThreshold ?? 0.62;
}

function fillForm(e) {
  const view = state.view;
  $('#kbEditId', view).value = e ? e.id : '';
  $('#kbKind', view).value = e?.kind || 'fact';
  $('#kbQuestion', view).value = e?.question || '';
  $('#kbAnswer', view).value = e?.answer || '';
  $('#kbTags', view).value = (e?.tags || []).filter((t) => t !== e?.kind).join(', ');
  $('#kbAliases', view).value = (e?.aliases || []).join(', ');
  $('#kbSource', view).value = (e?.sources || []).slice(-1)[0] || '';
  $('#kbCancelEdit', view).style.display = e ? '' : 'none';
  if (e) {
    setMsg($('#kbFormMsg', view), `正在编辑：${e.question}`, true);
    $('#kbQuestion', view).scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else {
    setMsg($('#kbFormMsg', view), '', true);
  }
}

async function saveForm() {
  const view = state.view;
  const id = $('#kbEditId', view).value.trim();
  const question = $('#kbQuestion', view).value.trim();
  const answer = $('#kbAnswer', view).value.trim();
  const kind = $('#kbKind', view).value;
  if (!question) { toast('问题不能为空', 'err'); return; }
  if (!answer) { toast('答案不能为空', 'err'); return; }
  const payload = {
    question,
    answer,
    kind,
    tags: splitList($('#kbTags', view).value),
    aliases: splitList($('#kbAliases', view).value),
    sources: splitList($('#kbSource', view).value),
  };
  // 编辑时是「人工裁定」：顺带清掉冲突标记
  const r = id
    ? await api('/api/knowledge/update', 'POST', { ...payload, id, resolveConflict: true }).catch((e) => ({ ok: false, error: e.message }))
    : await api('/api/knowledge', 'POST', payload).catch((e) => ({ ok: false, error: e.message }));
  setMsg($('#kbFormMsg', view), r.ok ? (id ? '✅ 已保存修改' : '✅ 已新增') : ('❌ ' + (r.error || '失败')), r.ok);
  if (r.ok) {
    fillForm(null);
    await refresh();
  }
}

export async function mount(root) {
  const view = await mountFragment(root, 'knowledge');
  state.view = view;
  state.selected.clear();
  state.entries = [];

  view.addEventListener('change', (e) => {
    const cb = e.target instanceof Element ? e.target.closest('[data-kb-select]') : null;
    if (!cb) return;
    if (cb.checked) state.selected.add(cb.dataset.kbSelect);
    else state.selected.delete(cb.dataset.kbSelect);
  });

  view.addEventListener('click', async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const hit = (attr) => t.closest(`[${attr}]`);
    const editBtn = hit('data-kb-edit');
    if (editBtn) {
      const entry = state.entries.find((x) => x.id === editBtn.dataset.kbEdit);
      if (entry) fillForm(entry);
      return;
    }
    const resolveBtn = hit('data-kb-resolve');
    if (resolveBtn) {
      const entry = state.entries.find((x) => x.id === resolveBtn.dataset.kbResolve);
      if (!entry) return;
      const r = await api('/api/knowledge/update', 'POST', {
        id: entry.id, answer: entry.answer, resolveConflict: true
      }).catch((err) => ({ ok: false, error: err.message }));
      setKbMsg(r.ok ? '✅ 已清除冲突标记（保留当前答案）' : ('❌ ' + (r.error || '失败')), r.ok);
      if (r.ok) await refresh();
      return;
    }
    const confirmBtn = hit('data-kb-confirm');
    if (confirmBtn) {
      // 候选 → 生效：这就是「确认」动作。转正后立刻进入检索与注入池。
      const r = await api('/api/knowledge/update', 'POST', {
        id: confirmBtn.dataset.kbConfirm, status: 'confirmed', resolveConflict: true
      }).catch((err) => ({ ok: false, error: err.message }));
      setKbMsg(r.ok ? '✅ 已确认生效（下次有人问就会命中）' : ('❌ ' + (r.error || '失败')), r.ok);
      if (r.ok) await refresh();
      return;
    }
    const toggleBtn = hit('data-kb-toggle');
    if (toggleBtn) {
      const entry = state.entries.find((x) => x.id === toggleBtn.dataset.kbToggle);
      if (!entry) return;
      // 候选有自己的「确认生效」按钮（候选没生效，点停用没意义），所以这里只切生效/停用。
      const next = entry.status === 'confirmed' ? 'archived' : 'confirmed';
      const r = await api('/api/knowledge/update', 'POST', { id: entry.id, status: next }).catch((err) => ({ ok: false, error: err.message }));
      setKbMsg(r.ok ? (next === 'archived' ? '✅ 已停用（不再注入/检索）' : '✅ 已启用') : ('❌ ' + (r.error || '失败')), r.ok);
      if (r.ok) await refresh();
      return;
    }
    const delBtn = hit('data-kb-del');
    if (delBtn) {
      if (!confirmDanger('确定删除这条知识？删除后 AI 再被问到会重新查。')) return;
      const r = await api('/api/knowledge/delete', 'POST', { id: delBtn.dataset.kbDel }).catch((err) => ({ ok: false, error: err.message }));
      setKbMsg(r.ok ? '✅ 已删除' : ('❌ ' + (r.error || '失败')), r.ok);
      state.selected.delete(delBtn.dataset.kbDel);
      if (r.ok) await refresh();
    }
  });

  // 标签页：切换状态视图（冲突是伪标签，= 带冲突标记的条目）
  for (const btn of $$('.slang-tab', view)) {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.kbTab || 'confirmed';
      for (const b of $$('.slang-tab', view)) b.classList.toggle('active', b.dataset.kbTab === state.tab);
      renderList();
    });
  }

  $('#kbRefresh', view).addEventListener('click', refresh);
  $('#kbSearch', view).addEventListener('input', renderList);
  $('#kbKindFilter', view).addEventListener('change', renderList);
  $('#kbLimit', view).addEventListener('change', renderList);

  $('#kbDeleteSelected', view).addEventListener('click', async () => {
    const ids = [...state.selected];
    if (!ids.length) { toast('请先勾选要删除的条目', 'err'); return; }
    if (!confirmDanger(`确定删除 ${ids.length} 条知识？此操作不可恢复！`)) return;
    const r = await api('/api/knowledge/delete', 'POST', { ids }).catch((err) => ({ ok: false, error: err.message }));
    setKbMsg(r.ok ? `✅ 已删除 ${r.removedCount} 条` : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) { state.selected.clear(); await refresh(); }
  });

  $('#kbSave', view).addEventListener('click', saveForm);
  $('#kbCancelEdit', view).addEventListener('click', () => fillForm(null));

  let dirty = null;
  $('#kbConfigSave', view).addEventListener('click', async () => {
    const num = (sel, d) => Number($(sel, view).value) || d;
    const r = await api('/api/knowledge/config', 'POST', {
      enabled: $('#kbEnabled', view).checked,
      autoWrite: $('#kbAutoWrite', view).checked,
      injectMax: num('#kbInjectMax', 6),
      remindHitCount: num('#kbRemindHit', 3),
      remindMinAskers: num('#kbRemindAskers', 2),
      similarityThreshold: num('#kbSimThreshold', 0.62),
    }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#kbConfigMsg', view), r.ok ? '✅ 已保存' : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) { await loadConfig(view); dirty?.markClean(); }
  });

  $('#kbRagRebuild', view).addEventListener('click', () => rebuildRag(false));
  $('#kbRagRebuildForce', view).addEventListener('click', () => rebuildRag(true));

  async function rebuildRag(force) {
    const msg = $('#kbRagMsg', view);
    setMsg(msg, force ? '强制全量重建中…（会清空后重编码）' : '补齐中…', true);
    try {
      const r = await api('/api/knowledge/rag-rebuild', 'POST', { force });
      if (!r.ok) throw new Error(r.error || '重建失败');
      setMsg(msg, `完成：新编码 ${r.embedded} 条，清理 ${r.orphans} 条，库内 ${r.total} 条，耗时 ${r.ms}ms`, true);
      await refresh();
    } catch (err) {
      setMsg(msg, `失败：${err.message}`, false);
    }
  }

  const debugSearch = async () => {
    const q = $('#kbDebugQuery', view).value.trim();
    const key = $('#kbDebugKey', view).value.trim();
    const msg = $('#kbFormMsg', view);
    if (!q) { toast('先填一个查询问题', 'err'); return; }
    try {
      const r = await api('/api/knowledge/debug-search', 'POST', { query: q, key });
      $('#kbDebugOut', view).style.display = '';
      $('#kbDebugFingerprint', view).textContent = `问题指纹：${r.fingerprint || '(空)'}`;
      const exact = r.exact
        ? `<div class="rag-row"><span class="rag-score">${r.exact.sim != null ? r.exact.sim.toFixed(3) : '指纹'}</span>
             <span class="rag-name">${escAll(r.exact.entry.question)}</span>
             <span class="rag-why">命中方式：${escAll(r.exact.match)} → 会合并到这条（+1 次）</span></div>`
        : '<div class="meta">字面/指纹都没有命中 → 会被当成新问题（AI 答完可沉淀新条目）</div>';
      const vec = Array.isArray(r.vector) && r.vector.length
        ? r.vector.map((v) => `<div class="rag-row"><span class="rag-score">${v.similarity.toFixed(3)}</span>
             <span class="rag-name">${escAll(v.question)}</span>
             <span class="rag-why">已被问 ${v.hitCount} 次</span></div>`).join('')
        : '<div class="meta">向量检索无结果或未启用</div>';
      $('#kbDebugOut', view).innerHTML = `
        <div class="meta" style="margin-top:4px"><b>去重判定</b></div>${exact}
        <div class="meta" style="margin-top:8px"><b>语义检索（会注入哪些）</b></div>${vec}
        <div class="meta" style="margin-top:8px"><b>实际注入的提示词片段</b></div>
        <pre style="white-space:pre-wrap;margin:4px 0">${escAll(r.block || '（本次不会注入任何知识条目）')}</pre>`;
      setMsg(msg, '', true);
    } catch (err) {
      setMsg(msg, `检索失败：${err.message}`, false);
    }
  };
  $('#kbDebugBtn', view).addEventListener('click', debugSearch);
  $('#kbDebugQuery', view).addEventListener('keydown', (e) => { if (e.key === 'Enter') debugSearch(); });

  await refresh();
  await loadConfig(view);

  // 开关即改即生效（其余数字参数走「保存参数」）
  view.addEventListener('change', async (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || el.type !== 'checkbox') return;
    if (el.id !== 'kbEnabled' && el.id !== 'kbAutoWrite') return;
    const key = el.id === 'kbEnabled' ? 'enabled' : 'autoWrite';
    el.classList.add('saving');
    const r = await api('/api/knowledge/config', 'POST', { [key]: el.checked }).catch((err) => ({ ok: false, error: err.message }));
    el.classList.remove('saving');
    if (!r.ok) { el.checked = !el.checked; toast(r.error || '保存失败', 'err'); }
  });

  dirty = trackDirty(view, {
    selector: '#kbInjectMax, #kbRemindHit, #kbRemindAskers, #kbSimThreshold',
    label: '知识库参数',
    onChange: (n) => {
      const hint = $('#kbConfigMsg', state.view);
      if (n) setMsg(hint, `● 有 ${n} 项未保存`, true);
    },
  });

  return undefined;
}
