// 表情包（控制台「表情包」分区）：把 QQ 账号收藏夹同步过来，做成可管理的入口。
//
// 为什么要单独一个分区：AI 发表情包靠的是「备注/标签/笔记能不能对上语境」，而这些以前只能
// 让 AI 自己用 qq_sticker_note 写，管理员在控制台看不见也改不了。这里把 QQ 收藏表情镜像出来：
// 缩略图一眼看全、搜索、同步、逐张编辑两套备注（QQ 官方 desc / 只给 AI 看的本地 localRemark）、
// 置顶、以及从 QQ 收藏里删除。
//
// 后端：bridge.js 的 /api/stickers*（只允许控制台；带 agent token 一律 403——
// AI 可以看图和记笔记，但不该能删管理员的收藏）。
import { api } from '../core/api.js';
import { $, esc, setMsg, confirmDanger, fmtClock, delegate, debounce, resizeTextareas } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

export const id = 'stickers';
export const title = '表情包';
export const desc = '同步 QQ 收藏夹：缩略图、搜索、本地备注（给 AI 看）/ QQ 备注、标签笔记、置顶、删除';
export const icon = '😄';
export const group = '语料';
export const order = 6;

const state = {
  view: null,
  stickers: [],
  total: 0,
  matched: 0,
  truncated: false,
  syncedAt: 0,
  query: '',
  count: 120,
  onlyUnlabeled: false,
  unlabeled: 0,
  autoLabel: true,
  autoLabelPerTurn: 2,
  manualLabelCount: 5,
  current: null,   // 弹窗里正在编辑的那条
  busy: false
};

// 缩略图走桥接代理（相对路径，兼容反代子路径）：QQ 图床会校验 referer/时效，
// 浏览器直连常常 403；而且前端直接引用第三方 URL 等于把「收藏了哪些表情」暴露出去。
function thumbUrl(id) {
  return `api/stickers/image?stickerId=${encodeURIComponent(id)}`;
}

function labelOf(s) {
  return s.localRemark || s.desc || s.localNote || '（无备注）';
}

function fmtAgo(ms) {
  const t = Number(ms) || 0;
  if (!t) return '没用过';
  const diff = Date.now() - t;
  if (diff < 60 * 1000) return '刚刚用过';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前用过`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前用过`;
  return `${fmtClock(t)} 用过`;
}

function renderSummary() {
  const box = $('#stkSummary', state.view);
  if (!box) return;
  const withLocal = state.stickers.filter((s) => s.localRemark).length;
  const withQq = state.stickers.filter((s) => s.desc).length;
  box.innerHTML = [
    `本地库 <b>${state.total}</b> 个收藏表情`,
    `本次显示 <b>${state.matched}</b>${state.truncated ? '（已截断，可搜索或调大显示数）' : ''}`,
    `本地备注 <b>${withLocal}</b> · QQ 备注 <b>${withQq}</b>`,
    // 这是 AI 的欠账：它会在闲聊间隙自己看图补上，补完这里就归零。
    `待补备注 <b>${state.unlabeled}</b>${state.unlabeled
      ? (state.autoLabel ? '（AI 会自己看图补，也可以在这里直接补）' : '（<b>AI 自动补备注已关闭</b>，只能在这里手动补）')
      : ''}`,
    `上次同步 <b>${state.syncedAt ? esc(fmtClock(state.syncedAt)) : '未知'}</b>`
  ].join(' · ');
}

