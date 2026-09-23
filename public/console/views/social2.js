// 二代仿真模式（reserved2）控制台：07 全部内容
//
// 这个分区内容最多（参数、工具开关、工具调用日志、轻量记忆、唤醒状态、会话状态、
// 工具级配置弹窗）。相对旧实现的两处结构性改动：
//   1. 主配置表单改成 FIELDS 表驱动：load/save 共用一张表，不会再出现「加了一个
//      字段但只改了 save 没改 load」的错位；
//   2. 弹窗的事件委托挂在 view 根节点而不是 document 上，切走分区就随之失效。
import { api } from '../core/api.js';
import { $, $$, esc, toast, setMsg, confirmDanger, delegate, fmtClock } from '../core/dom.js';
import { every } from '../core/poll.js';
import { mountFragment } from '../core/fragments.js';
import { trackDirty } from '../core/dirty.js';

export const id = 'social2';
export const title = '二代仿真模式';
export const desc = 'AI 工具开关、唤醒/发送/等待参数、工具日志、轻量记忆、工具级配置';
export const icon = '🤖';
export const group = '仿真';
export const order = 2;

// 默认关闭的工具开关：只有 config.tools[flag] === true 才算开启（与 bridge/mcp 侧一致），
// 也意味着「全部开启」不会顺手打开它们。目前只有真·QQ 写操作属于这一类。
const OPT_IN_TOOLS = new Set(['setMemberCard']);

// ── 主配置表单：字段表 ───────────────────────────────────────────────
// type: bool | list | text | select | number（默认）
// unit: µ显示单位换算（load 除以它、save 乘以它），仅 number 有
// def : 配置缺字段时的兜底值（显示单位）
const FIELDS = [
  { id: 'v2Enabled', path: 'enabled', type: 'bool', def: true },
  { id: 'v2AgentPreset', path: 'agentPreset', type: 'text', def: '' },
  { id: 'v2ProvideRecommendations', path: 'provideRecommendations', type: 'bool', def: true },
  { id: 'v2AutoReplyCheckSec', path: 'autoReplyCheckMs', unit: 1000, def: 30, min: 1 },

  { id: 'v2WakeDefaultMode', path: 'wake.defaultMode', type: 'select', def: 'diving' },
  { id: 'v2RecDefaultInfinite', path: 'wake.recommendedDefaultInfinite', type: 'bool', def: true },
  { id: 'v2PreSleepWaitEnabled', path: 'wake.preSleepWaitEnabled', type: 'bool', def: true },
  { id: 'v2PreSleepWaitMin', path: 'wake.preSleepWaitMs', unit: 60000, def: 5, min: 0 },
  { id: 'v2RecSleepMin', path: 'wake.recommendedSleepMinMs', unit: 60000, def: 5, min: 1 },
  { id: 'v2RecSleepMax', path: 'wake.recommendedSleepMaxMs', unit: 60000, def: 120, min: 1 },
  { id: 'v2RecProb', path: 'wake.recommendedProbability', def: 0.05, min: 0, max: 1 },
  { id: 'v2RecKeywords', path: 'wake.recommendedKeywords', type: 'list', def: [] },
  { id: 'v2RecAt', path: 'wake.recommendedAtMention', type: 'bool', def: true },
  { id: 'v2RecName', path: 'wake.recommendedNameMention', type: 'bool', def: true },
  { id: 'v2RecQuestion', path: 'wake.recommendedQuestion', type: 'bool', def: true },
  { id: 'v2RecPoke', path: 'wake.recommendedPoke', type: 'bool', def: true },
  { id: 'v2WakeHint', path: 'wake.recommendedHint', type: 'text', def: '' },
  { id: 'v2SleepMinMs', path: 'wake.sleepMinMs', unit: 1000, def: 60, min: 0 },
  { id: 'v2SleepMaxMs', path: 'wake.sleepMaxMs', unit: 1000, def: 0, min: 0 },
  { id: 'v2MaxWakeMin', path: 'wake.maxWakePerMinute', def: 1, min: 0 },
  { id: 'v2MaxWakeHour', path: 'wake.maxWakePerHour', def: 12, min: 0 },
  { id: 'v2BatchWindowMs', path: 'wake.batchWindowMs', def: 8000, min: 1000 },
  { id: 'v2NoActionLimit', path: 'wake.noActionLimit', def: 3, min: 1 },
  { id: 'v2MaxWakeConfigReminders', path: 'wake.maxWakeConfigReminders', def: 2, min: 1 },

  { id: 'v2BurstEnabled', path: 'send.burstEnabled', type: 'bool', def: true },
  { id: 'v2BurstMax', path: 'send.burstMaxMessages', def: 8, min: 1 },
  { id: 'v2BurstMin', path: 'send.burstIntervalMinMs', def: 1000, min: 0 },
  { id: 'v2BurstMaxMs', path: 'send.burstIntervalMaxMs', def: 3000, min: 0 },
  { id: 'v2LongGapProb', path: 'send.longGapProbability', def: 0.2, min: 0, max: 1 },
  { id: 'v2LongGapMin', path: 'send.longGapMinMs', def: 5000, min: 0 },
  { id: 'v2LongGapMax', path: 'send.longGapMaxMs', def: 10000, min: 0 },
  { id: 'v2MaxSendMin', path: 'send.maxSendPerMinute', def: 8, min: 0 },
  { id: 'v2MaxSendHour', path: 'send.maxSendPerHour', def: 60, min: 0 },
  { id: 'v2MaxMsgChars', path: 'send.maxMessageChars', def: 500, min: 1 },
  { id: 'v2MaxGapMs', path: 'send.maxGapMs', def: 10000, min: 100 },
  { id: 'v2GapBaseMs', path: 'send.gapBaseMs', def: 800, min: 0 },
  { id: 'v2GapPerCharMs', path: 'send.gapPerCharMs', def: 20, min: 0 },
  { id: 'v2SendHint', path: 'send.recommendedHint', type: 'text', def: '' },

  { id: 'v2WaitDefaultMs', path: 'wait.defaultMs', def: 30000, min: 100 },
  { id: 'v2WaitMinMs', path: 'wait.minMs', def: 5000, min: 100 },
  { id: 'v2WaitMaxMs', path: 'wait.maxMs', def: 600000, min: 100 },
  { id: 'v2WaitDefaultQuietMs', path: 'wait.defaultQuietMs', def: 8000, min: 0 },
  { id: 'v2MinQuietAfterNewMs', path: 'wait.minQuietAfterNewMs', def: 10000, min: 0 },

  { id: 'v2ProactiveEnabled', path: 'proactive.enabled', type: 'bool', def: true },
  { id: 'v2ProactiveIntervalMin', path: 'proactive.checkIntervalMinMs', unit: 60000, def: 30, min: 1 },
  { id: 'v2ProactiveIntervalMax', path: 'proactive.checkIntervalMaxMs', unit: 60000, def: 90, min: 1 },
  { id: 'v2ProactiveIdleThreshold', path: 'proactive.idleThresholdMs', unit: 60000, def: 15, min: 1 },
  { id: 'v2ProactiveProbability', path: 'proactive.probability', def: 0.3, min: 0, max: 1 },

  { id: 'v2StickerEnabled', path: 'sticker.enabled', type: 'bool', def: true },
  { id: 'v2StickerSyncTtlSec', path: 'sticker.syncTtlMs', unit: 1000, def: 60, min: 1 },
  { id: 'v2StickerMaxList', path: 'sticker.maxListCount', def: 100, min: 1, max: 500 },
  { id: 'v2StickerPromptMax', path: 'sticker.promptMaxStickers', def: 8, min: 1, max: 30 },
  { id: 'v2StickerIncludePrompt', path: 'sticker.includeInPrompt', type: 'bool', def: true },
  { id: 'v2StickerCollectEnabled', path: 'sticker.collect.enabled', type: 'bool', def: true },
  { id: 'v2StickerCollectPerMin', path: 'sticker.collect.maxPerMinute', def: 2, min: 0 },
  { id: 'v2StickerCollectPerHour', path: 'sticker.collect.maxPerHour', def: 10, min: 0 },
  { id: 'v2StickerCollectRemarkMax', path: 'sticker.collect.maxRemarkChars', def: 20, min: 1, max: 50 },

  { id: 'v2PickEnabled', path: 'sticker.pick.enabled', type: 'bool', def: true },
  { id: 'v2PickHint', path: 'sticker.pick.hintInPrompt', type: 'bool', def: true },
  { id: 'v2PickMinIntervalSec', path: 'sticker.pick.minIntervalMs', unit: 1000, def: 90, min: 0 },
  { id: 'v2PickMaxPerTurn', path: 'sticker.pick.maxPerTurn', def: 1, min: 1, max: 5 },
  { id: 'v2PickMinScore', path: 'sticker.pick.minScore', def: 30, min: 0, max: 100 },
  { id: 'v2PickLimit', path: 'sticker.pick.defaultLimit', def: 5, min: 1, max: 20 },
  { id: 'v2PickIncludeLibrary', path: 'sticker.pick.includeLibrary', type: 'bool', def: true },
  { id: 'v2PickOnlineFallback', path: 'sticker.pick.onlineFallback', type: 'bool', def: true },
  { id: 'v2PickOnlineCount', path: 'sticker.pick.onlineCount', def: 6, min: 1, max: 12 },
  { id: 'v2PickLibraryMaxSide', path: 'sticker.pick.libraryMaxSide', def: 2600, min: 0 },
  { id: 'v2PickLibraryMaxRatio', path: 'sticker.pick.libraryMaxRatio', step: 0.1, def: 2, min: 0 },
  { id: 'v2PickLibrarySources', path: 'sticker.pick.librarySources', type: 'list', def: ['style', 'manual', 'ai'] },
  { id: 'v2PickStyleKeywords', path: 'sticker.pick.styleKeywords', type: 'list', def: ['表情包', '二次元', 'Q版', '沙雕', '梗图'] },

  { id: 'v2ContextRecentLimit', path: 'context.recentLimit', def: 100, min: 1 },
  { id: 'v2ContextUnreadLimit', path: 'context.unreadLimit', def: 30, min: 1 },
  { id: 'v2ContextWindow', path: 'context.contextWindow', def: 20, min: 1 },

  { id: 'v2FeedbackMaxLength', path: 'feedback.maxLength', def: 500, min: 1 },
  { id: 'v2FeedbackNotifyOwner', path: 'feedback.notifyOwnerOnError', type: 'bool', def: false }
];

