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
  const state = { sources: [], items: [], stats: { count: 0, bytes: 0, bySource: {} }, total: 0, hasMore: false, source: '', q: '', offset: 0 };

  const renderGrid = (append) => {
    const grid = $('#albumGrid', view);
    if (!grid) return;
    if (!append) grid.textContent = '';
    for (const it of state.items.slice(append ? state.offset : 0)) {
      const card = document.createElement('div');
      card.className = 'album-card';
      card.dataset.id = it.id;
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = fileUrl('thumb', it, '&w=320');
      img.alt = it.notes || it.file;
      const meta = document.createElement('div');
      meta.className = 'album-meta';
      meta.innerHTML = `<div class="album-notes">${esc(it.notes || it.file)}</div>`
        + `<div class="album-sub">${esc(it.sourceLabel)} · ${fmtBytes(it.bytes)}</div>`;
      card.append(img, meta);
      grid.append(card);
    }
    const more = $('#albumMore', view);
    if (more) more.style.display = state.hasMore ? '' : 'none';
    const stats = $('#albumStats', view);
    if (stats) {
      const bySrc = Object.entries(state.stats.bySource || {})
        .map(([id, n]) => `${(state.sources.find((s) => s.id === id) || {}).label || id} ${n}`).join(' · ');
      stats.textContent = `共 ${state.stats.count} 张 · ${fmtBytes(state.stats.bytes)}${bySrc ? ' · ' + bySrc : ''}`;
    }
  };

  const load = async ({ append = false } = {}) => {
    setMsg($('#albumMsg', view), '');
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(append ? state.offset : 0) });
    if (state.source) params.set('source', state.source);
    if (state.q) params.set('q', state.q);
    const r = await api('api/album?' + params.toString(), 'GET').catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { setMsg($('#albumMsg', view), '❌ ' + (r.error || '加载失败')); return; }
    state.sources = r.sources || [];
    state.stats = r.stats || { count: 0, bytes: 0 };
    state.total = r.total || 0;
    state.hasMore = !!r.hasMore;
    if (append) { state.items = state.items.concat(r.items || []); state.offset += (r.items || []).length; }
    else { state.items = r.items || []; state.offset = state.items.length; }
    const sel = $('#albumSource', view);
    if (sel && sel.options.length === 0) {
      const all = document.createElement('option');
      all.value = ''; all.textContent = '全部来源'; sel.append(all);
      for (const s of state.sources) {
        const o = document.createElement('option');
        o.value = s.id; o.textContent = s.label; sel.append(o);
      }
    }
    renderGrid(append);
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

  delegate($('#albumGrid', view), 'click', '.album-card', (_ev, card) => {
    const it = state.items.find((x) => x.id === card.dataset.id);
    if (it) openModal(it);
  });
  $('#albumModalClose', view)?.addEventListener('click', closeModal);
  $('#albumModal', view)?.addEventListener('click', (ev) => { if (ev.target.id === 'albumModal') closeModal(); });
  $('#albumModalSave', view)?.addEventListener('click', async () => {
    const modal = $('#albumModal', view);
    const r = await api('api/album', 'PATCH', {
      source: modal.dataset.source,
      file: modal.dataset.file,
      notes: $('#albumModalNotes', view).value,
      tags: $('#albumModalTags', view).value
    }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#albumMsg', view), r.ok ? '✅ 已保存' : ('❌ ' + (r.error || '失败')));
    if (r.ok) { closeModal(); await load(); }
  });
  $('#albumModalDelete', view)?.addEventListener('click', async () => {
    const modal = $('#albumModal', view);
    if (!confirmDanger(`删除这张图？\n${modal.dataset.file}\n（先进回收站 state/album-trash，可还原）`)) return;
    const r = await api('api/album/delete', 'POST', { source: modal.dataset.source, file: modal.dataset.file }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#albumMsg', view), r.ok ? '✅ 已移入回收站' : ('❌ ' + (r.error || '失败')));
    if (r.ok) { closeModal(); await load(); }
  });
  $('#albumMore', view)?.addEventListener('click', () => load({ append: true }));
  $('#albumSource', view)?.addEventListener('change', (ev) => { state.source = ev.target.value; load(); });
  $('#albumSearch', view)?.addEventListener('input', debounce((ev) => { state.q = ev.target.value.trim(); load(); }, 350));
  $('#albumRescan', view)?.addEventListener('click', async () => {
    const r = await api('api/album/rescan', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#albumMsg', view), r.ok ? `✅ 重扫完成：${r.count} 张 / ${fmtBytes(r.bytes)}` : ('❌ ' + (r.error || '失败')));
    await load();
  });

  await load();
  return () => {};
}
