// AI 记忆（10）：把散在各状态文件里的「AI 记住的东西」收成一个可管理的总入口。
//
// 为什么要单独一个分区：记忆不是一个文件，而是七类——
// 会话记忆（话题/想法/印象，注入提示词）、群成员备注、对话上下文与转录、
// 黑话库、群知识库、收藏表情笔记、DSH 侧长期记忆文件。
// 三代控制台里它们分别藏在「二代仿真 → 轻量记忆」和另外两个分区里，清记忆只能靠 forget-user.sh；
// 这个视图补上三件事：一眼看清每类多少条/吃多少 token、逐条改删、以及**钉住 + 备份回滚**。
//
// 后端：src/memory-admin.js（清单/增删/自然遗忘/钉住/备份回滚）+ bridge.js 的 /api/memory*。
import { api } from '../core/api.js';
import { $, esc, toast, setMsg, confirmDanger, fmtClock, fmtDuration } from '../core/dom.js';
import { mountFragment } from '../core/fragments.js';

export const id = 'memory';
export const title = 'AI 记忆';
export const desc = '它记住了什么：七类记忆的清单、逐条增删、自然遗忘、钉住保护、备份回滚';
export const icon = '🧷';
export const group = '语料';
export const order = 4;

// 列表用的种类表。keep = 这类记忆是否「值得留着」的默认判断（空备注/空含义的候选会标灰）。
// 注意：这里不要出现「某个键的值写成 'foo'」这种形状的字段——test-console-views.mjs 会把
// `键: '值'` 当成「片段里必须存在同名元素」来校验，写进来就会误报。
const KINDS = {
  lightTopic: { label: '进行中的话题', icon: '📌' },
  lightThought: { label: '想说没说的话', icon: '💭' },
  impression: { label: '对群友的印象', icon: '👤' },
  remark: { label: '群成员备注', icon: '🏷️' },
  context: { label: '对话上下文', icon: '💬' },
  slang: { label: '黑话词条', icon: '🗣️' },
  knowledge: { label: '知识库条目', icon: '🧠' },
  stickerNote: { label: '表情笔记', icon: '😼' }
};
const KIND_ORDER = ['lightTopic', 'lightThought', 'impression', 'remark', 'context', 'slang', 'knowledge', 'stickerNote'];

const state = {
  view: null,
  kind: 'lightTopic',
  items: [],
  inventory: null,
  conversations: [],
  backups: [],
  selected: new Set(),
  keyFilter: ''
};

const money = (n) => Number(n) || 0;

function fmtAgo(ts) {
  const n = Number(ts);
  if (!n) return '-';
  const diff = Date.now() - n;
  if (diff < 0) return '将来';
  return fmtDuration(diff) + '前';
}

function statText(s) {
  if (!s) return '';
  return `${money(s.items)} 条 / 约 ${money(s.tokens)} token`;
}

function setMemMsg(text, ok = true) { setMsg($('#memMsg', state.view), text, ok); }

// ── 渲染：记忆构成 ───────────────────────────────────────────────────
function renderGroups() {
  const box = $('#memGroups', state.view);
  const inv = state.inventory;
  if (!box) return;
  if (!inv) { box.innerHTML = '<div class="meta">（清单加载失败）</div>'; return; }
  const rows = inv.groups.map((g) => {
    const parts = Object.entries(g.stats || {})
      .filter(([, v]) => v && (v.items || v.raw))
      .map(([k, v]) => {
        const label = { topics: '话题', thoughts: '想法', impressions: '印象', remarks: '备注', messages: '消息', sessions: '会话', confirmed: '已生效', candidate: '待确认', rejected: '已拒绝', stickers: '表情', notes: '有笔记', file: '文件' }[k] || k;
        return `${label} ${money(v.raw ?? v.items)}`;
      });
    const inject = g.inject === 'inject' ? '<span class="pill r">注入提示词</span>'
      : g.inject === 'search' ? '<span class="pill b">检索注入</span>'
        : '<span class="pill g">AI 主动查</span>';
    const scope = g.scope === 'per-session' ? '<span class="pill">按会话</span>'
      : g.scope === 'global' ? '<span class="pill">全局</span>' : '<span class="pill">混合</span>';
    return `<div class="mem-group" style="padding:6px 4px;border-bottom:1px solid var(--line)">
      <div><b>${esc(g.title)}</b> ${inject} ${scope} <span class="meta">共 ${money(g.total?.items)} 条 · 约 ${money(g.total?.tokens)} token</span></div>
      <div class="meta">${esc(g.note || '')}</div>
      <div class="meta">${esc(parts.join(' · ') || '（空）')} ${g.id === 'longterm' && inv.agents?.exists ? `· <code>${esc(inv.agents.path)}</code>（${money(inv.agents.lines)} 行，桥接不代管）` : ''}</div>
    </div>`;
  }).join('');
  box.innerHTML = rows;
  const summary = $('#memSummary', state.view);
  if (summary) {
    summary.innerHTML = [
      `七类记忆 · 钉住 <b>${money(inv.pins?.total)}</b> 条`,
      `每次唤醒注入约 <b>${money(inv.tokens?.injectedPerWake)}</b> token`,
      `可检索约 <b>${money(inv.tokens?.searchable)}</b> token`,
      `<span class="meta">${esc(inv.tokens?.note || '')}</span>`
    ].join(' · ');
  }
}

