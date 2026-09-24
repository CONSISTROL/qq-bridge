// AI 图片（11）：把 AI 从网上抓下来、落在本机磁盘上的图片收成一个可管理的总入口。
//
// 为什么要单独一个分区：本地图库（assets/stickers）、pixiv 抓取样例（state/pixiv-picks）、
// B站视频帧缓存（state/video-cache）以前只有「写」没有「管」——控制台看不到占了多少盘，
// 想删只能进 shell 里 rm。这个视图补上：体积清单、缩略图、逐张删、按来源清空、
// 按时间/容量自然清理，以及**回收站**（删除不直接抹盘，能还原）。
//
// 后端：src/image-admin.js + bridge.js 的 /api/ai-images*（只允许控制台，
// 带 agent token 一律 403——AI 可以看图、发图，但不该能删管理员的图库）。
import { api } from '../core/api.js';
import { $, esc, setMsg, confirmDanger, fmtClock, delegate, debounce } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

export const id = 'images';
export const title = 'AI 图片';
export const desc = 'AI 下载/抓取到本机的图片：体积清单、逐张删、按来源清空、自然清理、回收站还原';
export const icon = '🖼️';
export const group = '语料';
export const order = 5;

const SOURCE_ICONS = { library: '🗂️', pixivPicks: '🎨', videoCache: '🎬', sentImages: '📤' };

const state = {
  view: null,
  inventory: null,
  trash: null,
  backfill: null,
  source: '',
  items: [],
  selected: new Set(),
  q: '',
  sort: 'time',
  limit: 300
};

let backfillTimer = null;

function stopBackfillPoll() {
  if (backfillTimer) { clearInterval(backfillTimer); backfillTimer = null; }
}

function money(n) { return Number(n) || 0; }