// 开关类字段（含 36 个工具开关）：拨动即写盘；其余参数走「保存当前参数」+ 未保存提示。
const SWITCH_FIELDS = FIELDS.filter((f) => f.type === 'bool');
const MANUAL_SELECTOR = FIELDS.filter((f) => f.type !== 'bool').map((f) => '#' + f.id).join(', ');

function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, val) {
  const keys = String(path).split('.');
  let node = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (typeof node[keys[i]] !== 'object' || node[keys[i]] === null) node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = val;
}

function fillForm(view, config) {
  for (const f of FIELDS) {
    const el = $('#' + f.id, view);
    if (!el) continue;
    const raw = config == null ? undefined : getPath(config, f.path);
    // 布尔字段的默认值由 def 决定：def=true 时「只有显式 false 才算关」，
    // def=false 时（如 feedback.notifyOwnerOnError）必须显式 true 才算开。
    if (f.type === 'bool') { el.checked = f.def ? raw !== false : raw === true; continue; }
    if (f.type === 'list') { el.value = (Array.isArray(raw) ? raw : f.def).join(', '); continue; }
    if (f.type === 'text' || f.type === 'select') { el.value = raw ?? f.def; continue; }
    const n = Number(raw);
    const value = Number.isFinite(n) ? (f.unit && f.unit !== 1 ? n / f.unit : n) : f.def;
    el.value = String(Math.round(value * 1000) / 1000);
  }
  for (const el of $$('[data-v2-tool]', view)) {
    // 默认开启的工具：只有显式 false 才算关；默认关闭的工具（OPT_IN_TOOLS）：只有显式 true 才算开。
    // 两边语义必须和 bridge / mcp 保持一致，否则控制台显示「已开启」但工具其实没注册。
    el.checked = OPT_IN_TOOLS.has(el.dataset.v2Tool)
      ? config?.tools?.[el.dataset.v2Tool] === true
      : !(config?.tools && config.tools[el.dataset.v2Tool] === false);
  }
}

function readForm(view) {
  const body = {};
  for (const f of FIELDS) {
    const el = $('#' + f.id, view);
    if (!el) continue;
    if (f.type === 'bool') { setPath(body, f.path, el.checked); continue; }
    if (f.type === 'list') {
      setPath(body, f.path, el.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean));
      continue;
    }
    if (f.type === 'text' || f.type === 'select') { setPath(body, f.path, el.value.trim()); continue; }
    let n = Number(el.value);
    if (!Number.isFinite(n)) n = f.def;
    if (f.min !== undefined) n = Math.max(f.min, n);
    if (f.max !== undefined) n = Math.min(f.max, n);
    // 带小数步长的字段（如长宽比 2.0 / 1.5）不能取整，否则 1.5 会被吃成 2。
    const fractional = Number.isFinite(Number(f.step)) && Number(f.step) > 0 && Number(f.step) < 1;
    if (f.unit && f.unit !== 1) setPath(body, f.path, Math.round(n * f.unit));
    else setPath(body, f.path, fractional ? Math.round(n * 100) / 100 : n);
  }
  const tools = {};
  for (const el of $$('[data-v2-tool]', view)) tools[el.dataset.v2Tool] = el.checked;
  body.tools = tools;
  return body;
}

// ── 工具调用日志 ─────────────────────────────────────────────────────
function toolLogStatus(entry) {
  if (entry.type !== 'result') return '<span class="pill b">调用</span>';
  const ok = entry.ok !== false;
  return `<span class="pill ${ok ? 'g' : 'r'}">${ok ? '成功' : '失败'}</span>`;
}

