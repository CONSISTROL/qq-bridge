// 一代仿真模式（reserved）：06 社交参数 + 状态机查看 + 手动切状态
import { api } from '../core/api.js';
import { $, esc, toast, setMsg } from '../core/dom.js';
import { every } from '../core/poll.js';
import { mountFragment } from '../core/fragments.js';

export const id = 'social1';
export const title = '一代仿真模式';
export const desc = '观望/活跃状态机、社交参数、分条发送、主动开话题';
export const icon = '💬';
export const group = '仿真';
export const order = 1;

// 表单 ⇄ /api/social 配置 的字段表。
// unit = 显示单位换算（load 除以它、save 乘以它）；min/max 在显示单位上做钳制；
// def 只在配置里缺字段时兜底。旧代码 load/save 是两段手写的长清单，
// 改一个字段要改两处、还容易只改一边——现在这张表是唯一事实来源。
const FIELDS = [
  { id: 'sTrigger', key: 'triggerProbability', unit: 1, min: 0, max: 1, def: 0.1 },
  { id: 'sCheckMin', key: 'activeCheckMinMs', unit: 1000, min: 5, def: 10 },
  { id: 'sCheckMax', key: 'activeCheckMaxMs', unit: 1000, min: 5, def: 20 },
  { id: 'sActiveDelayMin', key: 'activeReplyDelayMinMs', unit: 1000, min: 0, def: 0 },
  { id: 'sActiveDelayMax', key: 'activeReplyDelayMaxMs', unit: 1000, min: 0, def: 0 },
  { id: 'sActiveDurationEnabled', key: 'activeDurationEnabled', type: 'bool', def: true },
  { id: 'sActiveDurationMin', key: 'activeDurationMinMs', unit: 60000, min: 1, def: 10 },
  { id: 'sActiveDurationMax', key: 'activeDurationMaxMs', unit: 60000, min: 1, def: 30 },
  { id: 'sIdleWindow', key: 'idleWindowMs', unit: 60000, min: 1, def: 5 },
  { id: 'sIdleRetry', key: 'idleRetryProbability', unit: 1, min: 0, max: 1, def: 0.2 },
  { id: 'sIdleWait', key: 'idleRetryWaitMs', unit: 60000, min: 1, def: 3 },
  { id: 'sSkipProb', key: 'skipProbability', unit: 1, min: 0, max: 1, def: 0.15 },
  { id: 'sSurrenderProb', key: 'surrenderProbability', unit: 1, min: 0, max: 1, def: 0.08 },
  { id: 'sContextWindow', key: 'contextWindow', unit: 1, min: 1, max: 100, def: 20 },
  { id: 'sMaxChars', key: 'maxReplyChars', unit: 1, min: 1, def: 500 },
  { id: 'sBurstEnabled', key: 'burstEnabled', type: 'bool', def: true },
  { id: 'sBurstIntervalMin', key: 'burstIntervalMinMs', unit: 1, min: 0, def: 1000 },
  { id: 'sBurstIntervalMax', key: 'burstIntervalMaxMs', unit: 1, min: 0, def: 3000 },
  { id: 'sLongGapProb', key: 'longGapProbability', unit: 1, min: 0, max: 1, def: 0.1 },
  { id: 'sLongGapMin', key: 'longGapMinMs', unit: 1, min: 0, def: 2500 },
  { id: 'sLongGapMax', key: 'longGapMaxMs', unit: 1, min: 0, def: 5000 },
  { id: 'sKeywords', key: 'mustReplyKeywords', type: 'list', def: [] },
  { id: 'sProactiveEnabled', key: 'proactiveEnabled', type: 'bool', def: true },
  { id: 'sProactiveIdle', key: 'proactiveIdleThresholdMs', unit: 60000, min: 1, def: 15 },
  { id: 'sProactiveCheckMin', key: 'proactiveCheckMinMs', unit: 60000, min: 1, def: 30 },
  { id: 'sProactiveCheckMax', key: 'proactiveCheckMaxMs', unit: 60000, min: 1, def: 90 },
  { id: 'sProactiveProb', key: 'proactiveProbability', unit: 1, min: 0, max: 1, def: 0.3 }
];