function fmtBytes(n) {
  const v = money(n);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtAgo(ts) {
  const t = Number(ts);
  if (!t) return '-';
  const diff = Date.now() - t;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 30 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
  return fmtClock(t);
}

function setImgMsg(text, ok = true) { setMsg($('#imgMsg', state.view), text, ok); }
function setSelMsg(text, ok = true) { setMsg($('#imgSelMsg', state.view), text, ok); }
function setForgetMsg(text, ok = true) { setMsg($('#imgForgetMsg', state.view), text, ok); }
function setTrashMsg(text, ok = true) { setMsg($('#imgTrashMsg', state.view), text, ok); }
function setBackfillMsg(text, ok = true) { setMsg($('#imgBackfillMsg', state.view), text, ok); }

// ── 补抓历史发过的图（后台任务，页面轮询进度）─────────────────────────
function renderBackfill() {
  const b = state.backfill;
  if (!b) return;
  if (b.running) {
    setBackfillMsg(`📥 补抓中 ${money(b.done)}/${money(b.total)}（成功 ${money(b.fetched)} · 失败 ${money(b.failed)} · ${fmtBytes(b.bytes)}）…`, true);
    return;
  }
  if (b.finishedAt) {
    const err = (b.errors || [])[0];
    setBackfillMsg(`补抓结束：成功 ${money(b.fetched)} · 失败 ${money(b.failed)}（${fmtBytes(b.bytes)}）${b.lastError ? `｜${b.lastError}` : ''}${err ? `｜例：${err}` : ''}`, money(b.failed) === 0);
    return;
  }
  setBackfillMsg('', true);
}

async function pollBackfill() {
  const r = await api('/api/ai-images/backfill').catch(() => null);
  if (!r?.ok) return;
  state.backfill = r.backfill;
  renderBackfill();
  if (!r.backfill?.running) {
    stopBackfillPoll();
    await refreshAll({ keepMsg: true });
  }
}

async function startBackfill() {
  if (state.backfill?.running) { await pollBackfill(); return; }
  if (!confirmDanger('从会话记录与桥接日志里找出以前发出去的图片地址，重新下载到本地？\n\n走的是和发图一样的取图链（pixiv 会自己走代理、必要时换档位），后台执行、可能要几分钟；已经存过的会跳过。')) return;
  setBackfillMsg('正在启动补抓…', true);
  const r = await api('/api/ai-images/backfill', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) { setBackfillMsg('❌ ' + (r.error || '启动失败'), false); return; }
  state.backfill = r.backfill;
  renderBackfill();
  stopBackfillPoll();
  backfillTimer = setInterval(() => { pollBackfill(); }, 2500);
}

function currentSource() {
  const inv = state.inventory;
  const ids = (inv?.sources ?? []).map((s) => s.id);
  if (state.source && ids.includes(state.source)) return state.source;
  return ids[0] || state.source || '';
}

// ── 渲染：总览 + 来源列表 ────────────────────────────────────────────
function renderSources() {
  const box = $('#imgSources', state.view);
  const inv = state.inventory;
  if (!box) return;
  if (!inv) { box.innerHTML = '<div class="meta">（清单加载失败）</div>'; return; }
  const active = currentSource();
  const total = inv.totals || {};
  const summary = $('#imgSummary', state.view);
  if (summary) {
    summary.innerHTML = [
      `受管图片 <b>${money(total.count)}</b> 张 · <b>${fmtBytes(total.bytes)}</b>`,
      `回收站 <b>${money(total.trashFiles)}</b> 张 · ${fmtBytes(total.trashBytes)}（${money(total.trashBatches)} 个批次）`,
      `<span class="meta">回收站上限 ${fmtBytes(inv.trash?.maxBytes)}</span>`
    ].join(' · ');
  }
  box.innerHTML = inv.sources.map((s) => {
    const orphan = s.hasIndex ? ` · 未入索引 ${money(s.orphan)}` : '';
    const missing = s.hasIndex && s.missing ? ` · <span class="err">索引失联 ${money(s.missing)}</span>` : '';
    // 「AI 发出去的网络图」多一个按钮：把落盘之前发出去的图从会话记录/桥接日志里捞回来
    const backfill = s.id === 'sentImages'
      ? ' <button class="small" data-img-backfill="1" title="从会话记录与桥接日志里找出以前发出去的图片地址，重新下载到本地">补抓历史发过的图</button>'
      : '';
    return `<div data-img-source="${esc(s.id)}" style="padding:6px 4px;border-bottom:1px solid var(--line);cursor:pointer;${s.id === active ? 'background:var(--hover-subtle);' : ''}">
      <div>${SOURCE_ICONS[s.id] || '🖼️'} <b>${esc(s.title)}</b>
        <span class="pill${s.count ? ' b' : ''}">${money(s.count)} 张 / ${fmtBytes(s.bytes)}</span>
        ${s.exists ? '' : '<span class="pill r">目录不存在</span>'}
        ${s.id === active ? '<span class="pill g">当前查看</span>' : ''}${backfill}
      </div>
      <div class="meta">${esc(s.note || '')}</div>
      <div class="meta"><code>${esc(s.dir)}</code>${orphan}${missing}${s.count ? ` · 最近 ${esc(fmtAgo(s.newestAt))}` : ''}</div>
    </div>`;
  }).join('');
}

// ── 渲染：图片网格 ───────────────────────────────────────────────────
function renderList() {
  const box = $('#imgList', state.view);
  if (!box) return;
  const list = state.items || [];
  const src = (state.inventory?.sources ?? []).find((s) => s.id === currentSource());
  if (!list.length) {
    box.innerHTML = `<div class="meta" style="padding:8px">${esc(src?.title || '这个来源')}里没有图片${state.q ? `（搜索：${esc(state.q)}）` : ''}。</div>`;
    return;
  }
  const head = `<div class="meta" style="padding:6px 2px">${esc(src?.title || '')} · 共 ${money(list.length)} 张${list.length > 200 ? '（只渲染前 200 张，用搜索缩小范围）' : ''}${state.selected.size ? ` · 已选 ${state.selected.size} 张` : ''}</div>`;
  const cells = list.slice(0, 200).map((it) => {
    const checked = state.selected.has(it.name);
    const title = it.title || it.name;
    const extra = [it.origin, it.url].filter(Boolean).join(' · ');
    return `<div class="img-cell${checked ? ' sel' : ''}">
      <a href="${esc(it.thumb)}" target="_blank" rel="noopener"><img class="img-thumb" src="${esc(it.thumb)}" loading="lazy" alt="${esc(it.name)}"></a>
      <div class="img-title" title="${esc(title)}">${esc(title)}</div>
      <div class="img-meta">${esc(it.name)}</div>
      <div class="img-meta">${fmtBytes(it.bytes)} · ${esc(fmtAgo(it.mtime))}${it.width && it.height ? ` · ${money(it.width)}×${money(it.height)}` : ''}${it.indexed ? '' : ' · 未入索引'}</div>
      ${extra ? `<div class="img-meta" title="${esc(extra)}">${esc(extra.slice(0, 80))}</div>` : ''}
      <div class="img-actions">
        <label><input type="checkbox" data-img-select="${esc(it.name)}"${checked ? ' checked' : ''}> 选中</label>
        <button class="small danger" data-img-del="${esc(it.name)}">删</button>
      </div>
    </div>`;
  }).join('');
  box.innerHTML = head + `<div class="img-grid">${cells}</div>`;
  renderSelMsg();
}

function renderSelMsg() {
  const n = state.selected.size;
  setSelMsg(n ? `已选 ${n} 张` : '未选任何图片', true);
}

// ── 渲染：回收站 ─────────────────────────────────────────────────────
function renderTrash() {
  const box = $('#imgTrash', state.view);
  if (!box) return;
  const data = state.trash;
  if (!data) { box.innerHTML = '<div class="meta">（回收站加载失败）</div>'; return; }
  const batches = data.batches || [];
  if (!batches.length) { box.innerHTML = '<div class="meta">回收站是空的（删掉的图会先放这里，不会被直接抹掉）。</div>'; return; }
  let html = `<div class="meta" style="padding:6px 2px">共 ${batches.length} 个批次 · ${money(data.usage?.files)} 张 · ${fmtBytes(data.usage?.bytes)}</div>`;
  for (const b of batches) {
    html += `<div style="padding:8px 4px;border-bottom:1px solid var(--line)">
      <div><b>${esc(b.stamp)}</b>
        <span class="pill">${money(b.files)} 张 / ${fmtBytes(b.bytes)}</span>
        <span class="meta">${esc(b.at ? fmtClock(b.at) : '-')} · ${esc(b.reason || '')}</span>
        ${b.broken ? '<span class="pill r">manifest 缺失</span>' : ''}
        <button class="small" data-img-restore="${esc(b.stamp)}">还原整批</button>
        <button class="small danger" data-img-purge="${esc(b.stamp)}">彻底删除这批</button>
      </div>
      <div class="meta">${(b.items || []).slice(0, 20).map((it) => `<span class="img-trash-item">${esc(it.name)}（${fmtBytes(it.bytes)}）${it.source ? `<button class="small" data-img-restore-item="${esc(b.stamp)}|${esc(it.source)}|${esc(it.name)}">还原</button>` : '<span class="err">归属未知</span>'}</span>`).join(' ')}${(b.items || []).length > 20 ? ` … 还有 ${money((b.items || []).length - 20)} 张` : ''}</div>
    </div>`;
  }
  box.innerHTML = html;
}

// ── 数据加载 ─────────────────────────────────────────────────────────
async function loadInventory() {
  const r = await api('/api/ai-images').catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) { setImgMsg('❌ ' + (r.error || '读取清单失败'), false); state.inventory = null; renderSources(); return null; }
  state.inventory = r;
  state.source = currentSource();
  renderSources();
  return r;
}