function renderGrid() {
  const grid = $('#stkGrid', state.view);
  const empty = $('#stkEmpty', state.view);
  if (!grid) return;
  if (!state.stickers.length) {
    grid.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  grid.innerHTML = state.stickers.map((s) => {
    const badges = [];
    if (s.localRemark) badges.push('<span class="pill g">本地备注</span>');
    if (s.desc) badges.push('<span class="pill b">QQ 备注</span>');
    if (s.useCount) badges.push(`<span class="pill">用 ${s.useCount}</span>`);
    const meta = [s.desc ? `QQ：${s.desc}` : '', s.tags?.length ? `#${s.tags.join(' #')}` : ''].filter(Boolean).join(' · ');
    return `<div class="stk-cell" data-stk-id="${esc(s.id)}">
      <img loading="lazy" src="${esc(thumbUrl(s.id))}" alt="${esc(labelOf(s))}">
      <div class="stk-name">${esc(labelOf(s))}</div>
      <div class="stk-meta">${esc(meta)}</div>
      <div class="stk-meta">${badges.join(' ')}${s.useCount ? ' · ' + esc(fmtAgo(s.lastUsedAt)) : ''}</div>
    </div>`;
  }).join('');
}

async function load() {
  if (state.busy) return;
  state.busy = true;
  try {
    const q = new URLSearchParams();
    if (state.query) q.set('query', state.query);
    if (state.onlyUnlabeled) q.set('onlyUnlabeled', '1');
    q.set('count', String(state.count));
    const r = await api(`/api/stickers?${q.toString()}`);
    state.stickers = Array.isArray(r.stickers) ? r.stickers : [];
    state.total = Number(r.total) || 0;
    state.matched = Number(r.matched) || state.stickers.length;
    state.unlabeled = Number(r.unlabeled) || 0;
    state.truncated = !!r.truncated;
    state.syncedAt = Number(r.syncedAt) || 0;
    renderSummary();
    renderGrid();
    setMsg($('#stkMsg', state.view), '', true);
  } catch (error) {
    setMsg($('#stkMsg', state.view), '❌ 加载失败：' + error.message, false);
  } finally {
    state.busy = false;
  }
}

async function syncNow() {
  setMsg($('#stkMsg', state.view), '正在从 QQ 拉取收藏表情…', true);
  try {
    const r = await api('/api/stickers/sync', 'POST', {});
    setMsg($('#stkMsg', state.view), `✅ 已同步：QQ 收藏夹共 ${Number(r.total) || 0} 个`, true);
  } catch (error) {
    setMsg($('#stkMsg', state.view), '❌ 同步失败：' + error.message, false);
  }
  await loadLabelConfig();
  await load();
}

// ── 补备注的三个设置（socialData.sticker.autoLabel / autoLabelPerTurn / manualLabelCount）
// 只提交 sticker 里这几个 key：/api/socialData/config 对 sticker 是深合并，不会冲掉 collect/pick。
const LABEL_LIMITS = { autoLabelPerTurn: [1, 6], manualLabelCount: [1, 10] };

function renderLabelControls() {
  const box = $('#stkAutoLabel', state.view);
  if (box) box.checked = state.autoLabel;
  const perTurn = $('#stkAutoLabelPerTurn', state.view);
  if (perTurn && document.activeElement !== perTurn) perTurn.value = String(state.autoLabelPerTurn);
  const manual = $('#stkManualLabelCount', state.view);
  if (manual && document.activeElement !== manual) manual.value = String(state.manualLabelCount);
}

async function loadLabelConfig() {
  try {
    const r = await api('/api/socialData/config');
    const st = r?.config?.sticker ?? {};
    state.autoLabel = st.autoLabel !== false;
    state.autoLabelPerTurn = Number(st.autoLabelPerTurn) || 2;
    state.manualLabelCount = Number(st.manualLabelCount) || 5;
  } catch (e) {
    // 读不到就按默认显示，别把 UI 卡在空值上
    state.autoLabel = true;
    state.autoLabelPerTurn = 2;
    state.manualLabelCount = 5;
  }
  renderLabelControls();
}

/** patch 只带要改的 key；失败时回读一次配置把 UI 拉回真实值。 */
async function saveLabelConfig(patch, okText) {
  const msg = $('#stkAutoLabelMsg', state.view);
  setMsg(msg, '保存中…', true);
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'autoLabel') { clean[k] = v === true; continue; }
    const [min, max] = LABEL_LIMITS[k] ?? [1, 10];
    const n = Number(v);
    clean[k] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : state[k];
  }
  try {
    await api('/api/socialData/config', 'POST', { sticker: clean });
    for (const [k, v] of Object.entries(clean)) state[k] = v;
    renderLabelControls();
    renderSummary();
    if (okText) setMsg(msg, okText, true);
  } catch (error) {
    setMsg(msg, '❌ 保存失败：' + error.message, false);
    await loadLabelConfig(); // 存失败别骗人，按真实配置回滚
  }
}