// ── 渲染：标签页 + 会话筛选 ──────────────────────────────────────────
function renderTabs() {
  const box = $('#memTabs', state.view);
  if (!box) return;
  box.innerHTML = KIND_ORDER.map((k) => {
    const count = state.kind === k ? state.items.length : '';
    return `<button class="slang-tab${state.kind === k ? ' active' : ''}" data-mem-kind="${k}">${KINDS[k].icon} ${esc(KINDS[k].label)}${count ? `（${count}）` : ''}</button>`;
  }).join('');
}

function renderKeyFilter() {
  const sel = $('#memKeyFilter', state.view);
  const preview = $('#memPreviewKey', state.view);
  const keys = state.conversations || [];
  const fill = (node, current, placeholder) => {
    if (!node) return;
    node.innerHTML = `<option value="">${esc(placeholder)}</option>` + keys.map((k) => `<option value="${esc(k.key)}">${esc(k.key)}（话题 ${k.topics} · 备注 ${k.remarks}）</option>`).join('');
    node.value = current;
  };
  fill(sel, state.keyFilter, '全部会话');
  fill(preview, $('#memPreviewKey', state.view)?.value || '', '活跃的会话');
}

// ── 渲染：条目列表 ───────────────────────────────────────────────────
function contentCell(it) {
  if (it.kind === 'lightTopic') {
    return `<b>${esc(it.text)}</b>${it.pendingQuestion ? `<div class="meta">待追问：${esc(it.pendingQuestion)}</div>` : ''}${it.participants?.length ? `<div class="meta">参与者：${esc(it.participants.join('、'))}</div>` : ''}`;
  }
  if (it.kind === 'lightThought') {
    return `<b>${esc(it.text)}</b>${it.motivation ? `<div class="meta">动机：${esc(it.motivation)}</div>` : ''}${it.expiresAt ? `<div class="meta">${Date.now() >= it.expiresAt ? '<span class="err">已过期</span>' : `过期于 ${esc(fmtClock(it.expiresAt))}`}</div>` : ''}`;
  }
  if (it.kind === 'impression') {
    return `<b>${esc(it.id)}</b><div class="meta">${esc(it.traits?.join('、') || '（暂无标签）')} · 互动 ${money(it.interactionCount)} 次</div>`;
  }
  if (it.kind === 'remark') {
    return `<b>${esc(it.remark || '（未命名）')}</b> <span class="meta">QQ ${esc(it.id)}</span>${it.nick ? `<div class="meta">昵称/名片：${esc(it.nick)}</div>` : ''}${it.note ? `<div>${esc(it.note)}</div>` : ''}`;
  }
  if (it.kind === 'context') {
    return `${it.unread ? '<span class="pill b">未读</span> ' : ''}${it.isSelf ? '<span class="pill g">自己</span> ' : ''}${esc(it.text || '（无文本）')}<div class="meta">${esc(it.sender || '')} · ${esc(fmtClock(it.at))}</div>`;
  }
  if (it.kind === 'slang') {
    const pill = it.status === 'confirmed' ? '<span class="pill g">已确认</span>' : it.status === 'candidate' ? '<span class="pill b">候选</span>' : '<span class="pill r">已拒绝</span>';
    return `${pill} <b>${esc(it.text)}</b><div>${esc(it.meaning || '（还没有含义）')}</div>${it.usage ? `<div class="meta">用法：${esc(it.usage)}</div>` : ''}`;
  }
  if (it.kind === 'knowledge') {
    const pill = it.status === 'confirmed' ? '<span class="pill g">生效中</span>' : it.status === 'candidate' ? '<span class="pill b">待确认</span>' : '<span class="pill r">已停用</span>';
    return `${pill}${it.conflict ? ' <span class="pill r">冲突待裁定</span>' : ''} <b>${esc(it.text)}</b><div>${esc(it.answer || '（无答案）')}</div><div class="meta">被问 ${money(it.hitCount)} 次${it.revision ? ` · 改过 ${money(it.revision)} 次` : ''}</div>`;
  }
  if (it.kind === 'stickerNote') {
    return `<b>${esc(it.note || '（还没有本地笔记）')}</b><div class="meta">QQ 备注：${esc(it.desc || '无')}${it.tags?.length ? ` · 标签：${esc(it.tags.join('、'))}` : ''}</div>${it.usage ? `<div class="meta">用法：${esc(it.usage)}</div>` : ''}<div class="meta">用过 ${money(it.useCount)} 次${it.at ? ` · 最后 ${esc(fmtAgo(it.at))}` : ''}</div>`;
  }
  return esc(it.text || '');
}