async function loadItems() {
  if (!state.source) { state.items = []; renderList(); return; }
  const r = await api(`/api/ai-images/items?source=${encodeURIComponent(state.source)}&q=${encodeURIComponent(state.q)}&sort=${encodeURIComponent(state.sort)}&limit=${state.limit}`)
    .catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) { state.items = []; setImgMsg('❌ ' + (r.error || '读取图片列表失败'), false); renderList(); return; }
  state.items = r.items || [];
  const names = new Set(state.items.map((it) => it.name));
  for (const name of [...state.selected]) if (!names.has(name)) state.selected.delete(name);
  renderList();
}

async function loadTrash() {
  const r = await api('/api/ai-images/trash').catch((e) => ({ ok: false, error: e.message }));
  state.trash = r.ok ? r : null;
  if (!r.ok) setTrashMsg('❌ ' + (r.error || '读取回收站失败'), false);
  renderTrash();
  return r;
}

async function refreshAll({ keepMsg = false } = {}) {
  if (!keepMsg) setImgMsg('读取中…', true);
  await loadInventory();
  await loadItems();
  await loadTrash();
  if (!keepMsg) setImgMsg('已刷新', true);
}

// ── 动作 ─────────────────────────────────────────────────────────────
async function deleteNames(names) {
  if (!names.length) { setSelMsg('先选几张再删', false); return; }
  if (!confirmDanger(`删除 ${names.length} 张图片？\n\n会先移进回收站（state/image-trash/），可以还原；确认不要了再去回收站彻底删除。`)) return;
  setSelMsg('删除中…', true);
  const r = await api('/api/ai-images/remove', 'POST', { source: state.source, names }).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) { setSelMsg('❌ ' + (r.error || '删除失败'), false); return; }
  const bad = (r.failed || []).length;
  setSelMsg(`✅ 删了 ${(r.removed || []).length} 张 / ${fmtBytes(r.bytes)}${bad ? `，${bad} 张失败` : ''}（回收站 ${r.trash}）`, true);
  state.selected.clear();
  await refreshAll({ keepMsg: true });
}