// 「让 AI 现在补一批」：手动触发一次，不等它在空闲回合自己想起来。
// 后端返回 429 时是冷却中（避免连点往队列里塞重复任务），把提示原样显示出来。
async function labelNow() {
  const btn = $('#stkLabelNow', state.view);
  const msg = $('#stkAutoLabelMsg', state.view);
  if (btn?.disabled) return;
  if (btn) btn.disabled = true;
  setMsg(msg, '已通知 AI，正在补…（要花一两轮，稍后刷新看结果）', true);
  try {
    const r = await api('/api/stickers/autolabel-now', 'POST', { count: state.manualLabelCount });
    if (r?.asked) {
      setMsg(msg, `✅ 已让 AI 去补 ${r.asked} 个（会话 ${r.key}）；补完「待补备注」会自己减少。还剩 ${r.remaining} 个。`, true);
    } else {
      setMsg(msg, '没有待补备注的表情了。', true);
    }
  } catch (error) {
    setMsg(msg, '⚠️ ' + error.message, false);
  } finally {
    // 冷却期按钮先禁用一会儿，跟后端的 30s 冷却对齐，免得用户点了白点
    setTimeout(() => { if (btn) btn.disabled = false; }, 30000);
  }
}

// ── 详情弹窗 ─────────────────────────────────────────────────────────
function openModal(sticker) {
  state.current = sticker;
  $('#stkModalTitle', state.view).textContent = labelOf(sticker);
  $('#stkModalMeta', state.view).innerHTML = [
    `<code>${esc(sticker.id)}</code>`,
    sticker.md5 ? `md5 ${esc(sticker.md5)}` : '',
    sticker.useCount ? `用过 ${sticker.useCount} 次 · ${esc(fmtAgo(sticker.lastUsedAt))}` : '还没用过'
  ].filter(Boolean).join(' · ');
  const img = $('#stkModalImg', state.view);
  if (img) img.src = thumbUrl(sticker.id);
  $('#stkLocalRemark', state.view).value = sticker.localRemark || '';
  $('#stkQqRemark', state.view).value = sticker.desc || '';
  $('#stkTags', state.view).value = (sticker.tags || []).join(', ');
  $('#stkUsage', state.view).value = sticker.usage || '';
  $('#stkNote', state.view).value = sticker.localNote || '';
  setMsg($('#stkModalMsg', state.view), '', true);
  $('#stkModal', state.view).classList.add('open');
  resizeTextareas($('#stkNote', state.view));
  // 打开时顺手把本地库补一次最新值（同步可能在别处发生过）
  $('#stkLocalRemark', state.view).focus();
}

function closeModal() {
  state.current = null;
  $('#stkModal', state.view)?.classList.remove('open');
}

/** 本地认知（只影响桥接/AI，不动 QQ）。 */
async function saveLocal() {
  const cur = state.current;
  if (!cur) return;
  const payload = {
    stickerId: cur.id,
    localRemark: $('#stkLocalRemark', state.view).value.trim(),
    note: $('#stkNote', state.view).value.trim(),
    usage: $('#stkUsage', state.view).value.trim(),
    tags: $('#stkTags', state.view).value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
  };
  setMsg($('#stkModalMsg', state.view), '保存中…', true);
  try {
    const r = await api('/api/stickers/note', 'POST', payload);
    const updated = r.sticker || {};
    // 就地更新，避免整页重排导致弹窗闪一下
    const idx = state.stickers.findIndex((s) => s.id === cur.id);
    if (idx >= 0) state.stickers[idx] = { ...state.stickers[idx], ...updated };
    state.current = { ...cur, ...updated };
    renderSummary();
    renderGrid();
    if (updated.localRemark || updated.desc) $('#stkModalTitle', state.view).textContent = labelOf(state.current);
    setMsg($('#stkModalMsg', state.view), '✅ 本地认知已保存（AI 下次唤醒就能看到）', true);
  } catch (error) {
    setMsg($('#stkModalMsg', state.view), '❌ 保存失败：' + error.message, false);
  }
}

/** QQ 官方备注（改的是 QQ 收藏夹，全 QQ 可见）。 */
async function saveQqRemark() {
  const cur = state.current;
  if (!cur) return;
  const remark = $('#stkQqRemark', state.view).value.trim();
  if (!confirmDanger(`要修改 QQ 收藏夹里这个表情的备注吗？\n\n新备注：「${remark || '（清除备注）'}」\n\n这会写到 QQ 账号上，别的地方也能看到。`)) return;
  setMsg($('#stkModalMsg', state.view), '写入 QQ 中…', true);
  try {
    const r = await api('/api/stickers/remark', 'POST', { stickerId: cur.id, remark });
    const updated = r.sticker || {};
    const idx = state.stickers.findIndex((s) => s.id === cur.id);
    if (idx >= 0) state.stickers[idx] = { ...state.stickers[idx], ...updated };
    state.current = { ...cur, ...updated };
    renderSummary();
    renderGrid();
    $('#stkModalTitle', state.view).textContent = labelOf(state.current);
    setMsg($('#stkModalMsg', state.view), '✅ QQ 备注已更新', true);
  } catch (error) {
    setMsg($('#stkModalMsg', state.view), '❌ 改 QQ 备注失败：' + error.message, false);
  }
}