function renderList() {
  const box = $('#memList', state.view);
  if (!box) return;
  const list = state.items || [];
  if (!list.length) {
    box.innerHTML = `<div class="meta" style="padding:8px">这一类${state.keyFilter ? `（会话 ${esc(state.keyFilter)}）` : ''}没有记忆条目。${state.kind === 'context' ? '（对话上下文只在桥接运行、且该会话有过消息时才存在）' : ''}</div>`;
    return;
  }
  let html = `<div class="meta" style="padding:6px 2px">共 ${list.length} 条${list.length > 200 ? '（只渲染前 200 条，用搜索缩小范围）' : ''}</div>`;
  html += '<table><tr><th>选</th><th>内容</th><th>位置 / 时间</th><th>操作</th></tr>';
  for (const it of list.slice(0, 200)) {
    const checked = state.selected.has(`${it.key}|${it.id}`) ? ' checked' : '';
    const rowKey = esc(`${it.key}|${it.id}`);
    html += `<tr>
      <td><input type="checkbox" data-mem-select="${rowKey}"${checked}></td>
      <td>${it.pinned ? '<span class="pill r">钉住</span> ' : ''}${contentCell(it)}</td>
      <td class="meta">${esc(it.key || '全局')}<br>${esc(it.at ? fmtAgo(it.at) : '-')}</td>
      <td class="row">
        <button class="small" data-mem-pin="${rowKey}">${it.pinned ? '取消钉住' : '钉住'}</button>
        <button class="small danger" data-mem-del="${rowKey}">忘掉</button>
      </td>
    </tr>`;
  }
  box.innerHTML = html + '</table>';
}

// ── 渲染：备份列表 ───────────────────────────────────────────────────
function renderBackups() {
  const box = $('#memBackups', state.view);
  if (!box) return;
  const list = state.backups || [];
  if (!list.length) { box.innerHTML = '<div class="meta">还没有备份。点上面的「立即备份」可以手动存一份。</div>'; return; }
  let html = '<table><tr><th>备份</th><th>内容</th><th>原因</th><th>大小</th><th>操作</th></tr>';
  for (const b of list) {
    html += `<tr>
      <td><code>${esc(b.name)}</code><div class="meta">${esc(b.createdAt ? fmtClock(b.createdAt) : '')}</div></td>
      <td class="meta">${esc((b.files || []).map((f) => f.label || f.file).join('、') || '（无可识别状态文件）')}</td>
      <td class="meta">${esc(b.reason || '')}</td>
      <td class="meta">${(money(b.bytes) / 1024).toFixed(1)} KB</td>
      <td class="row">
        ${b.restorable ? `<button class="small danger" data-mem-restore="${esc(b.name)}">回滚到这份</button>` : '<span class="meta">不可回滚</span>'}
      </td>
    </tr>`;
  }
  box.innerHTML = html + '</table>';
}