function fillForm(view, config) {
  for (const f of FIELDS) {
    const el = $('#' + f.id, view);
    if (!el) continue;
    const raw = config?.[f.key];
    if (f.type === 'bool') { el.checked = raw !== false; continue; }
    if (f.type === 'list') { el.value = (Array.isArray(raw) ? raw : f.def).join(', '); continue; }
    const value = raw === undefined || raw === null ? f.def : raw / f.unit;
    el.value = String(Math.round(value * 1000) / 1000);
  }
}

function readForm(view) {
  const body = {};
  for (const f of FIELDS) {
    const el = $('#' + f.id, view);
    if (!el) continue;
    if (f.type === 'bool') { body[f.key] = el.checked; continue; }
    if (f.type === 'list') {
      body[f.key] = el.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      continue;
    }
    let n = Number(el.value);
    if (!Number.isFinite(n)) n = f.def;
    if (f.min !== undefined) n = Math.max(f.min, n);
    if (f.max !== undefined) n = Math.min(f.max, n);
    // 换算后再取整，避免 1.9999999 这类浮点尾巴写进配置
    body[f.key] = f.unit === 1 ? n : Math.round(n * f.unit);
  }
  return body;
}

const PHASE_LABEL = { idle: '观望', active: '活跃', probing: '试探', exiting: '退场中' };
const PHASE_CLASS = { idle: 'pill g', active: 'pill b', probing: 'pill r', exiting: 'pill' };

function renderSocialStatus(view, s) {
  const buff = Object.entries(s.pendingSummaries || {}).map(([k, n]) => k + ':' + n).join('  ') || '无';
  const entries = Object.entries(s.states || {});
  const sel = $('#sStateKey', view);
  const prev = sel.value;
  sel.textContent = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '选择会话';
  sel.appendChild(blank);
  for (const [key] of entries) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = key;
    sel.appendChild(opt);
  }
  if (prev && Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;

  let html = '摘要缓冲: ' + esc(buff) + '<br>状态:';
  if (!entries.length) html += ' 暂无（发过消息的群会显示状态）';
  for (const [key, v] of entries) {
    html += ` <span class="${PHASE_CLASS[v.phase] || 'pill'}">${esc(key)} · ${PHASE_LABEL[v.phase] || esc(v.phase)}</span>`;
  }
  $('#socialStatus', view).innerHTML = html;
}

export async function mount(root) {
  const view = await mountFragment(root, 'social1');

  // 表单只在进入页面和保存成功后填，避免轮询覆盖正在编辑的输入框
  const load = async () => {
    const r = await api('/api/social').catch(() => null);
    if (r?.config) fillForm(view, r.config);
  };
  const status = async () => {
    const r = await api('/api/social').catch(() => null);
    if (r) renderSocialStatus(view, r);
  };

  await load();
  await status();
  const stopPoll = every(3000, status);

  const save = async (body, okText) => {
    const r = await api('/api/social', 'POST', body).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#socialMsg', view), r.ok ? (okText || '✅ 已保存') : ('❌ ' + (r.error || '失败')), r.ok);
    return r;
  };

  $('#socialSave', view).addEventListener('click', async () => {
    const r = await save(readForm(view));
    if (r.ok) { await load(); await status(); }
  });
  $('#socialFlush', view).addEventListener('click', async () => {
    const r = await api('/api/social/flush', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#socialMsg', view), r.ok ? '✅ 已触发摘要投喂' : ('❌ ' + (r.error || '失败')), r.ok);
  });

  const setPhase = async (phase) => {
    const key = $('#sStateKey', view).value;
    if (!key) { toast('请先选择会话', 'err'); return; }
    // /api/social/state 只认 key+phase，不能把整个表单发过去覆盖配置
    const r = await api('/api/social/state', 'POST', { key, phase }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#socialMsg', view), r.ok ? ('✅ 已设为' + (phase === 'active' ? '活跃' : '观望')) : ('❌ ' + (r.error || '失败')), r.ok);
    status();
  };
  $('#sStateActive', view).addEventListener('click', () => setPhase('active'));
  $('#sStateIdle', view).addEventListener('click', () => setPhase('idle'));

  return () => stopPoll();
}
