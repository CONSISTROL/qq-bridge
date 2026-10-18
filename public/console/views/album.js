// 相册（图片总入口）：5 个来源统一索引 + 元数据（添加时间/来源/备注/标签）。
//
// 性能注意（线上踩过）：网格里**必须用缩略图**（api/album/thumb，320px jpg 缓存），
// 直接给原图一屏几十张就是几百 MB，页面极卡；列表还要分页（默认 60，点「加载更多」）。
// 点卡片 → 弹窗看大图 + 改备注/标签 + 删除（删除进回收站，不直接抹盘）。
import { api } from '../core/api.js';
import { $, esc, setMsg, confirmDanger, delegate, debounce, fmtClock } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

export const id = 'album';
export const title = '相册';
export const desc = '所有图片：聊天收到 · AI 发出 · 图库 · 抓取 · 视频帧';
export const group = '语料';
export const order = 11;

const PAGE = 60;

function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}
function fmtTime(ms) {
  if (!ms) return '-';
  try { return fmtClock(new Date(Number(ms))); } catch { return String(ms); }
}
// ⚠ 缩略图/原图都用**相对路径**：控制台可能被反代在子路径下（如 /qq/），
// 写成 `/api/...` 会跑到反代自己的接口上（线上表现：网格全黑）。
function fileUrl(kind, it, extra = '') {
  return `api/album/${kind}?source=${encodeURIComponent(it.source)}&file=${encodeURIComponent(it.file)}${extra}`;
}