// ── 渲染：注入预览 ───────────────────────────────────────────────────
function renderPreview(data) {
  const box = $('#memPreview', state.view);
  if (!box) return;
  if (!data || !data.ok) { box.innerHTML = '<div class="meta">预览加载失败</div>'; return; }
  const blocks = data.blocks || [];
  if (!blocks.length) { box.innerHTML = '<div class="meta">这个会话当前没有任何会被注入的记忆。</div>'; return; }
  box.innerHTML = `<div class="meta" style="padding:6px 2px">合计 ${money(data.totalChars)} 字 ≈ ${money(data.totalTokens)} token（${blocks.length} 个会话）</div>`
    + blocks.map((b) => `<div style="padding:6px 2px;border-bottom:1px solid var(--line)">
        <div><b>${esc(b.key)}</b> <span class="meta">${money(b.chars)} 字 ≈ ${money(b.tokens)} token · 成员备注 ${money(b.remarkCount)} 条（不注入）</span></div>
        <pre style="white-space:pre-wrap;margin:4px 0">${esc(b.text || '（这个会话没有可注入的记忆）')}</pre>
      </div>`).join('');
}

// ── 数据加载 ─────────────────────────────────────────────────────────
async function loadInventory() {
  const inv = await api('/api/memory').catch(() => null);
  if (!inv || !inv.ok) { setMemMsg('清单加载失败', false); return; }
  state.inventory = inv;
  state.conversations = inv.conversations || [];
  renderGroups();
  renderKeyFilter();
}

async function loadItems() {
  const q = String($('#memSearch', state.view)?.value || '').trim();
  const limit = Number($('#memLimit', state.view)?.value) || 300;
  const params = new URLSearchParams({ kind: state.kind, limit: String(limit) });
  if (state.keyFilter) params.set('key', state.keyFilter);
  if (q) params.set('q', q);
  const r = await api(`/api/memory/items?${params.toString()}`).catch(() => null);
  if (!r || !r.ok) { setMemMsg('条目加载失败', false); return; }
  state.items = r.items || [];
  state.selected.clear();
  renderTabs();
  renderList();
  setMemMsg(`已加载 ${state.items.length} 条「${KINDS[state.kind].label}」`, true);
}

async function loadBackups() {
  const r = await api('/api/memory/backups').catch(() => null);
  if (!r || !r.ok) return;
  state.backups = r.backups || [];
  renderBackups();
}

async function loadPreview() {
  const key = String($('#memPreviewKey', state.view)?.value || '').trim();
  const r = await api(`/api/memory/preview${key ? `?keys=${encodeURIComponent(key)}` : ''}`).catch(() => null);
  renderPreview(r);
  setMsg($('#memPreviewMsg', state.view), r?.ok ? `合计约 ${money(r.totalTokens)} token` : '预览失败', !!r?.ok);
}

async function refreshAll() {
  await loadInventory();
  await loadItems();
  await loadBackups();
  await loadPreview();
}

async function pinOne(it, pinned) {
  // pinId 是后端给的稳定标识（话题/想法用下标，其余用 id）：用原文当钥匙会在文本被改写后失配。
  const r = await api('/api/memory/pin', 'POST', {
    kind: it.kind, key: it.key || '', id: it.pinId || it.id, pinned, reason: '控制台'
  }).catch((e) => ({ ok: false, error: e.message }));
  if (!r.ok) { setMemMsg('❌ ' + (r.error || '操作失败'), false); return false; }
  return true;
}

// 选中集合 ⇄ 条目：选中键是 `会话key|条目标识`，删/钉的时候按当前列表还原成完整参数。
function itemOf(rowKey) {
  return state.items.find((it) => `${it.key}|${it.id}` === rowKey) || null;
}

async function removeOne(it) {
  return api('/api/memory/remove', 'POST', {
    kind: it.kind, key: it.key || '', id: it.id, id2: it.id2 || ''
  }).catch((e) => ({ ok: false, error: e.message }));
}