async function promote() {
  const cur = state.current;
  if (!cur) return;
  setMsg($('#stkModalMsg', state.view), '置顶中…', true);
  try {
    await api('/api/stickers/promote', 'POST', { stickerId: cur.id });
    setMsg($('#stkModalMsg', state.view), '✅ 已置顶到收藏夹最前', true);
    await load();
  } catch (error) {
    setMsg($('#stkModalMsg', state.view), '❌ 置顶失败：' + error.message, false);
  }
}

async function removeFromQq() {
  const cur = state.current;
  if (!cur) return;
  if (!confirmDanger(`要从 QQ 收藏夹里删掉这个表情吗？\n\n${labelOf(cur)}\n\n这一步不可逆：QQ 那边删了就没了（本地笔记也会一起删掉）。`)) return;
  setMsg($('#stkModalMsg', state.view), '删除中…', true);
  try {
    await api('/api/stickers/delete', 'POST', { stickerId: cur.id });
    closeModal();
    await load();
    setMsg($('#stkMsg', state.view), `🗑 已从 QQ 收藏夹删除 ${labelOf(cur)}`, true);
  } catch (error) {
    setMsg($('#stkModalMsg', state.view), '❌ 删除失败：' + error.message, false);
  }
}

export async function mount(root) {
  const view = await mountFragment(root, 'stickers');
  state.view = view;

  const reload = debounce(() => { load(); }, 300);
  $('#stkSearch', view).addEventListener('input', (ev) => {
    state.query = String(ev.target.value || '').trim();
    reload();
  });
  $('#stkCount', view).addEventListener('change', (ev) => {
    state.count = Number(ev.target.value) || 120;
    load();
  });
  $('#stkAutoLabel', view).addEventListener('change', (ev) => {
    const on = !!ev.target.checked;
    saveLabelConfig({ autoLabel: on }, on
      ? `✅ 已开启：它会在没人说话的回合顺手补 ${state.autoLabelPerTurn} 个`
      : '已关闭：不再催它补备注（已经写好的保留）');
  });
  for (const [id, key, unit] of [['stkAutoLabelPerTurn', 'autoLabelPerTurn', '一轮最多'], ['stkManualLabelCount', 'manualLabelCount', '一次']]) {
    $(`#${id}`, view).addEventListener('change', (ev) => {
      const n = Number(ev.target.value);
      saveLabelConfig({ [key]: n }, `✅ ${unit}补 ${Math.max(1, Math.min(LABEL_LIMITS[key][1], Math.round(n) || 1))} 个`);
    });
  }
  $('#stkLabelNow', view).addEventListener('click', () => { labelNow(); });
  $('#stkOnlyUnlabeled', view).addEventListener('change', (ev) => {
    state.onlyUnlabeled = !!ev.target.checked;
    load();
  });
  $('#stkSync', view).addEventListener('click', () => { syncNow(); });
  $('#stkRefresh', view).addEventListener('click', () => { load(); });

  delegate(view, 'click', '[data-stk-id]', (ev, node) => {
    const id = node.dataset.stkId;
    const sticker = state.stickers.find((s) => s.id === id);
    if (sticker) openModal(sticker);
  });

  $('#stkSaveLocal', view).addEventListener('click', () => { saveLocal(); });
  $('#stkSaveQq', view).addEventListener('click', () => { saveQqRemark(); });
  $('#stkPromote', view).addEventListener('click', () => { promote(); });
  $('#stkDelete', view).addEventListener('click', () => { removeFromQq(); });
  $('#stkClose', view).addEventListener('click', closeModal);
  $('#stkModal', view).addEventListener('click', (ev) => { if (ev.target.id === 'stkModal') closeModal(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeModal(); });

  await loadLabelConfig();
  await load();
}