export async function mount(root) {
  const view = await mountFragment(root, 'album');
  const state = { sources: [], items: [], stats: { count: 0, bytes: 0, bySource: {} }, total: 0, hasMore: false, source: '', q: '', offset: 0, page: 1, pageSize: PAGE, pages: 1, selected: new Set() };

  const renderGrid = (list, { clear = false } = {}) => {
    const grid = $('#albumGrid', view);
    if (!grid) return;
    // 重载（筛选/删除/保存后）必须先把旧卡片清掉，否则删掉的那张还留在网格里，
    // 看起来就是"要手动刷新页面才变化"（线上真事）。
    if (clear) grid.textContent = '';
    for (const it of list) {
      const card = document.createElement('div');
      card.className = 'album-card';
      card.dataset.id = it.id;
      const pick = document.createElement('input');
      pick.type = 'checkbox';
      pick.className = 'album-pick';
      pick.checked = state.selected.has(it.id);
      pick.dataset.pick = it.id;
      if (pick.checked) card.classList.add('picked');
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = fileUrl('thumb', it, '&w=320');
      img.alt = it.notes || it.file;
      const meta = document.createElement('div');
      meta.className = 'album-meta';
      meta.innerHTML = `<div class="album-notes">${esc(it.notes || it.file)}</div>`
        + `<div class="album-sub">${esc(it.sourceLabel)} · ${fmtBytes(it.bytes)}</div>`;
      card.append(pick, img, meta);
      grid.append(card);
    }
    const info = $('#albumPageInfo', view);
    if (info) info.textContent = `第 ${state.page} / ${state.pages} 页 · 共 ${state.total} 张`;
    const prev = $('#albumPrev', view); if (prev) prev.disabled = state.page <= 1;
    const next = $('#albumNext', view); if (next) next.disabled = state.page >= state.pages;
    const stats = $('#albumStats', view);
    if (stats) {
      const bySrc = Object.entries(state.stats.bySource || {})
        .map(([id, n]) => `${(state.sources.find((s) => s.id === id) || {}).label || id} ${n}`).join(' · ');
      stats.textContent = `共 ${state.stats.count} 张 · ${fmtBytes(state.stats.bytes)}${bySrc ? ' · ' + bySrc : ''}`;
    }
  };

  const renderSelInfo = () => {
    const el = $('#albumSelInfo', view);
    if (el) el.textContent = state.selected.size ? `已选 ${state.selected.size} 张` : '';
  };

  const load = async ({ page = state.page } = {}) => {
    setMsg($('#albumMsg', view), '');
    state.page = Math.max(1, Number(page) || 1);
    const params = new URLSearchParams({ limit: String(state.pageSize), offset: String((state.page - 1) * state.pageSize) });
    if (state.source) params.set('source', state.source);
    if (state.q) params.set('q', state.q);
    const r = await api('api/album?' + params.toString(), 'GET').catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { setMsg($('#albumMsg', view), '❌ ' + (r.error || '加载失败')); return; }
    state.sources = r.sources || [];
    state.stats = r.stats || { count: 0, bytes: 0 };
    state.total = r.total || 0;
    state.hasMore = !!r.hasMore;
    const fresh = r.items || [];
    state.items = fresh;
    state.total = r.total || 0;
    state.pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    // 删到当前页空了（且不是第一页）→ 自动退一页，而不是甩回第一页
    if (!fresh.length && state.page > 1) return load({ page: state.page - 1 });
    state.offset = (state.page - 1) * state.pageSize;
    const sel = $('#albumSource', view);
    if (sel && sel.options.length === 0) {
      const all = document.createElement('option');
      all.value = ''; all.textContent = '全部来源'; sel.append(all);
      for (const s of state.sources) {
        const o = document.createElement('option');
        o.value = s.id; o.textContent = s.label; sel.append(o);
      }
    }
    renderGrid(fresh, { clear: true });
    renderSelInfo();
  };

  // ── 大图弹窗 ───────────────────────────────────────────────
  const openModal = (it) => {
    const modal = $('#albumModal', view);
    if (!modal) return;
    modal.dataset.source = it.source;
    modal.dataset.file = it.file;
    $('#albumModalImg', view).src = fileUrl('file', it);
    $('#albumModalTitle', view).textContent = it.file;
    $('#albumModalMeta', view).textContent = `${it.sourceLabel} · ${fmtBytes(it.bytes)} · 添加于 ${fmtTime(it.addedAt)}`
      + (it.width && it.height ? ` · ${it.width}×${it.height}` : '');
    $('#albumModalNotes', view).value = it.notes || '';
    $('#albumModalTags', view).value = (it.tags || []).join(', ');
    modal.style.display = '';
  };
  const closeModal = () => { const m = $('#albumModal', view); if (m) m.style.display = 'none'; };

  delegate($('#albumGrid', view), 'click', '.album-card', (ev, card) => {
    // 勾选框的 click 也会冒泡到卡片上——不排除的话，点勾选会同时打开大图弹窗（线上反馈）。
    if (ev.target && ev.target.closest && ev.target.closest('.album-pick')) return;
    const it = state.items.find((x) => x.id === card.dataset.id);
    if (it) openModal(it);
  });

  // 统一用事件委托：按钮可能被重新渲染/替换，直接 addEventListener 容易"点了没反应"。
  const modalMsg = (text) => { const el = $('#albumModalMsg', view); if (el) el.textContent = text; setMsg($('#albumMsg', view), text); };
  delegate($('#albumModal', view), 'click', '#albumModalClose', () => closeModal());
  delegate($('#albumModal', view), 'click', '#albumModalSave', async () => {
    const modal = $('#albumModal', view);
    modalMsg('保存中…');
    const r = await api('api/album', 'PATCH', {
      source: modal.dataset.source,
      file: modal.dataset.file,
      notes: $('#albumModalNotes', view).value,
      tags: $('#albumModalTags', view).value
    }).catch((e) => ({ ok: false, error: e.message }));
    modalMsg(r.ok ? '✅ 已保存' : ('❌ ' + (r.error || '保存失败')));
    if (r.ok) { closeModal(); await load(); }
  });
  delegate($('#albumModal', view), 'click', '#albumModalDelete', async () => {
    const modal = $('#albumModal', view);
    if (!confirmDanger(`删除这张图？\n${modal.dataset.file}\n（先进回收站 state/album-trash，可还原）`)) return;
    modalMsg('删除中…');
    const r = await api('api/album/delete', 'POST', { source: modal.dataset.source, file: modal.dataset.file })
      .catch((e) => ({ ok: false, error: e.message }));
    modalMsg(r.ok ? '✅ 已移入回收站' : ('❌ ' + (r.error || '删除失败')));
    if (r.ok) { closeModal(); await load(); }
  });
  $('#albumModal', view)?.addEventListener('click', (ev) => { if (ev.target.id === 'albumModal') closeModal(); });
  delegate(view, 'click', '#albumPrev', () => load({ page: state.page - 1 }));
  delegate(view, 'click', '#albumNext', () => load({ page: state.page + 1 }));
  delegate(view, 'click', '#albumJumpGo', () => {
    const n = Number($('#albumJump', view).value) || 1;
    load({ page: Math.min(Math.max(1, n), state.pages) });
  });
  delegate(view, 'keydown', '#albumJump', (ev) => { if (ev.key === 'Enter') $('#albumJumpGo', view)?.click(); });
  // 勾选（勾选框点击不要触发卡片的大图弹窗）
  delegate($('#albumGrid', view), 'change', '.album-pick', (ev) => {
    const id = ev.target.dataset.pick;
    const card = ev.target.closest('.album-card');
    if (ev.target.checked) { state.selected.add(id); card?.classList.add('picked'); }
    else { state.selected.delete(id); card?.classList.remove('picked'); }
    renderSelInfo();
  });
  delegate(view, 'click', '#albumSelectAll', () => {
    const all = state.items.map((it) => it.id);
    const full = all.length > 0 && all.every((id) => state.selected.has(id));
    state.selected = full ? new Set() : new Set(all);
    for (const el of view.querySelectorAll('.album-pick')) {
      el.checked = state.selected.has(el.dataset.pick);
      el.closest('.album-card')?.classList.toggle('picked', el.checked);
    }
    renderSelInfo();
  });
  delegate(view, 'click', '#albumDeleteSel', async () => {
    if (!state.selected.size) { setMsg($('#albumMsg', view), '先勾选要删除的图片'); return; }
    if (!confirmDanger(`删除选中的 ${state.selected.size} 张？\n（都会进回收站，可还原）`)) return;
    const items = state.items.filter((it) => state.selected.has(it.id)).map((it) => ({ source: it.source, file: it.file }));
    const r = await api('api/album/delete-batch', 'POST', { items }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#albumMsg', view), r.ok ? `✅ 已删除 ${r.removed} 张（进回收站）` : ('❌ ' + (r.error || '失败')));
    if (r.ok) { state.selected.clear(); await load(); }
  });
  // 回收站
  const renderTrash = async () => {
    const list = $('#albumTrashList', view);
    setMsg($('#albumTrashMsg', view), '加载中…');
    const r = await api('api/album/trash', 'GET').catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { setMsg($('#albumTrashMsg', view), '❌ ' + (r.error || '加载失败')); return; }
    setMsg($('#albumTrashMsg', view), `共 ${r.stats.count} 张 / ${fmtBytes(r.stats.bytes)}`);
    list.textContent = '';
    for (const it of r.items) {
      const card = document.createElement('div');
      card.className = 'album-trash-card';
      card.dataset.source = it.source;
      card.dataset.trash = it.trashName;
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = `api/album/trash-file?source=${encodeURIComponent(it.source)}&name=${encodeURIComponent(it.trashName)}`;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${it.file} · ${fmtBytes(it.bytes)} · ${it.deletedAt ? fmtTime(it.deletedAt) : ''}`;
      const row = document.createElement('div');
      row.className = 'row';
      row.style.gap = '6px';
      const btnRestore = document.createElement('button');
      btnRestore.className = 'btn'; btnRestore.type = 'button'; btnRestore.textContent = '还原';
      btnRestore.dataset.trashAct = 'restore';
      const btnPurge = document.createElement('button');
      btnPurge.className = 'danger'; btnPurge.type = 'button'; btnPurge.textContent = '彻底删除';
      btnPurge.dataset.trashAct = 'purge';
      row.append(btnRestore, btnPurge);
      card.append(img, meta, row);
      list.append(card);
    }
  };
  delegate(view, 'click', '#albumTrashBtn', async () => { const m = $('#albumTrashModal', view); if (m) m.style.display = ''; await renderTrash(); });
  delegate($('#albumTrashModal', view), 'click', '#albumTrashClose', () => { const m = $('#albumTrashModal', view); if (m) m.style.display = 'none'; });
  delegate($('#albumTrashModal', view), 'click', '#albumTrashEmpty', async () => {
    if (!confirmDanger('清空回收站？这些图会被**永久删除**，无法还原。')) return;
    const r = await api('api/album/trash-empty', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#albumTrashMsg', view), r.ok ? `✅ 已清空（${r.removed} 张）` : ('❌ ' + (r.error || '失败')));
    if (r.ok) { await renderTrash(); await load(); }
  });
  delegate($('#albumTrashModal', view), 'click', '[data-trash-act]', async (ev, btn) => {
    const card = btn.closest('.album-trash-card');
    const source = card.dataset.source;
    const trashName = card.dataset.trash;
    const act = btn.dataset.trashAct;
    if (act === 'purge' && !confirmDanger('彻底删除这张？无法还原。')) return;
    const r = await api(act === 'restore' ? 'api/album/trash-restore' : 'api/album/trash-purge', 'POST', { source, trashName })
      .catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#albumTrashMsg', view), r.ok ? (act === 'restore' ? '✅ 已还原' : '✅ 已彻底删除') : ('❌ ' + (r.error || '失败')));
    if (r.ok) { await renderTrash(); await load(); }
  });
  delegate(view, 'click', '#albumRescan', async () => {
    const r = await api('api/album/rescan', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#albumMsg', view), r.ok ? `✅ 重扫完成：${r.count} 张 / ${fmtBytes(r.bytes)}` : ('❌ ' + (r.error || '失败')));
    await load();
  });
  delegate(view, 'change', '#albumSource', (ev) => { state.source = ev.target.value; load({ page: 1 }); });
  delegate(view, 'input', '#albumSearch', debounce((ev) => { state.q = ev.target.value.trim(); load({ page: 1 }); }, 350));

  await load();
  return () => {};
}