export async function mount(root) {
  const view = await mountFragment(root, 'memory');
  state.view = view;
  state.selected.clear();

  // 标签页 / 行内按钮 / 复选框统一委托，避免几十个 addEventListener
  view.addEventListener('click', async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const tab = t.closest('[data-mem-kind]');
    if (tab) {
      state.kind = tab.dataset.memKind;
      await loadItems();
      return;
    }
    const pin = t.closest('[data-mem-pin]');
    if (pin) {
      const it = itemOf(pin.dataset.memPin);
      if (!it) return;
      if (await pinOne(it, !it.pinned)) { await loadItems(); await loadInventory(); }
      return;
    }
    const del = t.closest('[data-mem-del]');
    if (del) {
      const it = itemOf(del.dataset.memDel);
      if (!it) return;
      // 逐条删除是「你点名要删这一条」：不受钉住保护（钉住保护的是清空/自然遗忘的批量动作）。
      if (!confirmDanger(`忘掉这一条？\n\n${String(it.text || it.id).slice(0, 80)}\n\n（删了就真没了；想留着的先「钉住」，钉住能挡住批量清空，但挡不住你现在这一次点名删除）`)) return;
      const r = await removeOne(it);
      setMemMsg(r.ok ? `✅ 已忘掉 ${money(r.removed)} 条` : ('❌ ' + (r.error || '失败')), r.ok);
      if (r.ok) { await loadItems(); await loadInventory(); }
      return;
    }
    const restore = t.closest('[data-mem-restore]');
    if (restore) {
      const name = restore.dataset.memRestore;
      if (!confirmDanger(`回滚到备份 ${name}？\n\n会覆盖：轻量记忆/对话上下文、成员备注、黑话库、知识库、表情笔记。\n回滚前会自动给「当前状态」再打一份备份，所以这次回滚本身也能再回滚。`)) return;
      setMsg($('#memBackupMsg', view), '回滚中…', true);
      const r = await api('/api/memory/restore', 'POST', { name }).catch((err) => ({ ok: false, error: err.message }));
      setMsg($('#memBackupMsg', view), r.ok ? `✅ 已回滚：${(r.restored || []).join('、')}（当前状态的备份：${r.safetyBackup}）` : ('❌ ' + (r.error || '失败')), r.ok);
      if (r.ok) await refreshAll();
    }
  });

  $('#memRefresh', view).addEventListener('click', refreshAll);
  $('#memSearch', view).addEventListener('keydown', (e) => { if (e.key === 'Enter') loadItems(); });
  $('#memLimit', view).addEventListener('change', loadItems);
  $('#memKeyFilter', view).addEventListener('change', () => {
    state.keyFilter = $('#memKeyFilter', view).value;
    loadItems();
  });

  view.addEventListener('change', (e) => {
    const cb = e.target instanceof Element ? e.target.closest('[data-mem-select]') : null;
    if (!cb) return;
    if (cb.checked) state.selected.add(cb.dataset.memSelect);
    else state.selected.delete(cb.dataset.memSelect);
  });

  const selectedItems = () => [...state.selected].map(itemOf).filter(Boolean);

  $('#memPinSelected', view).addEventListener('click', async () => {
    const list = selectedItems();
    if (!list.length) { toast('先勾选要钉住的条目', 'err'); return; }
    for (const it of list) await pinOne(it, true);
    setMemMsg(`✅ 已钉住 ${list.length} 条`, true);
    state.selected.clear();
    await loadItems();
    await loadInventory();
  });

  $('#memUnpinSelected', view).addEventListener('click', async () => {
    const list = selectedItems();
    if (!list.length) { toast('先勾选要取消钉住的条目', 'err'); return; }
    for (const it of list) await pinOne(it, false);
    setMemMsg(`✅ 已取消钉住 ${list.length} 条`, true);
    state.selected.clear();
    await loadItems();
    await loadInventory();
  });

  $('#memDeleteSelected', view).addEventListener('click', async () => {
    const list = selectedItems();
    if (!list.length) { toast('先勾选要忘掉的条目', 'err'); return; }
    const pinnedCount = list.filter((it) => it.pinned).length;
    const warn = pinnedCount ? `\n\n注意：其中 ${pinnedCount} 条是「钉住」的，逐条删除不受钉住保护。` : '';
    if (!confirmDanger(`忘掉选中的 ${list.length} 条记忆？${warn}\n\n（删了就真没了；先把要留的「钉住」再删更稳）`)) return;
    let removed = 0;
    for (const it of list) {
      const r = await removeOne(it);
      if (r?.ok) removed += money(r.removed);
    }
    setMemMsg(`✅ 已忘掉 ${removed} 条`, true);
    state.selected.clear();
    await loadItems();
    await loadInventory();
  });

  $('#memClearKind', view).addEventListener('click', async () => {
    const includePinned = $('#memIncludePinned', view).checked;
    const scope = state.keyFilter ? `会话 ${state.keyFilter} 的` : '全部会话的';
    if (!confirmDanger(`清空${scope}「${KINDS[state.kind].label}」？\n\n${includePinned ? '⚠️ 已勾选「连钉住的一起」，钉住的也会被清掉。' : '钉住的条目会自动保留。'}\n清空前会自动备份，删错了能在下面回滚。`)) return;
    const r = await api('/api/memory/clear', 'POST', {
      kind: state.kind, key: state.keyFilter, includePinned
    }).catch((e) => ({ ok: false, error: e.message }));
    setMemMsg(r.ok
      ? `✅ 清掉 ${money(r.clearedTotal)} 条${money(r.skippedPinned) ? `，保留钉住 ${money(r.skippedPinned)} 条` : ''}${r.backup ? `（备份 ${r.backup}）` : ''}`
      : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) { await loadItems(); await loadInventory(); await loadBackups(); }
  });

  $('#memClearSession', view).addEventListener('click', async () => {
    if (!state.keyFilter) { toast('先在左边选一个会话（「全部会话」不支持整会话清空）', 'err'); return; }
    const includePinned = $('#memIncludePinned', view).checked;
    if (!confirmDanger(`清空 ${state.keyFilter} 的**全部**记忆？\n\n包括：话题、想法、对群友的印象、成员备注、对话上下文/未读。\n${includePinned ? '⚠️ 连钉住的一起清。' : '钉住的条目会自动保留。'}\n\n（黑话库/知识库是全局的，不会被这里清掉；清空前会自动备份。）`)) return;
    const r = await api('/api/memory/clear', 'POST', { kind: 'session', key: state.keyFilter, includePinned }).catch((e) => ({ ok: false, error: e.message }));
    setMemMsg(r.ok
      ? `✅ 清掉 ${money(r.clearedTotal)} 条${money(r.skippedPinned) ? `，保留钉住 ${money(r.skippedPinned)} 条` : ''}（备份 ${r.backup || '无'}）`
      : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) await refreshAll();
  });

  $('#memForget', view).addEventListener('click', async () => {
    const hours = (sel, d) => {
      const v = Number($(sel, view).value);
      return Number.isFinite(v) && v >= 0 ? v * 3600000 : d;
    };
    const days = Number($('#memStickerIdle', view).value);
    const body = {
      key: state.keyFilter || '',
      thoughtTtlMs: hours('#memThoughtTtl', 2 * 3600000),
      topicIdleMs: hours('#memTopicIdle', 24 * 3600000),
      stickerIdleMs: Number.isFinite(days) && days >= 0 ? days * 86400000 : 90 * 86400000
    };
    if (!confirmDanger('按上面的规则自然遗忘？\n\n只清「过期的想法 / 搁置的话题 / 很久没用的表情笔记」，黑话与知识库不会被碰；钉住的一律跳过。动手前会自动备份。')) return;
    setMsg($('#memForgetMsg', view), '执行中…', true);
    const r = await api('/api/memory/forget', 'POST', body).catch((e) => ({ ok: false, error: e.message }));
    const f = r.forgotten || {};
    setMsg($('#memForgetMsg', view),
      r.ok
        ? `✅ 清掉 ${money(r.forgottenTotal)} 条（想法 ${money(f.thoughts)} · 话题 ${money(f.topics)} · 表情笔记 ${money(f.stickerNotes)}）${money(r.skippedPinned) ? `，跳过钉住 ${money(r.skippedPinned)} 条` : ''}`
        : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) await refreshAll();
  });

  $('#memBackup', view).addEventListener('click', async () => {
    const reason = String($('#memBackupReason', view).value || '').trim();
    setMsg($('#memBackupMsg', view), '备份中…', true);
    const r = await api('/api/memory/backup', 'POST', { reason }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#memBackupMsg', view),
      r.ok ? `✅ 已备份：${r.backup?.name}（${(r.backup?.files || []).length} 个文件）` : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) {
      $('#memBackupReason', view).value = '';
      await loadBackups();
    }
  });

  // 手动改过 state/*.json（或想把备份里的某条抠回来）之后，让桥接重新读盘。
  // 不自动做这件事的原因：读盘是「文件覆盖内存」，可能盖掉刚写进内存还没落盘的改动，
  // 所以只在管理员明确点这个按钮（或执行回滚）时才做。
  $('#memReload', view).addEventListener('click', async () => {
    if (!confirmDanger('重新从 state/*.json 读入记忆？\n\n会以磁盘上的文件为准（手工改过的文件这样才生效）。')) return;
    setMsg($('#memBackupMsg', view), '读盘中…', true);
    const r = await api('/api/memory/reload', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#memBackupMsg', view), r.ok ? '✅ 已按磁盘文件重新读入' : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) await refreshAll();
  });

  $('#memPreviewLoad', view).addEventListener('click', loadPreview);
  $('#memPreviewKey', view).addEventListener('change', loadPreview);

  renderTabs();
  await refreshAll();
  return undefined;
}