function summarizeToolArgs(tool, args) {
  let obj = args;
  if (typeof args === 'string') {
    try { obj = JSON.parse(args); } catch { return args || ''; }
  }
  if (!obj || typeof obj !== 'object') return String(obj ?? '');
  const parts = [];
  const push = (k, v) => { if (v !== undefined && v !== null && v !== '') parts.push(`${k}=${v}`); };
  const name = String(tool || '');
  if (name.includes('qq_set_wake_config')) {
    const cfg = (obj.config && typeof obj.config === 'object') ? obj.config : obj;
    push('mode', cfg.mode);
    push('infinite', cfg.infinite);
    const sleepUntil = cfg.sleepUntil || obj.sleepUntil;
    const sleepMs = cfg.sleepMs !== undefined ? cfg.sleepMs : obj.sleepMs;
    if (sleepUntil) push('sleepUntil', sleepUntil);
    else if (sleepMs !== undefined) push('sleepMs', sleepMs + 'ms');
    else push('sleep', '未设置时间');
    const tr = (cfg.triggers && typeof cfg.triggers === 'object') ? cfg.triggers : {};
    const trigs = [];
    if (tr.atMention) trigs.push('@');
    if (tr.nameMention) trigs.push('名字');
    if (tr.question) trigs.push('提问');
    if (tr.poke) trigs.push('拍一拍');
    if (Array.isArray(tr.keywords) && tr.keywords.length) trigs.push('关键词:' + tr.keywords.join(','));
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) trigs.push('指定成员:' + tr.speakerIds.join(','));
    if (tr.anyMessage) trigs.push('anyMessage');
    if (Number(tr.probability) > 0) trigs.push('概率:' + tr.probability);
    if (trigs.length) push('triggers', trigs.join('|'));
  } else if (name.includes('qq_wait_for_messages')) {
    push('timeoutMs', obj.timeoutMs != null ? obj.timeoutMs : '默认30000');
    push('minNewMessages', obj.minNewMessages != null ? obj.minNewMessages : 1);
    push('quietMs', obj.quietMs != null ? obj.quietMs : '默认8000');
  } else if (name.includes('qq_send_message')) {
    const msgs = Array.isArray(obj.messages) ? obj.messages : (obj.messages != null ? [obj.messages] : []);
    push('条数', msgs.length);
    if (msgs.length) push('首条', String(msgs[0]).slice(0, 30));
    push('gapMode', obj.gapMode || 'auto');
    if (obj.gapMs != null) push('gapMs', obj.gapMs);
    if (Array.isArray(obj.gaps) && obj.gaps.length) push('gaps', obj.gaps.join(','));
    if (obj.replyToMessageId != null && obj.replyToMessageId !== '') push('引用id', obj.replyToMessageId);
  } else if (name.includes('qq_send_burst')) {
    const msgs = Array.isArray(obj.messages) ? obj.messages : [];
    push('条数', msgs.length);
    if (msgs.length) push('首条', String(msgs[0]).slice(0, 30));
  } else if (name.includes('qq_send_poke')) {
    push('key', obj.key);
    if (obj.targetUserId != null && obj.targetUserId !== '') push('target', obj.targetUserId);
  } else if (name.includes('qq_get_forward_msg')) {
    push('key', obj.key);
    if (obj.id != null && obj.id !== '') push('id', String(obj.id).slice(0, 40));
  } else if (name.includes('qq_mark_read')) {
    push('key', obj.key);
  } else if (name.includes('qq_get_prompt') || name.includes('qq_get_unread_messages')
    || name.includes('qq_get_recent_messages') || name.includes('qq_social_state')
    || name.includes('qq_get_my_recent_messages') || name.includes('qq_get_message_detail')
    || name.includes('qq_get_active_members')) {
    push('key', obj.key);
    if (obj.messageId != null) push('messageId', obj.messageId);
    if (obj.limit != null) push('limit', obj.limit);
  } else {
    push('key', obj.key);
  }
  return parts.join(' | ') || JSON.stringify(obj);
}

function toolLogCell(value, tool) {
  const text = value == null ? '' : String(value);
  if (!text) return '<span class="meta">-</span>';
  const summary = tool ? summarizeToolArgs(tool, text) : text;
  const short = summary.length > 100 ? summary.slice(0, 100) + '…' : summary;
  return `<span class="tool-log-cell" data-full="${esc(text)}" data-short="${esc(short)}" title="点击查看完整 JSON">${esc(short)}</span>`;
}

function renderToolLog(view, entries) {
  const box = $('#v2ToolLogOutput', view);
  const list = entries || [];
  if (!list.length) { box.innerHTML = '<span class="meta">（空）</span>'; return; }
  let html = '<table><tr><th>时间</th><th>会话 key</th><th>工具名</th><th>状态</th><th>参数</th><th>错误信息</th></tr>';
  for (const e of list) {
    html += '<tr>'
      + `<td>${esc(e.time ? fmtClock(e.time) : '-')}</td>`
      + `<td>${esc(e.key || '')}</td>`
      + `<td>${esc(e.tool || '-')}</td>`
      + `<td>${toolLogStatus(e)}</td>`
      + `<td>${e.type === 'call' ? toolLogCell(e.args, e.tool) : '<span class="meta">-</span>'}</td>`
      + `<td>${e.type === 'result' ? toolLogCell(e.error) : '<span class="meta">-</span>'}</td>`
      + '</tr>';
  }
  box.innerHTML = html + '</table>';
}

// ── 轻量记忆 ─────────────────────────────────────────────────────────
function renderMemory(view, data) {
  const box = $('#v2MemoryOutput', view);
  if (!data || !data.ok) { box.innerHTML = '<span class="meta">加载失败</span>'; return; }
  const raw = data.raw || {};
  const topics = Array.isArray(raw.activeTopics) ? raw.activeTopics : [];
  const thoughts = Array.isArray(raw.pendingThoughts) ? raw.pendingThoughts : [];
  const impressions = raw.memberImpressions && typeof raw.memberImpressions === 'object' ? raw.memberImpressions : {};
  let html = '<div style="padding:8px">';
  html += '<div class="memory-section"><b>进行中的话题</b> <button class="small" data-action="clear" data-cat="activeTopic">清空</button>';
  if (!topics.length) html += '<div class="meta">（空）</div>';
  for (const t of topics) {
    const text = esc(String(t?.text || ''));
    const extra = t?.pendingQuestion ? `；待追问：${esc(String(t.pendingQuestion))}` : '';
    html += `<div style="margin:4px 0">📌 ${text}${extra} <button class="small" data-action="edit" data-cat="activeTopic" data-content="${esc(String(t?.text || ''))}">编辑</button> <button class="small" data-action="remove" data-cat="activeTopic" data-content="${esc(String(t?.text || ''))}">删除</button></div>`;
  }
  html += '</div>';
  html += '<div class="memory-section"><b>你想说但还没说的</b> <button class="small" data-action="clear" data-cat="pendingThought">清空</button>';
  if (!thoughts.length) html += '<div class="meta">（空）</div>';
  for (const t of thoughts) {
    html += `<div style="margin:4px 0">💭 ${esc(String(t?.text || ''))}${t?.motivation ? `（${esc(String(t.motivation))}）` : ''} <button class="small" data-action="edit" data-cat="pendingThought" data-content="${esc(String(t?.text || ''))}">编辑</button> <button class="small" data-action="remove" data-cat="pendingThought" data-content="${esc(String(t?.text || ''))}">删除</button></div>`;
  }
  html += '</div>';
  html += '<div class="memory-section"><b>对群友的印象</b> <button class="small" data-action="clear" data-cat="memberImpression">清空</button>';
  const names = Object.keys(impressions);
  if (!names.length) html += '<div class="meta">（空）</div>';
  for (const name of names) {
    const im = impressions[name] || {};
    const traits = Array.isArray(im.traits) ? im.traits : [];
    html += `<div style="margin:4px 0">👤 ${esc(name)}：${traits.length ? esc(traits.join('、')) : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次） <button class="small" data-action="edit" data-cat="memberImpression" data-target="${esc(name)}" data-traits="${esc(traits.join(', '))}">编辑</button> <button class="small" data-action="remove" data-cat="memberImpression" data-target="${esc(name)}">删除</button></div>`;
  }
  html += '</div>';
  // 成员备注存在 state/member-remarks.json（不属于 social-v2 状态），单独列一段。
  const remarks = Array.isArray(data.memberRemarks) ? data.memberRemarks : [];
  html += '<div class="memory-section"><b>成员备注（本地记忆，不动 QQ）</b>';
  if (!remarks.length) html += '<div class="meta">（空）</div>';
  for (const r of remarks) {
    const who = r?.remark ? esc(String(r.remark)) : '（未命名）';
    const nick = r?.nick && r.nick !== r.remark ? `，昵称：${esc(String(r.nick))}` : '';
    const note = r?.note ? `｜${esc(String(r.note))}` : '';
    html += `<div style="margin:4px 0">🏷️ ${who}（QQ ${esc(String(r?.qq || ''))}${nick}）${note} <button class="small" data-action="remark-edit" data-user="${esc(String(r?.qq || ''))}" data-remark="${esc(String(r?.remark || ''))}" data-note="${esc(String(r?.note || ''))}">编辑</button> <button class="small" data-action="remark-remove" data-user="${esc(String(r?.qq || ''))}">删除</button></div>`;
  }
  html += '</div></div>';
  box.innerHTML = html;
}