async function naturalClean() {
  const days = Number($('#imgKeepDays', state.view).value);
  const mb = Number($('#imgMaxTotalMB', state.view).value);
  const all = $('#imgAllSources', state.view).checked;
  const keepDays = Number.isFinite(days) && days > 0 ? days : 0;
  const maxTotalMB = Number.isFinite(mb) && mb > 0 ? mb : 0;
  if (!keepDays && !maxTotalMB) { setForgetMsg('❌ 保留天数和容量上限至少要填一个大于 0 的', false); return; }
  const scope = all ? '所有来源' : (currentSource() || '当前来源');
  if (!confirmDanger(`对「${scope}」执行自然清理？\n\n保留天数：${keepDays || '不启用'}\n总容量上限：${maxTotalMB ? maxTotalMB + ' MB' : '不启用'}\n\n清掉的图进回收站，可以还原。`)) return;
  setForgetMsg('清理中…', true);
  const r = await api('/api/ai-images/forget', 'POST', {
    source: all ? '' : state.source,
    olderThanDays: keepDays,
    maxTotalMB
  }).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) { setForgetMsg('❌ ' + (r.error || '清理失败'), false); return; }
  const f = r.forgotten || {};
  setForgetMsg(`✅ 清掉 ${money(f.files)} 张 / ${fmtBytes(f.bytes)}（太旧 ${money(f.ageDropped)} · 超容量 ${money(f.budgetDropped)}）→ 回收站 ${r.trash || '无'}`, true);
  await refreshAll({ keepMsg: true });
}

