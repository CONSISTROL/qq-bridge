// 相册（图片总入口）：把原来「AI 图片」「表情包」两个分区合并成一个。
//
// 后端 /api/album：统一索引聊天收到的图 / AI 发出的图 / 本地图库 / pixiv 抓取 / 视频帧，
// 每条带元数据：添加时间、来源、备注、标签（备注存在 state/album-meta.json，重扫不丢）。
// 删除进回收站（state/album-trash/），不直接抹盘。
import { api } from '../core/api.js';
import { $, esc, setMsg, confirmDanger, delegate, debounce, fmtClock } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

export const title = '相册';
export const desc = '所有图片：聊天收到 · AI 发出 · 图库 · 抓取 · 视频帧';
export const group = '语料';
export const order = 11;

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

export async function mount(root) {
  const view = await mountFragment(root, 'album');
  let state = { sources: [], items: [], stats: { count: 0, bytes: 0, bySource: {} }, source: '', q: '' };

  const render = () => {
    const grid = $('#albumGrid', view);
    const stats = $('#albumStats', view);
    if (stats) {
      const bySrc = Object.entries(state.stats.bySource || {})
        .map(([id, n]) => `${(state.sources.find((s) => s.id === id) || {}).label || id} ${n}`).join(' · ');
      stats.textContent = `共 ${state.stats.count} 张 · ${fmtBytes(state.stats.bytes)}${bySrc ? ' · ' + bySrc : ''}`;
    }
    if (!grid) return;
    grid.textContent = '';
    for (const it of state.items) {
      const card = document.createElement('div');
      card.className = 'album-card';
      card.dataset.id = it.id;
      card.dataset.source = it.source;
      card.dataset.file = it.file;
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = `/api/album/file?source=${encodeURIComponent(it.source)}&file=${encodeURIComponent(it.file)}`;
      img.alt = it.notes || it.file;
      const meta = document.createElement('div');
      meta.className = 'album-meta';
      meta.innerHTML = `<div class="album-notes">${esc(it.notes || it.file)}</div>`
        + `<div class="album-sub">${esc(it.sourceLabel)} · ${fmtBytes(it.bytes)} · ${esc(fmtTime(it.addedAt))}</div>`;
      card.append(img, meta);
      grid.append(card);
    }
  };

  const load = async () => {
    setMsg($('#albumMsg', view), '');
    const params = new URLSearchParams();
    if (state.source) params.set('source', state.source);
    if (state.q) params.set('q', state.q);
    const r = await api('/api/album?' + params.toString(), 'GET').catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { setMsg($('#albumMsg', view), '❌ ' + (r.error || '加载失败')); return; }
    state = { ...state, sources: r.sources || [], items: r.items || [], stats: r.stats || { count: 0, bytes: 0 } };
    const sel = $('#albumSource', view);
    if (sel && sel.options.length === 0) {
      const all = document.createElement('option');
      all.value = '';
      all.textContent = '全部来源';
      sel.append(all);
      for (const s of state.sources) {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.label;
        sel.append(o);
      }
    }
    render();
  };

  delegate($('#albumGrid', view), 'click', '.album-card', async (_ev, card) => {
    const source = card.dataset.source;
    const file = card.dataset.file;
    const item = state.items.find((it) => it.id === card.dataset.id);
    const notes = prompt('备注（会存在相册里，重扫不丢）：', item?.notes || '');
    if (notes === null) return;
    const tags = prompt('标签（逗号分隔，可留空）：', (item?.tags || []).join(', '));
    const r = await api('/api/album', 'PATCH', { source, file, notes, tags: tags ?? '' }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#albumMsg', view), r.ok ? '✅ 已保存备注' : ('❌ ' + (r.error || '失败')));
    if (r.ok) await load();
  });

  delegate($('#albumGrid', view), 'contextmenu', '.album-card', async (ev, card) => {
    ev.preventDefault();
    if (!confirmDanger(`删除这张图？\n${card.dataset.file}\n（会先进回收站 state/album-trash，不直接抹盘）`)) return;
    const r = await api('/api/album/delete', 'POST', { source: card.dataset.source, file: card.dataset.file }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#albumMsg', view), r.ok ? '✅ 已移入回收站' : ('❌ ' + (r.error || '失败')));
    if (r.ok) await load();
  });

  $('#albumSource', view)?.addEventListener('change', (ev) => { state.source = ev.target.value; load(); });
  $('#albumSearch', view)?.addEventListener('input', debounce((ev) => { state.q = ev.target.value.trim(); load(); }, 350));
  $('#albumRescan', view)?.addEventListener('click', async () => {
    const r = await api('/api/album/rescan', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#albumMsg', view), r.ok ? `✅ 重扫完成：${r.count} 张 / ${fmtBytes(r.bytes)}` : ('❌ ' + (r.error || '失败')));
    await load();
  });

  await load();
  return () => {};
}