// ── 唤醒状态 ─────────────────────────────────────────────────────────
function formatWakeStatus(r) {
  if (!r || !r.ok) return '<span class="meta">加载失败</span>';
  const wc = r.wakeConfig || {};
  const lines = [];
  const mode = wc.mode === 'active' ? '活跃（任何消息都会唤醒）' : (wc.mode === 'diving' ? '潜水' : (wc.mode || '未知'));
  lines.push(`<div><b>模式：</b>${esc(mode)}</div>`);
  lines.push(`<div><b>无限期：</b>${wc.infinite ? '是' : '否'}</div>`);
  const safety = r.wakeSafety || {};
  lines.push(`<div><b>唤醒保证：</b>${safety.guaranteed ? '🟢 已保证' : '🔴 无保证'}${safety.stale ? '（配置较旧，未确认）' : ''}</div>`);
  let next;
  if (wc.mode === 'active' || wc.triggers?.anyMessage) {
    next = '任何新消息都会唤醒';
  } else if (wc.sleepUntil) {
    const until = new Date(wc.sleepUntil).getTime();
    const remain = until - Date.now();
    if (!Number.isFinite(remain)) next = '时间格式无效';
    else if (remain > 0) next = `约 ${Math.max(1, Math.round(remain / 1000))} 秒后（${fmtClock(wc.sleepUntil)}）`;
    else next = '已到期，等待下一次唤醒';
  } else if (wc.infinite) {
    next = '无限期潜水，等待指定条件';
  } else {
    next = '未设置时间';
  }
  lines.push(`<div><b>下次唤醒：</b>${esc(next)}</div>`);
  const tr = wc.triggers || {};
  const conds = [];
  if (tr.atMention) conds.push('@');
  if (tr.nameMention) conds.push('名字');
  if (Array.isArray(tr.keywords) && tr.keywords.length) conds.push('关键词：' + tr.keywords.join('、'));
  if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) conds.push('指定成员：' + tr.speakerIds.join('、'));
  if (tr.question) conds.push('提问');
  if (tr.poke) conds.push('拍一拍');
  if (tr.anyMessage) conds.push('任何消息');
  if (Number(tr.probability) > 0) conds.push('普通消息概率 ' + Number(tr.probability));
  lines.push(`<div><b>提前唤醒条件：</b>${conds.length ? esc(conds.join('；')) : '（无）'}</div>`);
  lines.push(`<div><b>最近唤醒原因：</b>${esc(r.lastWakeReason || '-')}</div>`);
  lines.push(`<div><b>唤醒次数：</b>${Number(wc.wakeCount) || 0}</div>`);
  if (wc.confirmedAt) {
    const ago = Math.max(0, Math.round((Date.now() - wc.confirmedAt) / 60000));
    lines.push(`<div><b>配置确认：</b>${ago} 分钟前（${esc(wc.confirmedBy || 'unknown')}）</div>`);
  }
  if (r.lastAiReplyAt) {
    const ago = Math.max(0, Math.round((Date.now() - r.lastAiReplyAt) / 60000));
    lines.push(`<div><b>上次发言：</b>${ago} 分钟前</div>`);
  }
  lines.push(`<div><b>未读：</b>${Number(r.unreadCount) || 0} 条</div>`);
  return '<div style="padding:8px">' + lines.join('') + '</div>';
}