// ── 分区挂载 ─────────────────────────────────────────────────────────
export async function mount(root) {
  const view = await mountFragment(root, 'images');
  state.view = view;
  state.selected = new Set();

  const reload = debounce(() => { loadItems(); }, 300);
  $('#imgSearch', view).addEventListener('input', (ev) => { state.q = String(ev.target.value || '').trim(); reload(); });
  $('#imgSort', view).addEventListener('change', (ev) => { state.sort = String(ev.target.value || 'time'); loadItems(); });
  $('#imgLimit', view).addEventListener('change', (ev) => { state.limit = Number(ev.target.value) || 300; loadItems(); });
  $('#imgRefresh', view).addEventListener('click', () => refreshAll());

  delegate(view, 'click', '[data-img-source]', (ev, node) => {
    // 卡片里的按钮（补抓历史）不该顺带切换来源
    if (ev.target instanceof Element && ev.target.closest('button')) return;
    state.source = node.getAttribute('data-img-source') || '';
    state.selected.clear();
    renderSources();
    loadItems();
  });
  delegate(view, 'click', '[data-img-backfill]', (ev) => {
    ev.stopPropagation();
    startBackfill();
  });
  delegate(view, 'change', '[data-img-select]', (ev, node) => {
    const name = node.getAttribute('data-img-select') || '';
    if (node.checked) state.selected.add(name); else state.selected.delete(name);
    node.closest('.img-cell')?.classList.toggle('sel', node.checked);
    renderSelMsg();
  });
  delegate(view, 'click', '[data-img-del]', (ev, node) => {
    deleteNames([node.getAttribute('data-img-del') || '']);
  });

  $('#imgSelectAll', view).addEventListener('click', () => {
    for (const it of state.items.slice(0, 200)) state.selected.add(it.name);
    renderList();
  });
  $('#imgClearSel', view).addEventListener('click', () => { state.selected.clear(); renderList(); });
  $('#imgDelete', view).addEventListener('click', () => deleteNames([...state.selected]));
  $('#imgClearSource', view).addEventListener('click', async () => {
    const src = (state.inventory?.sources ?? []).find((s) => s.id === currentSource());
    const count = money(src?.count);
    if (!count) { setSelMsg('这个来源里没有图片', false); return; }
    if (!confirmDanger(`清空「${src?.title || state.source}」里的全部 ${count} 张图？\n\n整批进回收站（state/image-trash/），可以整批还原。`)) return;
    setSelMsg('清空中…', true);
    const r = await api('/api/ai-images/clear', 'POST', { source: state.source }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { setSelMsg('❌ ' + (r.error || '清空失败'), false); return; }
    setSelMsg(`✅ 清空 ${(r.removed || []).length} 张 / ${fmtBytes(r.bytes)} → 回收站 ${r.trash}`, true);
    state.selected.clear();
    await refreshAll({ keepMsg: true });
  });

  $('#imgForget', view).addEventListener('click', () => naturalClean());
  $('#imgTrashReload', view).addEventListener('click', () => loadTrash());
  $('#imgPurgeAll', view).addEventListener('click', async () => {
    const usage = state.trash?.usage;
    if (!usage?.files) { setTrashMsg('回收站是空的', false); return; }
    if (!confirmDanger(`彻底删除回收站里的 ${money(usage.files)} 张图（${fmtBytes(usage.bytes)}）？\n\n这一步不可逆：文件会真的从磁盘上抹掉，之后无法还原。`)) return;
    setTrashMsg('删除中…', true);
    const r = await api('/api/ai-images/purge', 'POST', { stamp: 'all' }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { setTrashMsg('❌ ' + (r.error || '删除失败'), false); return; }
    setTrashMsg(`✅ 彻底删掉 ${money(r.purged?.files)} 张 / ${fmtBytes(r.purged?.bytes)}`, true);
    await refreshAll({ keepMsg: true });
  });
  delegate(view, 'click', '[data-img-restore]', async (ev, node) => {
    const stamp = node.getAttribute('data-img-restore') || '';
    if (!confirmDanger(`把回收站批次 ${stamp} 整批还原回原目录？\n\n目标目录已有同名文件时会跳过那张，不会覆盖在用的图。`)) return;
    setTrashMsg('还原中…', true);
    const r = await api('/api/ai-images/restore', 'POST', { stamp }).catch((e) => ({ ok: false, error: e.message }));
    setTrashMsg(r.ok ? `✅ 还原 ${(r.restored || []).length} 张${(r.failed || []).length ? `，${r.failed.length} 张失败` : ''}` : ('❌ ' + (r.error || '还原失败')), r.ok);
    await refreshAll({ keepMsg: true });
  });
  delegate(view, 'click', '[data-img-restore-item]', async (ev, node) => {
    const [stamp, source, name] = String(node.getAttribute('data-img-restore-item') || '').split('|');
    if (!stamp || !source || !name) return;
    setTrashMsg('还原中…', true);
    const r = await api('/api/ai-images/restore', 'POST', { stamp, items: [{ source, name }] }).catch((e) => ({ ok: false, error: e.message }));
    setTrashMsg(r.ok ? `✅ 已还原 ${name}` : ('❌ ' + (r.error || (r.failed?.[0]?.error) || '还原失败')), r.ok);
    await refreshAll({ keepMsg: true });
  });
  delegate(view, 'click', '[data-img-purge]', async (ev, node) => {
    const stamp = node.getAttribute('data-img-purge') || '';
    if (!confirmDanger(`彻底删除回收站批次 ${stamp}？\n\n这一步不可逆，文件会真的从磁盘上抹掉。`)) return;
    setTrashMsg('删除中…', true);
    const r = await api('/api/ai-images/purge', 'POST', { stamp }).catch((e) => ({ ok: false, error: e.message }));
    setTrashMsg(r.ok ? `✅ 彻底删掉 ${money(r.purged?.files)} 张` : ('❌ ' + (r.error || '删除失败')), r.ok);
    await refreshAll({ keepMsg: true });
  });

  await refreshAll();
  // 进页面时如果后台正在补抓（或刚跑完），把进度显示出来并继续轮询
  const bf = await api('/api/ai-images/backfill').catch(() => null);
  if (bf?.ok) {
    state.backfill = bf.backfill;
    renderBackfill();
    if (bf.backfill?.running) {
      stopBackfillPoll();
      backfillTimer = setInterval(() => { pollBackfill(); }, 2500);
    }
  }
  return () => { stopBackfillPoll(); };
}
