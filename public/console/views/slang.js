// 黑话库（08）+ 本地向量检索 RAG（08b）
import { api } from '../core/api.js';
import { $, $$, esc, toast, setMsg, confirmDanger, resizeTextareas } from '../core/dom.js';
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
  if (e.source === 'explore') return `主题探索${e.exploredFrom ? `（${e.exploredFrom}）` : ''}`;
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
    // 候选里要分清「还没研究过」和「研究过但没定论」——后者再点研究通常也不会有结果，
    // 以前一律显示「待研究」，看起来像卡住了（实际是研究过了、模型说不确定）。
    const meaning = e.meaning ? esc(e.meaning)
      : (status === 'candidate'
        ? (e.researchVerdict === 'unknown'
          ? `<span class="meta" title="研究过，模型认为拿不准或不是梗；有新的群聊证据时会再研究一次">研究过·无定论</span>`
          : '<span class="meta">待研究</span>')
        : '<span class="meta">无</span>');
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
  resizeTextareas($('#slangModalSources', state.view));
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

// ── 掉线补拉 ─────────────────────────────────────────────────────────
// QQ 掉线/网关抖动期间的消息网关不重发，靠重连后补拉。参数在 config.json 的 socialData.backfill，
// 读写走 /api/socialData/config（**不是** /api/slang/config——那是黑话学习自己的配置）。
function bindBackfillPanel(view) {
  const apply = (c) => {
    const b = c?.backfill ?? {};
    $('#backfillEnabled', view).checked = b.enabled !== false;
    $('#backfillMaxMessages', view).value = b.maxMessages ?? 100;
    $('#backfillWakeMaxMessages', view).value = b.wakeMaxMessages ?? 15;
    $('#backfillWakeMaxAgeMin', view).value = Math.round((b.wakeMaxAgeMs ?? 600000) / 60000);
  };
  // backfill 属于 QQ 消息链（socialData），不是黑话配置——读写都走 /api/socialData/config。
  api('/api/socialData/config').then((r) => apply(r?.config || {})).catch(() => {});

  $('#backfillSave', view).addEventListener('click', async () => {
    const body = {
      backfill: {
        enabled: $('#backfillEnabled', view).checked,
        maxMessages: Number($('#backfillMaxMessages', view).value) || 100,
        wakeMaxMessages: Number($('#backfillWakeMaxMessages', view).value) || 0,
        wakeMaxAgeMs: (Number($('#backfillWakeMaxAgeMin', view).value) || 0) * 60000
      }
    };
    const r = await api('/api/socialData/config', { method: 'POST', body }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    setMsg($('#backfillMsg', view), r && r.ok ? '已保存' : `保存失败：${r?.error || '未知'}`, r && r.ok ? 'ok' : 'bad');
  });

  $('#backfillNow', view).addEventListener('click', async () => {
    setMsg($('#backfillMsg', view), '正在补拉…');
    const r = await api('/api/socialData/backfill', { method: 'POST' }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (!r || !r.ok) setMsg($('#backfillMsg', view), `补拉失败：${r?.error || '未知'}`, 'bad');
    else setMsg($('#backfillMsg', view), `检查 ${r.checked} 个会话，补回 ${r.added} 条，唤醒 ${(r.woken || []).length} 个（${r.note}）`, 'ok');
  });
}

// ── 豆包网页版通道 ───────────────────────────────────────────────────
// 只作梗考究的一路来源：单独一路永不自动转正（护栏在服务端 src/doubao-research.js）。
// 这里管「开关 / 探活 / 扫码登录 / 测试提问」，登录态靠持久 profile 保持。
function renderDoubaoStatus(view, data) {
  const ch = data?.channel || {};
  const bits = [];
  bits.push(data?.enabled ? '<b>已启用</b>' : '已关闭');
  if (ch.running) {
    bits.push(ch.loggedIn === true ? '登录态：已登录' : (ch.loggedIn === false ? '登录态：<b>未登录</b>' : '登录态：未知'));
    if (ch.busy) bits.push('正在处理请求');
  } else {
    bits.push('浏览器未运行（按需启动，空闲自动关闭）');
  }
  bits.push(`内存上限 ${esc(String(ch.memoryMax || data?.config?.memoryMax || '900M'))}`);
  if (ch.profileBytes) bits.push(`profile ${(ch.profileBytes / 1024 / 1024).toFixed(1)}MB`);
  if (ch.systemdRun === false) bits.push('<span style="color:var(--danger)">没有 systemd-run，无法限制内存</span>');
  if (ch.lastError) bits.push(`<span style="color:var(--danger)">最近错误：${esc(String(ch.lastError).slice(0, 120))}</span>`);
  if (data && data.autoConfirmResearched === false) bits.push('（自动转正当前是关闭的：所有研究结果都等人工确认）');
  $('#doubaoStatus', view).innerHTML = bits.join(' ｜ ');
  $('#doubaoEnabled', view).checked = data?.enabled === true;
}

async function loadDoubaoStatus(view) {
  const r = await api('/api/doubao/status').catch(() => null);
  if (!r || !r.ok) { setMsg($('#doubaoMsg', view), '读取豆包通道状态失败', 'bad'); return; }
  renderDoubaoStatus(view, r);
}

function bindDoubaoPanel(view) {
  $('#doubaoEnabled', view).addEventListener('change', async (e) => {
    const on = e.target.checked;
    const r = await api('/api/doubao/config', { method: 'POST', body: { enabled: on } }).catch(() => null);
    if (!r || !r.ok) { setMsg($('#doubaoMsg', view), '保存失败', 'bad'); e.target.checked = !on; return; }
    setMsg($('#doubaoMsg', view), on ? '已启用（下一轮研究生效）' : '已关闭', 'ok');
    loadDoubaoStatus(view);
  });

  $('#doubaoProbe', view).addEventListener('click', async () => {
    setMsg($('#doubaoMsg', view), '正在启动浏览器探活（首次可能要十几秒）…');
    const r = await api('/api/doubao/probe', { method: 'POST' }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (!r || !r.ok) setMsg($('#doubaoMsg', view), `探活失败：${r?.error || '未知'}`, 'bad');
    else setMsg($('#doubaoMsg', view), r.loggedIn ? '通道正常，已登录' : '通道能打开，但**未登录**（点「扫码登录」）', r.loggedIn ? 'ok' : 'bad');
    loadDoubaoStatus(view);
  });

  $('#doubaoLogin', view).addEventListener('click', async () => {
    setMsg($('#doubaoMsg', view), '正在打开登录框取二维码…');
    const r = await api('/api/doubao/login', { method: 'POST' }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (!r || !r.ok) {
      setMsg($('#doubaoMsg', view), `取二维码失败：${r?.error || '未知'}`, 'bad');
      return;
    }
    if (r.alreadyLoggedIn) {
      setMsg($('#doubaoMsg', view), '已经是登录状态，不用扫', 'ok');
      loadDoubaoStatus(view);
      return;
    }
    $('#doubaoQr', view).src = 'data:image/png;base64,' + r.qr;
    $('#doubaoQrWrap', view).style.display = 'block';
    setMsg($('#doubaoMsg', view), '请用手机豆包 / 飞书 App 扫码，扫完自动检测…');
    const w = await api('/api/doubao/login-wait', { method: 'POST', body: { timeoutMs: 180000 } }).catch(() => null);
    if (w && w.loggedIn) {
      setMsg($('#doubaoMsg', view), '登录成功，登录态已保存', 'ok');
      $('#doubaoQrWrap', view).style.display = 'none';
    } else {
      setMsg($('#doubaoMsg', view), '还没检测到登录（二维码会过期，可以再点一次「扫码登录」）', 'bad');
    }
    loadDoubaoStatus(view);
  });

  $('#doubaoStop', view).addEventListener('click', async () => {
    await api('/api/doubao/stop', { method: 'POST' }).catch(() => null);
    setMsg($('#doubaoMsg', view), '已关闭浏览器（登录态保留，下次按需重启）', 'ok');
    $('#doubaoQrWrap', view).style.display = 'none';
    loadDoubaoStatus(view);
  });

  $('#doubaoAsk', view).addEventListener('click', async () => {
    const prompt = $('#doubaoAskPrompt', view).value.trim();
    if (!prompt) { setMsg($('#doubaoMsg', view), '先输入要问的内容', 'bad'); return; }
    setMsg($('#doubaoMsg', view), '已发送，等回答…');
    $('#doubaoAskOut', view).textContent = '';
    const r = await api('/api/doubao/ask', { method: 'POST', body: { prompt } }).catch((err) => ({ ok: false, error: String(err?.message || err) }));
    if (!r || !r.ok) setMsg($('#doubaoMsg', view), `提问失败：${r?.error || '未知'}`, 'bad');
    else {
      setMsg($('#doubaoMsg', view), '收到回答', 'ok');
      $('#doubaoAskOut', view).textContent = r.answer || '(空回答)';
    }
    loadDoubaoStatus(view);
  });
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
  const triggerResearch = async (force) => {
    if (force && !confirmDanger('强制重研会把全部候选重新研究一遍（包括已经研究过、结论是「拿不准/不是梗」的），会明显消耗额度。继续？')) return;
    const r = await api('/api/slang/research', 'POST', force ? { force: true } : {}).catch((e) => ({ ok: false, error: e.message }));
    setSlangMsg(r.ok ? ('✅ 已触发研究 ' + r.count + ' 条') : ('❌ ' + (r.error || '失败')), r.ok);
  };
  $('#slangResearch', view).addEventListener('click', () => triggerResearch(false));
  $('#slangResearchForce', view)?.addEventListener('click', () => triggerResearch(true));

  // ── 主题探索（自主扩展学习）──────────────────────────────────────────
  // 给一个种子关键词，AI 在后台独立会话里联网把这一圈的梗和关联主题学回来。
  const renderExploreJobs = (data) => {
    const box = $('#exploreJobs', view);
    if (!box) return;
    const jobs = data?.jobs ?? [];
    if (!jobs.length) {
      box.innerHTML = '<div class="meta" style="padding:8px">还没有探索任务。上面输入一个关键词（例如 <code>mygo</code>）就能开始。</div>';
      return;
    }
    const statusLabel = { pending: '排队中', running: '挖掘中', done: '✅ 已完成', stopped: '⏹ 已停止', failed: '❌ 失败' };
    box.innerHTML = jobs.map((j) => {
      const visited = (j.visited ?? []).map((v) =>
        `<div style="margin-left:10px">· <b>${esc(v.name)}</b>`
        + `${v.kind ? ` <span class="meta">(${esc(v.kind)})</span>` : ''}`
        + `${v.terms?.length ? ` <span class="meta">梗 ${v.terms.length}：${esc(v.terms.slice(0, 4).join('、'))}${v.terms.length > 4 ? '…' : ''}</span>` : ''}`
        + `${v.related?.length ? `<div class="meta" style="margin-left:12px">→ 关联：${esc(v.related.slice(0, 6).join('、'))}</div>` : ''}`
        + `</div>`).join('');
      const queued = (j.queue ?? []).length
        ? `<div class="meta" style="margin-left:10px">队列中还有 ${j.queue.length} 个：${esc(j.queue.slice(0, 6).map((t) => t.name).join('、'))}${j.queue.length > 6 ? '…' : ''}</div>`
        : '';
      const acts = (j.status === 'running' || j.status === 'pending')
        ? ` <button class="small" data-explore-stop="${esc(j.id)}">停止</button>` : '';
      const lastLog = (j.log ?? []).slice(-1)[0];
      return `<div style="padding:8px;border-bottom:1px solid rgba(128,128,128,.2)">
        <div><b>${esc(j.seed)}</b> <span class="meta">${statusLabel[j.status] ?? j.status}</span>`
        + ` <span class="meta">｜已探 ${j.stats?.topics ?? 0}/${j.maxTopics} 个主题｜梗 ${j.stats?.terms ?? 0} 条（确认 ${j.stats?.confirmed ?? 0}）`
        + `${j.stats?.failed ? `｜失败 ${j.stats.failed}` : ''}｜${j.maxDepth} 层</span>${acts}</div>
        ${j.error ? `<div class="meta" style="color:#c66">${esc(j.error)}</div>` : ''}
        ${visited}${queued}
        ${lastLog ? `<div class="meta" style="margin-top:2px">最新：${esc(lastLog.text)}</div>` : ''}
      </div>`;
    }).join('');
  };
  const loadExploreJobs = async () => {
    const data = await api('/api/socialData/explore-jobs').catch(() => null);
    if (data?.ok) renderExploreJobs(data);
    return data;
  };
  $('#exploreStart', view)?.addEventListener('click', async () => {
    const seed = $('#exploreSeed', view).value.trim();
    if (!seed) { toast('先填个关键词', 'err'); return; }
    const msg = $('#exploreMsg', view);
    const maxTopics = Number($('#exploreMaxTopics', view).value) || undefined;
    const maxDepthRaw = $('#exploreMaxDepth', view).value;
    const maxDepth = maxDepthRaw === '' ? undefined : Number(maxDepthRaw);
    setSlangMsg('发起中…');
    const r = await api('/api/socialData/explore-topic', 'POST', { seed, maxTopics, maxDepth }).catch((e) => ({ ok: false, error: e.message }));
    if (r.ok) {
      $('#exploreSeed', view).value = '';
      if (msg) { msg.textContent = `✅ 已开始探索「${seed}」：${r.progress ?? ''}`; msg.style.color = ''; }
      loadExploreJobs();
    } else if (msg) {
      msg.textContent = '❌ ' + (r.error || '发起失败');
      msg.style.color = '#c66';
    }
  });
  $('#exploreRefresh', view)?.addEventListener('click', () => loadExploreJobs());
  // 停止：用事件委托（任务是动态渲染的）
  $('#exploreJobs', view)?.addEventListener('click', async (e) => {
    const id = e.target?.dataset?.exploreStop;
    if (!id) return;
    e.preventDefault();
    const r = await api('/api/socialData/explore-stop', 'POST', { id }).catch((err) => ({ ok: false, error: err.message }));
    const msg = $('#exploreMsg', view);
    if (msg) { msg.textContent = r.ok ? '⏹ 已请求停止（正在等的那一轮会被立刻中断）' : ('❌ ' + (r.error || '停止失败')); msg.style.color = r.ok ? '' : '#c66'; }
    loadExploreJobs();
  });
  loadExploreJobs();

  // 手动添加：入库为**候选**，走和 AI 提交一样的复核路径，不会直接进提示词。
  // 想让它生效，去「候选」标签页确认（或批量确认）。
  $('#slangAdd', view).addEventListener('click', async () => {
    const content = $('#slangContent', view).value.trim();
    const meaning = $('#slangMeaning', view).value.trim();
    const usage = $('#slangUsage', view).value.trim();
    const example = $('#slangExample', view).value.trim();
    if (!content) { toast('词条不能为空', 'err'); return; }
    const r = await api('/api/slang', 'POST', { content, meaning, usage, example, status: 'candidate' }).catch((e) => ({ ok: false, error: e.message }));
    setSlangMsg(r.ok ? '✅ 已加入候选，去「候选」标签页确认后才会生效' : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) {
      $('#slangContent', view).value = '';
      $('#slangMeaning', view).value = '';
      $('#slangUsage', view).value = '';
      $('#slangExample', view).value = '';
      refreshSlang();
      // 新词落在「候选」：直接切过去，免得管理员在当前标签页里找不到刚加的词。
      setTab('candidate');
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
  bindDoubaoPanel(view);
  loadDoubaoStatus(view);
  bindBackfillPanel(view);

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