// ── 工具级配置弹窗 ───────────────────────────────────────────────────
const CFG_SCHEMA = {
  knowledge: {
    title: '群知识库',
    desc: '作用于 qq_knowledge_query · qq_knowledge_submit',
    fields: [
      { path: 'enabled', label: '启用知识库', type: 'bool' },
      { path: 'autoWrite', label: 'AI 提交即生效', type: 'bool', hint: '关闭后 AI 写入的条目记为「已停用」，需要人工启用' },
      { path: 'injectMax', label: '每次注入最多几条', type: 'number' },
      { path: 'remindHitCount', label: '命中提醒阈值', type: 'number', hint: '被问够这么多次才提醒 AI「这问题被反复问过」' },
      { path: 'remindMinAskers', label: '至少几个不同的人问过', type: 'number' },
      { path: 'similarityThreshold', label: '问题去重门槛', type: 'number', step: 0.01, hint: '0~1，越低越容易把不同问法合并到同一条' }
    ]
  },
  image: {
    title: '图片 / 表情来源（含搜图分级）',
    desc: '作用于 qq_save_sticker · qq_send_image · qq_search_images · qq_list_image_library；搜图的图源在 qq_search_images 行的 ⚙ 里配，年龄分级在这个分区里配',
    fields: [
      { path: 'enabled', label: '启用图片功能', type: 'bool' },
      { path: 'allowRemoteUrl', label: '允许远程 URL', type: 'bool', hint: '关闭后只能用本地图库/base64，AI 不能抓网络图' },
      { path: 'rating', label: '图片年龄分级', type: 'select', hint: '只决定「搜图返回什么」，不影响发送/收藏。r18 档只有「真实 pixiv」源能给出（bobopic 镜像里没有 R-18）；限制级（explicit）任何档位都不返回', options: [{ value: 'safe', label: 'safe — 只返回全年龄（默认）' }, { value: 'mild', label: 'mild — 允许轻度擦边（水着/黑丝/大腿等标签）' }, { value: 'r18', label: 'r18 — 允许 R-18（需真实 pixiv + 登录 cookie）' }] },
      { path: 'pixiv.enabled', label: '真实 pixiv（走代理）', type: 'bool', hint: '开启后搜图直接打 pixiv 官方接口（结果比 bobopic 镜像多得多）；本机直连不通，必须填代理' },
      { path: 'pixiv.proxy', label: 'pixiv 代理地址', type: 'text', placeholder: 'http://127.0.0.1:7897', hint: '只对 pixiv 系域名生效（bobopic / B 站仍然直连）。填 Clash 的混合端口' },
      { path: 'pixiv.cookie', label: 'pixiv 登录 Cookie（PHPSESSID）', type: 'password', placeholder: 'PHPSESSID=xxxx；留空=只能搜全年龄', hint: 'R-18 搜索必须带登录会话（pixiv 未登录时 mode=r18 与 mode=all 结果相同）。只存本机 config.json（已 gitignore）' },
      { path: 'ratingWords.mild', label: '擦边词（safe 档滤掉 / mild 档放行）', type: 'list', hint: '每行一个标签，整标签匹配；留空=不按词过滤擦边（explicitExtra 仍然拦）' },
      { path: 'ratingWords.tolerated', label: '明确放行为全年龄的词', type: 'list', hint: '优先于擦边词：两张表都写了也按全年龄处理（放宽记录就放这儿）' },
      { path: 'ratingWords.explicitExtra', label: '额外限制级词（explicit 的唯一来源）', type: 'list', hint: '留空=不拦任何标签（内置表为空）；写进擦边/放行词表也删不掉这里的词' },
      { path: 'libraryDir', label: '本地图库目录', type: 'text', hint: '相对仓库根目录，默认 assets/stickers' },
      { path: 'maxBytes', label: '单图体积上限', type: 'number', factor: 1048576, unit: 'MB', step: 0.5, hint: '建议与发图功能保持一致' },
      { path: 'repeatGuardMs', label: '防重复发图窗口', type: 'number', factor: 60000, unit: '分钟', step: 5, hint: '同一张图（按 pixiv 作品 id / URL）在这段时间内不再发第二次：搜图结果里会滤掉，qq_send_image 也会直接拒绝。0 = 关闭' },
      { path: 'maxPerMinute', label: '每分钟上限', type: 'number' },
      { path: 'maxPerHour', label: '每小时上限', type: 'number' },
      { path: 'imageReferer', label: '远程抓图 Referer', type: 'text', hint: 'B 站图床防盗链用' },
      { path: 'refererAllow', label: '允许抓取的站点', type: 'list', hint: '每行一个 host/origin；留空=不限制（仍受 SSRF 防护）' }
    ]
  },
  sticker: {
    title: '表情包',
    desc: '作用于 qq_list_stickers · qq_get_sticker_image · qq_send_sticker · qq_sticker_note · qq_collect_sticker',
    fields: [
      { path: 'enabled', label: '启用表情包体系', type: 'bool' },
      { path: 'includeInPrompt', label: '把表情清单放进提示词', type: 'bool' },
      { path: 'promptMaxStickers', label: '提示词最多列几张', type: 'number' },
      { path: 'syncTtlMs', label: '同步缓存时长', type: 'number', factor: 1000, unit: '秒' },
      { path: 'maxListCount', label: '列表最多返回', type: 'number' },
      { path: 'collect.enabled', label: '允许 AI 收藏别人的表情', type: 'bool' },
      { path: 'collect.maxPerMinute', label: '收藏每分钟上限', type: 'number' },
      { path: 'collect.maxPerHour', label: '收藏每小时上限', type: 'number' },
      { path: 'collect.maxRemarkChars', label: '备注最大字数', type: 'number' }
    ]
  },
  send: {
    title: '发送行为',
    desc: '作用于 qq_send_message · qq_send_burst · qq_reply · qq_send_group_message · qq_send_private_message',
    fields: [
      { path: 'burstEnabled', label: '启用分条发送', type: 'bool' },
      { path: 'burstMaxMessages', label: '一次最多几条', type: 'number' },
      { path: 'burstIntervalMinMs', label: '条间最小间隔', type: 'number', unit: 'ms' },
      { path: 'burstIntervalMaxMs', label: '条间最大间隔', type: 'number', unit: 'ms' },
      { path: 'longGapProbability', label: '长停顿概率', type: 'number', step: 0.05 },
      { path: 'longGapMinMs', label: '长停顿最小', type: 'number', unit: 'ms' },
      { path: 'longGapMaxMs', label: '长停顿最大', type: 'number', unit: 'ms' },
      { path: 'maxSendPerMinute', label: '每分钟上限', type: 'number' },
      { path: 'maxSendPerHour', label: '每小时上限', type: 'number' },
      { path: 'maxMessageChars', label: '单条最大字数', type: 'number' },
      { path: 'maxGapMs', label: '单条最长等待', type: 'number', unit: 'ms' },
      { path: 'gapBaseMs', label: '打字基础延迟', type: 'number', unit: 'ms' },
      { path: 'gapPerCharMs', label: '每字追加延迟', type: 'number', unit: 'ms' }
    ]
  },
  wait: {
    title: '等待与静默',
    desc: '作用于 qq_wait_for_messages',
    fields: [
      { path: 'defaultMs', label: '默认等待', type: 'number', unit: 'ms' },
      { path: 'minMs', label: '最短等待', type: 'number', unit: 'ms' },
      { path: 'maxMs', label: '最长等待', type: 'number', unit: 'ms' },
      { path: 'defaultQuietMs', label: '默认静默窗口', type: 'number', unit: 'ms' },
      { path: 'minQuietAfterNewMs', label: '新消息后强制静默', type: 'number', unit: 'ms' }
    ]
  },
  wake: {
    title: '唤醒 / 潜水',
    desc: '作用于 qq_set_wake_config',
    fields: [
      { path: 'defaultMode', label: '默认模式', type: 'select', options: [{ value: 'diving', label: '潜水（等条件唤醒）' }, { value: 'active', label: '活跃（每条都醒）' }] },
      { path: 'recommendedDefaultInfinite', label: '推荐无限期潜水', type: 'bool' },
      { path: 'preSleepWaitEnabled', label: '沉睡前强制观察', type: 'bool' },
      { path: 'preSleepWaitMs', label: '观察窗口时长', type: 'number', factor: 1000, unit: '秒' },
      { path: 'sleepMinMs', label: '潜水最短', type: 'number', factor: 1000, unit: '秒' },
      { path: 'sleepMaxMs', label: '潜水最长（0=不限）', type: 'number', factor: 1000, unit: '秒' },
      { path: 'recommendedProbability', label: '推荐普通消息唤醒概率', type: 'number', step: 0.05 },
      { path: 'batchWindowMs', label: '消息聚合窗口', type: 'number', unit: 'ms' },
      { path: 'maxWakePerMinute', label: '每分钟唤醒上限', type: 'number' },
      { path: 'maxWakePerHour', label: '每小时唤醒上限', type: 'number' }
    ]
  },
  feedback: {
    title: '反馈',
    desc: '作用于 qq_report_feedback',
    fields: [
      { path: 'maxLength', label: '反馈最大长度', type: 'number' },
      { path: 'notifyOwnerOnError', label: '出错时私聊通知 owner', type: 'bool' }
    ]
  },
  bili: {
    title: 'B 站抓图（本地图库）',
    desc: '把评论/动态/专栏/封面的图片抓进 assets/stickers；由 systemd 定时器 bili-fetch.timer 每天自动跑，也可手动触发',
    custom: 'bili',
    statusLine: 'bili',
    logLine: 'bili',
    extraButtons: [
      { action: 'bili-fetch', label: '立即抓取' },
      { action: 'bili-clear-cookie', label: '清除 SESSDATA' }
    ],
    fields: [
      { path: 'sessdata', label: 'SESSDATA（可选）', type: 'password', placeholder: '留空=不改动；仅用于「动态详情多图」和官方表情包' },
      { path: 'keywords', label: '定时抓取关键词', type: 'list', hint: '每行一个，定时任务按这些主题去搜视频/专栏并抓图（AI 平时也能用 qq_search_images 自己搜）' },
      { path: 'bvids', label: '定点：视频 BV（可选）', type: 'list', hint: '不想用关键词时可指定具体视频；留空即可' },
      { path: 'mids', label: '定点：UP 主 UID（可选）', type: 'list', hint: '抓该 UP 的动态封面；留空即可' },
      { path: 'cvs', label: '定点：专栏 cv（可选）', type: 'list', hint: '每行一个，cv 前缀可省' },
      { path: 'sources.cover', label: '抓视频封面', type: 'bool' },
      { path: 'sources.comments', label: '抓评论区图片', type: 'bool' },
      { path: 'sources.dynamic', label: '抓动态图片', type: 'bool' },
      { path: 'sources.detail', label: '抓动态详情多图（需 SESSDATA）', type: 'bool' },
      { path: 'limit', label: '单次最多抓几张', type: 'number' },
      { path: 'dynamicPages', label: '动态翻页数', type: 'number' },
      { path: 'commentPages', label: '评论翻页数', type: 'number' },
      { path: 'minSide', label: '最小边长(px)', type: 'number' },
      { path: 'maxBytes', label: '单图上限', type: 'number', factor: 1048576, unit: 'MB', step: 0.5 },
      { path: 'delayMs', label: '请求间隔', type: 'number', unit: 'ms' }
    ]
  }
};

const state = {
  config: null,
  cfgSection: null,
  bili: null,
  modalDirty: null
};

function cfgFieldEl(view, path) {
  return $(`[data-v2-cfg-field="${path}"]`, view);
}

function renderToolCfg(view, section) {
  const schema = CFG_SCHEMA[section];
  const data = section === 'bili' ? (state.bili?.targets || {}) : (state.config?.[section] || {});
  $('#v2CfgTitle', view).textContent = schema.title;
  $('#v2CfgSubtitle', view).textContent = schema.desc || '';
  const body = $('#v2CfgBody', view);
  body.textContent = '';

  if (schema.statusLine === 'bili' && state.bili) {
    const lib = state.bili.library || { count: 0, bytes: 0 };
    const info = document.createElement('div');
    info.className = 'meta';
    info.style.marginBottom = '6px';
    info.textContent = 'SESSDATA：' + (state.bili.cookieSet ? '已配置（长度 ' + state.bili.cookieLen + '）' : '未配置（动态详情多图/官方表情包不可用）')
      + ' ｜ 图库：' + lib.count + ' 张 / ' + (lib.bytes / 1048576).toFixed(1) + ' MB'
      + ' ｜ 脚本：' + (state.bili.runnerExists ? '就绪' : '缺失');
    body.appendChild(info);
  }

  for (const f of schema.fields) {
    const raw = getPath(data, f.path);
    const row = document.createElement('div');
    row.className = 'v2-cfg-row';
    const lab = document.createElement('label');
    lab.textContent = f.label;
    if (f.hint) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = f.hint;
      lab.appendChild(hint);
    }
    const cell = document.createElement('div');
    let el;
    if (f.type === 'bool') {
      el = document.createElement('input');
      el.type = 'checkbox';
      el.style.width = 'auto';
      el.checked = raw !== false;
    } else if (f.type === 'number') {
      el = document.createElement('input');
      el.type = 'number';
      const n = Number(raw);
      el.value = Number.isFinite(n) ? (f.factor ? Number((n / f.factor).toFixed(3)) : n) : '';
      if (f.step) el.step = f.step;
    } else if (f.type === 'select') {
      el = document.createElement('select');
      for (const o of f.options) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        el.appendChild(opt);
      }
      el.value = raw ?? f.options[0].value;
    } else if (f.type === 'list') {
      el = document.createElement('textarea');
      el.value = Array.isArray(raw) ? raw.join('\n') : '';
    } else {
      el = document.createElement('input');
      el.type = f.type === 'password' ? 'password' : 'text';
      el.value = raw ?? '';
      if (f.placeholder) el.placeholder = f.placeholder;
      // 密码框必须显式声明 new-password：否则浏览器/密码管理器会在弹窗一打开时
      // 自动填回上次保存的值，而那是「用户没动过」的写入 —— 会被未保存追踪算成
      // 一项改动，于是「打开配置再取消」也弹出「还有 1 项没保存」。
      if (f.type === 'password') el.autocomplete = 'new-password';
    }
    el.dataset.v2CfgField = f.path;
    cell.appendChild(el);
    if (f.unit) {
      const unit = document.createElement('span');
      unit.className = 'hint';
      unit.textContent = '单位：' + f.unit;
      cell.appendChild(unit);
    }
    row.append(lab, cell);
    body.appendChild(row);
  }

  if (schema.logLine === 'bili') {
    const cap = document.createElement('div');
    cap.className = 'meta';
    cap.style.marginTop = '10px';
    cap.textContent = '最近抓取日志（state/bili-fetch.log 末尾）';
    const ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.rows = 7;
    ta.style.width = '100%';
    ta.style.fontFamily = 'ui-monospace, monospace';
    ta.style.fontSize = '12px';
    ta.value = state.bili?.log || '（暂无日志）';
    body.append(cap, ta);
  }

  if (Array.isArray(schema.extraButtons) && schema.extraButtons.length) {
    const bar = document.createElement('div');
    bar.className = 'row';
    bar.style.marginTop = '10px';
    for (const b of schema.extraButtons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.v2CfgAction = b.action;
      btn.textContent = b.label;
      bar.appendChild(btn);
    }
    body.appendChild(bar);
  }
  // 字段每次都是新建的，所以每次重渲染后都要重建「未保存」基线
  // （打开弹窗、保存成功、立即抓取、清除 SESSDATA 都会走到这里）
  state.modalDirty?.markClean();
}

export async function mount(root) {
  const view = await mountFragment(root, 'social2');

  const loadConfig = async () => {
    const r = await api('/api/socialV2/config').catch(() => null);
    if (!r) return null;
    state.config = r.config || {};
    fillForm(view, state.config);
    return state.config;
  };

  const refreshActivity = async () => {
    const r = await api('/api/socialV2/activity').catch(() => null);
    if (!r) return;
    const el = $('#v2ActivityStatus', view);
    el.textContent = r.paused ? '已暂停' : '运行中';
    el.className = r.paused ? 'meta err' : 'meta ok';
  };

  const saveConfig = async () => {
    const r = await api('/api/socialV2/config', 'POST', readForm(view))
      .catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#v2ConfigMsg', view), r.ok ? '✅ 已保存' : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) await loadConfig();
    return r;
  };

  // 单个开关即改即存：服务端对 tools 与各子分区都是深合并，只发这一项不会碰别的字段。
  // 失败就把开关拨回去——界面不能显示一个其实没生效的状态。
  const saveSwitch = async (el, patch) => {
    el.classList.add('saving');
    const r = await api('/api/socialV2/config', 'POST', patch).catch((e) => ({ ok: false, error: e.message }));
    el.classList.remove('saving');
    if (!r.ok) {
      el.checked = !el.checked;
      toast(r.error || '保存失败', 'err');
      return false;
    }
    if (r.config) state.config = r.config;
    setMsg($('#v2ConfigMsg', view), '', true);
    return true;
  };

  const saveToolSwitch = (el) => saveSwitch(el, { tools: { [el.dataset.v2Tool]: el.checked } });

  const setAllTools = async (enabled) => {
    const tools = {};
    const boxes = $$('[data-v2-tool]', view);
    for (const el of boxes) {
      // 「全部开启」不该顺手打开默认关闭的高危工具（真·QQ 写操作）：这类只能一个个手动开。
      if (enabled && OPT_IN_TOOLS.has(el.dataset.v2Tool)) continue;
      tools[el.dataset.v2Tool] = enabled;
    }
    for (const el of boxes) el.classList.add('saving');
    const r = await api('/api/socialV2/config', 'POST', { tools }).catch((e) => ({ ok: false, error: e.message }));
    for (const el of boxes) el.classList.remove('saving');
    if (!r.ok) { toast(r.error || '保存失败', 'err'); return; }
    for (const el of boxes) el.checked = enabled;
    if (r.config) state.config = r.config;
    toast(enabled ? '已启用全部工具' : '已禁用全部工具', 'ok');
  };

  const loadToolLog = async () => {
    const r = await api('/api/socialV2/tool-log?limit=200').catch(() => null);
    renderToolLog(view, r?.entries || []);
  };

  const loadMemory = async () => {
    const key = $('#v2MemoryKey', view).value.trim();
    const msg = $('#v2MemoryMsg', view);
    if (!key) { setMsg(msg, '请输入会话 key', false); return; }
    setMsg(msg, '加载中…', true);
    const r = await api('/api/socialV2/memory?key=' + encodeURIComponent(key)).catch((e) => ({ ok: false, error: e.message }));
    renderMemory(view, r);
    setMsg(msg, r.ok ? '✅ 已加载' : ('❌ ' + (r.error || '失败')), r.ok);
  };

  const loadWakeStatus = async () => {
    const key = $('#v2WakeKey', view).value.trim();
    const msg = $('#v2WakeStatusMsg', view);
    if (!key) { setMsg(msg, '请输入会话 key', false); return; }
    setMsg(msg, '加载中…', true);
    const r = await api('/api/socialV2/state?key=' + encodeURIComponent(key)).catch((e) => ({ ok: false, error: e.message }));
    $('#v2WakeStatusOutput', view).innerHTML = formatWakeStatus(r);
    setMsg(msg, r.ok ? '✅ 已加载' : ('❌ ' + (r.error || '失败')), r.ok);
  };

  const loadSessionOptions = async () => {
    const sel = $('#v2SessionSelect', view);
    const prev = sel.value;
    const r = await api('/api/status').catch(() => null);
    if (!r) { sel.textContent = ''; const o = document.createElement('option'); o.value = ''; o.textContent = '无法加载白名单'; sel.appendChild(o); return; }
    const options = [{ value: '', label: '选择白名单群/私聊…' }];
    for (const g of r.allowGroups || []) options.push({ value: 'group:' + g, label: '群 ' + g });
    for (const p of r.allowPrivate || []) options.push({ value: 'private:' + p, label: '私聊 ' + p });
    sel.textContent = '';
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    }
    if (prev && options.some((o) => o.value === prev)) sel.value = prev;
  };

  // 保存后回填成服务端实际接受的值（钳制过的），避免界面与配置不一致
  fillForm(view, {});
  await loadConfig();
  await refreshActivity();
  loadToolLog();
  loadSessionOptions();

  // 基线要在表单填好之后建，否则「刚加载出来的值」会被当成用户改动
  const dirty = trackDirty(view, {
    selector: MANUAL_SELECTOR,
    label: '二代参数',
    onChange: (n) => {
      $('#v2DirtyHint', view).textContent = n ? `● 有 ${n} 项未保存` : '';
      $('#v2ConfigSave', view).classList.toggle('dirty', n > 0);
      $('#v2ConfigSaveTop', view).classList.toggle('dirty', n > 0);
    }
  });

  // 所有开关（含 36 个工具开关）都是拨动即写盘
  view.addEventListener('change', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || el.type !== 'checkbox') return;
    if (el.dataset.v2Tool) { saveToolSwitch(el); return; }
    const field = SWITCH_FIELDS.find((f) => f.id === el.id);
    if (!field) return;
    const patch = {};
    setPath(patch, field.path, el.checked);
    saveSwitch(el, patch);
  });
  $('#v2ToolsAllOn', view).addEventListener('click', () => setAllTools(true));
  $('#v2ToolsAllOff', view).addEventListener('click', () => setAllTools(false));

  $('#v2ConfigSave', view).addEventListener('click', async () => {
    const r = await saveConfig();
    if (r.ok) dirty.markClean();
  });
  $('#v2ConfigSaveTop', view).addEventListener('click', async () => {
    const r = await saveConfig();
    if (r.ok) dirty.markClean();
  });

  $('#v2PauseBtn', view).addEventListener('click', async () => {
    await api('/api/socialV2/activity', 'POST', { paused: true }).catch(() => {});
    refreshActivity();
  });
  $('#v2ResumeBtn', view).addEventListener('click', async () => {
    await api('/api/socialV2/activity', 'POST', { paused: false }).catch(() => {});
    refreshActivity();
  });
  $('#v2ResetBtn', view).addEventListener('click', async () => {
    if (!confirmDanger('确定重置二代 AI 状态？\n将清空所有二代会话、唤醒配置、未读消息和定时器；工具调用日志会保留。')) return;
    const r = await api('/api/socialV2/reset', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#v2ConfigMsg', view), r.ok ? '✅ 已重置二代状态' : ('❌ ' + (r.error || '失败')), r.ok);
    $('#v2AllStatesOutput', view).textContent = '（全部会话状态：空）';
    $('#v2StateOutput', view).textContent = '（空）';
    refreshActivity();
  });
  $('#v2StateView', view).addEventListener('click', async () => {
    const key = $('#v2StateKey', view).value.trim();
    if (!key) { toast('请输入会话 key', 'err'); return; }
    const r = await api('/api/socialV2/state?key=' + encodeURIComponent(key)).catch((e) => ({ ok: false, error: e.message }));
    $('#v2StateOutput', view).textContent = JSON.stringify(r, null, 2);
  });
  $('#v2ForceWake', view).addEventListener('click', async () => {
    const key = $('#v2StateKey', view).value.trim();
    if (!key) { toast('请输入会话 key', 'err'); return; }
    const r = await api('/api/socialV2/wake', 'POST', { key, reason: 'admin' }).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#v2ConfigMsg', view), r.ok ? '✅ 已发送唤醒' : ('❌ ' + (r.error || '失败')), r.ok);
  });
  $('#v2StatesList', view).addEventListener('click', async () => {
    const r = await api('/api/socialV2/states').catch(() => null);
    $('#v2AllStatesOutput', view).textContent = JSON.stringify(r?.conversations || [], null, 2);
  });

  $('#v2FeedbackLoad', view).addEventListener('click', async () => {
    const r = await api('/api/socialV2/feedback').catch(() => null);
    $('#v2FeedbackOutput', view).textContent = JSON.stringify(r?.entries || [], null, 2);
  });
  $('#v2FeedbackClear', view).addEventListener('click', async () => {
    if (!confirmDanger('确定清空全部 AI 反馈？')) return;
    const r = await api('/api/socialV2/feedback-clear', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#v2FeedbackMsg', view), r.ok ? '✅ 已清空' : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) $('#v2FeedbackOutput', view).textContent = '（空）';
  });

  $('#v2ToolLogLoad', view).addEventListener('click', () => { setMsg($('#v2ToolLogMsg', view), '', true); loadToolLog(); });
  $('#v2ToolLogClear', view).addEventListener('click', async () => {
    if (!confirmDanger('确定清空全部工具调用日志？')) return;
    const r = await api('/api/socialV2/tool-log/clear', 'POST', {}).catch((e) => ({ ok: false, error: e.message }));
    setMsg($('#v2ToolLogMsg', view), r.ok ? '✅ 已清空' : ('❌ ' + (r.error || '失败')), r.ok);
    renderToolLog(view, []);
  });

  // 工具日志单元格点击展开/收起完整 JSON
  delegate($('#v2ToolLogOutput', view), 'click', '.tool-log-cell', (_ev, cell) => {
    if (cell.classList.contains('expanded')) {
      cell.classList.remove('expanded');
      cell.textContent = cell.dataset.short;
    } else {
      cell.classList.add('expanded');
      cell.textContent = cell.dataset.full;
    }
  });

  $('#v2MemoryLoad', view).addEventListener('click', loadMemory);
  $('#v2MemoryClearAll', view).addEventListener('click', async () => {
    const key = $('#v2MemoryKey', view).value.trim();
    const msg = $('#v2MemoryMsg', view);
    if (!key) { setMsg(msg, '请输入会话 key', false); return; }
    if (!confirmDanger('确定清空该会话全部轻量记忆？')) return;
    const r = await api('/api/socialV2/memory-clear', 'POST', { key, category: '' }).catch((e) => ({ ok: false, error: e.message }));
    setMsg(msg, r.ok ? '✅ 已清空全部记忆' : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) loadMemory();
  });
  delegate($('#v2MemoryOutput', view), 'click', 'button[data-action]', async (_ev, btn) => {
    const key = $('#v2MemoryKey', view).value.trim();
    const msg = $('#v2MemoryMsg', view);
    if (!key) { setMsg(msg, '请输入会话 key', false); return; }
    const cat = btn.dataset.cat;
    let r;
    if (btn.dataset.action === 'remark-edit') {
      // 短名|说明 两段式：说明里可以有 '|'，所以只按第一个分隔符切。
      const cur = [btn.dataset.remark || '', btn.dataset.note || ''].join('|');
      const input = prompt(`编辑 QQ ${btn.dataset.user} 的成员备注（短名|说明，说明可留空）：`, cur);
      if (input === null) return;
      const idx = input.indexOf('|');
      const remark = (idx >= 0 ? input.slice(0, idx) : input).trim();
      const note = idx >= 0 ? input.slice(idx + 1).trim() : '';
      r = await api('/api/socialV2/member-remark', 'POST', { key, userId: btn.dataset.user, remark, note });
    } else if (btn.dataset.action === 'remark-remove') {
      if (!confirmDanger(`确定删除 QQ ${btn.dataset.user} 的成员备注？`)) return;
      r = await api('/api/socialV2/member-remark-remove', 'POST', { key, userId: btn.dataset.user });
    } else if (btn.dataset.action === 'clear') {
      r = await api('/api/socialV2/memory-clear', 'POST', { key, category: cat });
    } else if (btn.dataset.action === 'edit') {
      const label = cat === 'memberImpression' ? `编辑对 ${btn.dataset.target} 的印象特质（逗号分隔）：` : `编辑${cat === 'activeTopic' ? '话题' : '想法'}内容：`;
      const input = prompt(label, cat === 'memberImpression' ? (btn.dataset.traits || '') : (btn.dataset.content || ''));
      if (input === null) return;
      r = await api('/api/socialV2/memory-update', 'POST', {
        key, category: cat, oldContent: btn.dataset.content || '', target: btn.dataset.target || '', newContent: input, newExtra: {}
      });
    } else {
      r = await api('/api/socialV2/memory-remove', 'POST', { key, category: cat, content: btn.dataset.content || '', target: btn.dataset.target || '' });
    }
    setMsg(msg, r.ok ? '✅ 已更新' : ('❌ ' + (r.error || '失败')), r.ok);
    if (r.ok) loadMemory();
  });

  $('#v2WakeStatusLoad', view).addEventListener('click', loadWakeStatus);
  $('#v2SessionRefresh', view).addEventListener('click', loadSessionOptions);
  $('#v2SessionSelect', view).addEventListener('change', (ev) => {
    const key = ev.target.value;
    if (!key) return;
    $('#v2StateKey', view).value = key;
    $('#v2MemoryKey', view).value = key;
    $('#v2WakeKey', view).value = key;
  });

  // ── 工具级配置弹窗 ────────────────────────────────────────────────
  // 弹窗是「设置对话框」语义：里面全是表单字段，点保存才写盘。
  // 所以这里的布尔项保持普通勾选框（不做成开关），但同样要有「未保存」提示与关闭确认，
  // 否则改完点取消/按 Esc 会静默丢掉改动 —— 和主表单之前的问题一模一样。
  const modalDirty = trackDirty(view, {
    selector: '#v2CfgBody [data-v2-cfg-field]',
    label: '工具配置弹窗',
    // ⚙ 按钮在 view 里但在弹窗之外：点开弹窗不算「碰过弹窗里的字段」，
    // 否则紧接着的浏览器自动填充（密码框尤其常见）会被当成用户改动。
    interactionScope: '#v2CfgBody',
    onChange: (n) => {
      $('#v2CfgDirtyHint', view).textContent = n ? `● 有 ${n} 项未保存` : '';
      $('#v2CfgSave', view).classList.toggle('dirty', n > 0);
    }
  });
  state.modalDirty = modalDirty;

  const openToolCfg = async (section) => {
    if (!CFG_SCHEMA[section]) return;
    if (section === 'bili') state.bili = await api('/api/bili/status').catch(() => null);
    if (!state.config) await loadConfig();
    state.cfgSection = section;
    setMsg($('#v2CfgMsg', view), '', true);
    renderToolCfg(view, section);
    $('#v2CfgBackdrop', view).classList.add('open');
  };
  const closeToolCfg = (force = false) => {
    if (!force && modalDirty.count() > 0
      && !confirmDanger(`工具配置里还有 ${modalDirty.count()} 项没保存，确定关闭？`)) return;
    $('#v2CfgBackdrop', view)?.classList.remove('open');
    state.cfgSection = null;
  };

  const saveBiliCfg = async () => {
    const msg = $('#v2CfgMsg', view);
    const val = (path, d) => cfgFieldEl(view, path)?.value ?? d;
    const chk = (path, d) => cfgFieldEl(view, path)?.checked ?? d;
    const num = (path, d) => { const n = Number(val(path, d)); return Number.isFinite(n) ? n : d; };
    const lines = (path) => String(val(path, '')).split('\n').map((x) => x.trim()).filter(Boolean);
    const sessdata = String(val('sessdata', '')).trim();
    const targets = {
      keywords: lines('keywords'),
      bvids: lines('bvids'),
      mids: lines('mids'),
      cvs: lines('cvs'),
      sources: {
        cover: chk('sources.cover', true),
        comments: chk('sources.comments', true),
        dynamic: chk('sources.dynamic', true),
        detail: chk('sources.detail', false)
      },
      limit: num('limit', 40),
      dynamicPages: num('dynamicPages', 1),
      commentPages: num('commentPages', 1),
      minSide: num('minSide', 150),
      maxBytes: Math.round(num('maxBytes', 5) * 1048576),
      delayMs: num('delayMs', 900)
    };
    setMsg(msg, '保存中…', true);
    try {
      // 留空表示不动已有 cookie
      const payload = { targets };
      if (sessdata) payload.sessdata = sessdata;
      state.bili = await api('/api/bili/config', 'POST', payload);
      setMsg(msg, sessdata ? 'SESSDATA 与抓取目标已保存 ✓' : '抓取目标已保存 ✓', true);
      renderToolCfg(view, 'bili');
    } catch (e) {
      setMsg(msg, '保存失败：' + (e?.message ?? e), false);
    }
  };

  const saveToolCfg = async () => {
    if (!state.cfgSection) return;
    const schema = CFG_SCHEMA[state.cfgSection];
    if (schema.custom === 'bili') { await saveBiliCfg(); return; }
    const patch = {};
    for (const f of schema.fields) {
      const el = cfgFieldEl(view, f.path);
      if (!el) continue;
      let v;
      if (f.type === 'bool') v = el.checked;
      else if (f.type === 'number') {
        const n = Number(el.value);
        if (!Number.isFinite(n)) continue;
        v = f.factor ? Math.round(n * f.factor) : n;
      } else if (f.type === 'list') v = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
      else v = el.value.trim();
      setPath(patch, f.path, v);
    }
    const msg = $('#v2CfgMsg', view);
    setMsg(msg, '保存中…', true);
    try {
      // 服务端按分区合并，这里只提交当前分区的 patch
      await api('/api/socialV2/config', 'POST', { [state.cfgSection]: patch });
      setMsg(msg, '已保存 ✓', true);
      await loadConfig();
      renderToolCfg(view, state.cfgSection);
    } catch (e) {
      setMsg(msg, '保存失败：' + (e?.message ?? e), false);
    }
  };

  const handleCfgAction = async (action) => {
    const msg = $('#v2CfgMsg', view);
    if (action === 'bili-fetch') {
      setMsg(msg, '已触发抓取，后台运行中…', true);
      try {
        await api('/api/bili/fetch', 'POST', {});
        const refreshBili = async () => {
          state.bili = await api('/api/bili/status').catch(() => state.bili);
          if (state.cfgSection === 'bili') renderToolCfg(view, 'bili');
        };
        setTimeout(refreshBili, 8000);
        setTimeout(refreshBili, 25000);
      } catch (e) {
        setMsg(msg, '触发失败：' + (e?.message ?? e), false);
      }
      return;
    }
    if (action === 'bili-clear-cookie') {
      try {
        state.bili = await api('/api/bili/config', 'POST', { sessdata: '' });
        setMsg(msg, 'SESSDATA 已清除', true);
        renderToolCfg(view, 'bili');
      } catch (e) {
        setMsg(msg, '清除失败：' + (e?.message ?? e), false);
      }
    }
  };

  // 委托挂在 view 上（不是 document），切走分区后这些绑定自然失效
  view.addEventListener('mousedown', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-v2-cfg]')) e.preventDefault();
  }, true);
  view.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const cfgBtn = t.closest('[data-v2-cfg]');
    if (cfgBtn) { e.preventDefault(); e.stopPropagation(); openToolCfg(cfgBtn.dataset.v2Cfg); return; }
    if (t.closest('[data-v2-cfg-close]')) { e.preventDefault(); closeToolCfg(); return; }
    if (t.id === 'v2CfgBackdrop') { closeToolCfg(); return; }
    if (t.id === 'v2CfgSave') { e.preventDefault(); saveToolCfg(); return; }
    const act = t.closest('[data-v2-cfg-action]');
    if (act) { e.preventDefault(); handleCfgAction(act.dataset.v2CfgAction); }
  }, true);
  const onKey = (e) => { if (e.key === 'Escape') closeToolCfg(); };
  document.addEventListener('keydown', onKey);

  const stopActivity = every(5000, refreshActivity);

  return () => {
    dirty.dispose();
    modalDirty.dispose();
    state.modalDirty = null;
    stopActivity();
    document.removeEventListener('keydown', onKey);
  };
}
