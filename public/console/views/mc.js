// Minecraft：bot 状态 / 里程碑进度 / 背包 / 指令投递 / 日志
import { api } from '../core/api.js';
import { $, esc, toast } from '../core/dom.js';
import { every } from '../core/poll.js';
import { mountFragment } from '../core/fragments.js';

export const id = 'mc';
export const title = 'Minecraft';
export const desc = 'bot 状态 · 里程碑 · 背包 · 直播入口';
export const icon = 'cube';
export const group = '扩展';
export const order = 20;

const MILESTONE_TITLES = {
  1: '生存开局（砍树/工作台/木镐木剑）',
  2: '挖矿：铁制装备',
  3: '庇护所 / 床 / 重生点',
  4: '钻石装备',
  5: '黑曜石 / 下界传送门',
  6: '下界生存与资源',
  7: '找到下界堡垒',
  8: '烈焰人刷怪农场',
  9: '收集烈焰棒',
  10: '诡异森林生物群系',
  11: '末影珍珠',
  12: '合成末影之眼',
  13: '定位要塞',
  14: '激活末地传送门',
  15: '击败末影龙',
};

function fmtPos(p) {
  if (!p) return '—';
  return `${p.x}, ${p.y}, ${p.z}`;
}

function renderOverview(view, d) {
  const b = d.bot || {};
  const s = d.server || {};
  const rows = [
    ['bot 在线', b.online ? '<span class="pill g">在线</span>' : '<span class="pill r">离线</span>'],
    ['昵称 / 版本', `${esc(b.username || '—')} <span class="meta">${esc(b.version || '')}</span>`],
    ['位置', `${esc(fmtPos(b.position))} <span class="meta">${esc(b.dimension || '')}</span>`],
    ['血量 / 饥饿', `${b.health ?? '—'} / ${b.food ?? '—'}`],
    ['已加载区块', b.chunksLoaded ?? '—'],
    ['服务端进程', s.running ? `<span class="pill g">运行中</span> <span class="meta">PID ${s.pid}</span>` : '<span class="pill r">未运行</span>'],
    ['端口', s.listening ? `<span class="pill g">${s.port} 监听中</span>` : `<span class="pill r">${s.port} 未监听</span>`],
    ['模式 / 难度', `${esc(s.gamemode || '—')} / ${esc(s.difficulty || '—')}`],
    ['白名单', s.whitelist ? '<span class="pill b">开启</span>' : '关闭'],
    ['状态更新时间', b.updatedAt ? new Date(b.updatedAt).toLocaleString() : '—'],
  ];
  let html = '<div class="table-wrap"><table>';
  for (const [k, v] of rows) html += `<tr><th style="width:130px">${k}</th><td>${v}</td></tr>`;
  $('#mcOverview', view).innerHTML = html + '</table></div>';
}

function renderMilestones(view, ms) {
  const done = new Set(ms.done || []);
  const blocked = ms.blocked || {};
  // 总数按真实里程碑表算（15）。以前面板只有"peaceful 下可行 8 个"的概念，
  // 分母写成 8 会让人误以为一共只有 8 个里程碑。
  const TOTAL = Object.keys(MILESTONE_TITLES).length;
  let html = `<div class="meta" style="margin-bottom:6px">已完成 ${done.size}/${TOTAL}　`
    + `受阻 ${Object.keys(blocked).length}（peaceful 下刷不出怪）`
    + (ms.current ? `　进行中：#${ms.current}` : '') + '</div>';
  html += '<div class="table-wrap"><table><tr><th style="width:52px">#</th><th>里程碑</th><th style="width:110px">状态</th></tr>';
  for (let id = 1; id <= 15; id++) {
    const isBlocked = !!blocked[id];
    let status;
    if (done.has(id)) status = '<span class="pill g">已完成</span>';
    else if (isBlocked) status = '<span class="pill r">受阻</span>';
    else if (ms.current === id) status = '<span class="pill b">进行中</span>';
    else status = '<span class="meta">待办</span>';
    const why = isBlocked ? ` <span class="meta">${esc(blocked[id])}</span>` : '';
    html += `<tr><td>${id}</td><td>${esc(MILESTONE_TITLES[id] || '')}${why}</td><td>${status}</td></tr>`;
  }
  html += '</table></div>';
  if (ms.current) html += `<div class="meta" style="margin-top:6px">当前推进：里程碑 ${ms.current}</div>`;
  $('#mcMilestones', view).innerHTML = html;
}

function renderInventory(view, inv) {
  if (!inv || !inv.length) {
    $('#mcInventory', view).innerHTML = '<span class="meta">背包为空</span>';
    return;
  }
  $('#mcInventory', view).innerHTML = inv.map((x) => `<span class="pill">${esc(x)}</span>`).join(' ');
}

// AI 记忆：当前记忆 / 目标 / 教训库 / 经验流水。
// 三类的作用不同，分开展示 —— 混在一起会看不出"哪份在影响它的行为"。
function renderMemory(view, m) {
  const box = $('#mcMemory', view);
  if (!box) return;
  if (!m || m.known === false) {
    box.innerHTML = '<span class="meta">读不到 memory-state.json（笔记本上 mc-memory-export.timer 是否在跑？）</span>';
    const info0 = $('#mcMemInfo', view);
    if (info0) info0.textContent = '（无数据）';
    return;
  }
  const info = $('#mcMemInfo', view);
  if (info) {
    info.textContent = m.updatedAt ? `（更新于 ${new Date(m.updatedAt * 1000).toLocaleTimeString()}）` : '';
  }
  const rows = [
    ['记忆字数', `<b>${m.memoryChars}</b> <span class="meta">（上限已取消）</span>`],
    ['教训条数', `${m.lessonsLines} 行`],
    ['经验流水', `${m.experience?.entries ?? 0} 条 / ${Math.round((m.experience?.chars ?? 0) / 1000)}k 字`],
    ['对话窗口', `${m.turns?.count ?? 0} 条 / ${m.turns?.chars ?? 0} 字`],
  ];
  let html = '<div class="table-wrap"><table>';
  for (const [k, v] of rows) html += `<tr><th style="width:130px">${k}</th><td>${v}</td></tr>`;
  html += '</table></div>';

  // 「总目标」以 MISSION.md 为准。自驱模式下才有 selfPromptGoal，
  // 里程碑任务模式下 turns 里没有那段话（踩过：一开始从 turns 抠 goal，取到空）。
  const ms = m.milestone || {};
  if (m.goal) {
    const mline = ms.current
      ? `<span class="meta">当前第 ${ms.current}/${ms.total ?? 15} 个：${esc(ms.currentTitle || '')}</span>`
      : '';
    html += `<div class="meta" style="margin-top:8px"><b>总目标</b>（MISSION.md，15 个里程碑）${mline}</div>
      <pre style="max-height:26vh;overflow:auto;white-space:pre-wrap;margin:4px 0">${esc(m.goal)}</pre>`;
  }
  if (m.selfPromptGoal) {
    html += `<div class="meta" style="margin-top:8px"><b>自驱目标</b>（仅在自驱模式下存在）</div>
      <pre style="white-space:pre-wrap;margin:4px 0">${esc(m.selfPromptGoal)}</pre>`;
  }
  html += `<div class="meta" style="margin-top:8px"><b>当前记忆</b>（每轮注入提示词，${m.memoryChars} 字）</div>
    <pre style="max-height:32vh;overflow:auto;white-space:pre-wrap;margin:4px 0">${esc(m.memory || '（空）')}</pre>`;
  html += `<div class="meta" style="margin-top:8px"><b>长期教训库</b>（只增不删，每轮完整注入，${m.lessonsLines} 行）</div>
    <pre style="max-height:28vh;overflow:auto;white-space:pre-wrap;margin:4px 0">${esc(m.lessons || '（空）')}</pre>`;

  const tail = m.experience?.tail || [];
  if (tail.length) {
    html += `<div class="meta" style="margin-top:8px"><b>经验流水</b>（最近 ${tail.length} 条，只写不读）</div>`;
    html += '<div style="max-height:34vh;overflow:auto">';
    for (const it of tail.slice().reverse()) {
      html += `<div style="margin:6px 0;padding-left:8px;border-left:2px solid rgba(255,255,255,.12)">
        <span class="meta">${esc(it.at || '')} · ${it.chars ?? 0} 字</span>
        <pre style="white-space:pre-wrap;margin:2px 0">${esc(it.text || '')}</pre></div>`;
    }
    html += '</div>';
  }
  box.innerHTML = html;
}

async function refresh(view) {
  const d = await api('/api/mc/status').catch(() => null);
  if (!d) return;
  renderOverview(view, d);
  renderMilestones(view, d.milestones || {});
  renderInventory(view, d.bot?.inventory);
  // 记忆单独一个接口（体积大），失败不影响其余面板
  const mem = await api('/api/mc/memory').catch(() => null);
  renderMemory(view, mem);
  const vs = $('#mcViewerState', view);
  if (vs) {
    vs.className = 'pill ' + (d.viewer?.running ? 'g' : 'r');
    vs.textContent = d.viewer?.running ? '直播服务正常' : '直播服务未运行';
  }
  const link = $('#mcViewerLink', view);
  if (link && d.viewer?.publicUrl) link.href = d.viewer.publicUrl;
}

// 日志行数由下拉框决定：'all' 表示全部历史。
// 默认给 1000 行而不是"全部"，是因为这个页面是经 anihub 反代在公网上看的，
// 每次轮询都拉整份历史太费流量；要看全部点下拉框或"下载全部"。
let _mcLogToolsBound = false;

function mcLogWanted(view) {
  const sel = $('#mcLogLimit', view);
  return sel && sel.value ? sel.value : '1000';
}

function bindLogTools(view) {
  if (_mcLogToolsBound) return;
  _mcLogToolsBound = true;
  const sel = $('#mcLogLimit', view);
  if (sel) sel.addEventListener('change', () => refreshLog(view));
  const btn = $('#mcLogRefresh', view);
  if (btn) btn.addEventListener('click', () => refreshLog(view));
  const dl = $('#mcLogDownload', view);
  if (dl) dl.addEventListener('click', async () => {
    dl.textContent = '打包中…';
    const all = await api('/api/mc/log?limit=all').catch(() => null);
    dl.textContent = '下载全部';
    if (!all?.lines) return;
    const blob = new Blob([all.lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    a.download = `bot-log-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
}

async function refreshLog(view) {
  const want = mcLogWanted(view);
  const r = await api(`/api/mc/log?limit=${want === 'all' ? 'all' : want}`).catch(() => null);
  if (!r?.lines) return;
  const box = $('#mcLog', view);
  box.textContent = r.lines.join('\n');
  const info = $('#mcLogInfo', view);
  if (info) {
    info.textContent = `（文件共 ${r.total ?? '?'} 行，本次显示 ${r.lines.length} 行）`;
  }
  // 全量看的时候停在开头，看增量时停在结尾
  box.scrollTop = want === 'all' ? 0 : box.scrollHeight;
  bindLogTools(view);
}

// ———————————————————————————— B站直播 / 推流 ————————————————————————————
const LIVE_STATE_TEXT = { 1: ['直播中', 'g'], 2: ['轮播中', 'b'], 0: ['未开播', ''] };

async function refreshStream(view) {
  const d = await api('/api/mc/stream').catch(() => null);
  if (!d?.ok) return;

  // 直播间状态
  const st = LIVE_STATE_TEXT[d.room?.liveStatus ?? 0] || ['未知', ''];
  const livePill = $('#mcLiveState', view);
  if (livePill) { livePill.className = 'pill ' + st[1]; livePill.textContent = st[0]; }
  const url = $('#mcLiveUrl', view);
  if (url && d.room?.roomId) {
    url.href = d.room.url || `https://live.bilibili.com/${d.room.roomId}`;
    url.textContent = `live.bilibili.com/${d.room.roomId}`;
  }
  const meta = $('#mcLiveMeta', view);
  if (meta) {
    const bits = [];
    if (d.room?.title) bits.push(`标题：${d.room.title}`);
    if (d.room?.areaId) bits.push(`分区：${d.room.areaId}`);
    if (d.room?.updatedAt) bits.push(`状态更新：${new Date(d.room.updatedAt).toLocaleTimeString()}`);
    meta.textContent = bits.join('　');
  }

  // 推流进程
  const p = d.push || {};
  const pushPill = $('#mcPushState', view);
  if (pushPill) {
    pushPill.className = 'pill ' + (p.running ? 'g' : 'r');
    pushPill.textContent = p.running ? `运行中 (PID ${p.pid})` : '未运行';
  }
  const stats = $('#mcPushStats', view);
  if (stats) {
    const s = p.stats;
    const bits = [];
    if (s) bits.push(`实测 ${s.fps}fps`, `已编码 ${s.frames} 帧`, `丢 ${s.dropped} 帧`, `投射 ${s.rayMs}ms`, `合成 ${s.composeMs}ms`);
    if (p.logAgeSec != null) bits.push(`日志 ${p.logAgeSec}s 前`);
    bits.push(d.hasPushUrl ? '推流码已就绪' : '注意：还没有推流码（先点「开播」）');
    if (d.pushUrlMasked) bits.push(d.pushUrlMasked);
    stats.textContent = bits.join('　');
  }

  // 人脸认证提示（B站 60043）
  const face = $('#mcFaceAuth', view);
  if (face) {
    face.innerHTML = d.live?.faceAuth
      ? `<span class="pill r">需要人脸认证</span> <a href="${esc(d.live.faceAuth)}" target="_blank" rel="noreferrer">在手机上完成核验</a> <span class="meta">（做完再点一次「开播」）</span>`
      : '';
  }

  const liveLog = $('#mcLiveLog', view);
  if (liveLog) {
    liveLog.textContent = (d.live?.lastOutput || []).join('\n');
    liveLog.scrollTop = liveLog.scrollHeight;
  }
}

async function refreshStreamLog(view) {
  const r = await api('/api/mc/stream/log?limit=40').catch(() => null);
  if (!r?.lines) return;
  const box = $('#mcStreamLog', view);
  if (!box) return;
  box.textContent = r.lines.join('\n');
  box.scrollTop = box.scrollHeight;
}

async function liveAction(view, action) {
  const title = ($('#mcLiveTitle', view)?.value || '').trim();
  const r = await api('/api/mc/live', 'POST', { action, title }).catch((e) => ({ ok: false, error: e.message }));
  toast(r?.ok ? `已下发：${action}（几秒后看状态）` : `失败：${r?.error || '未知错误'}`, r?.ok ? 'ok' : 'err');
}

async function pushAction(view, action) {
  const r = await api('/api/mc/stream/action', 'POST', { action }).catch((e) => ({ ok: false, error: e.message }));
  toast(r?.ok ? `已下发：${action}（几秒后看状态）` : `失败：${r?.error || '未知错误'}`, r?.ok ? 'ok' : 'err');
}

// ———————————————————— 整机控制（笔记本上的服务启停 / 待机封面）————————————————————
// 这些动作走 SSH 到笔记本，每个约 1~5 秒；「一键」会按依赖顺序逐个等就绪。
const SVC_META = {
  server:    { name: '服务端 mcserver',    note: '世界本体；停它整个世界下线' },
  client:    { name: '游戏客户端 mcvanilla', note: '抓屏画面源；停它推流就没画面' },
  ai:        { name: 'AI mcmind',          note: 'Mindcraft；占 deepseek 账号' },
  legacyBot: { name: '旧 bot mcbot',       note: '与 AI 同名互斥，别和 AI 同时开' },
  capture:   { name: '推流 mccapture',      note: '抓屏→NVENC→B站' },
  camera:    { name: '跟随相机 mcfollow',   note: '把相机 tp 到 AI 视角' },
  camguard:  { name: '相机守护 mccamguard', note: '保旁观者+夜视' },
  hotbar:    { name: '快捷栏 hotbar-sync',  note: '把 AI 物品刷到直播客户端' },
  watchdog:  { name: '里程碑看门狗',        note: 'AI 停了会反复拉起来' },
};
const SVC_ORDER = Object.keys(SVC_META);

// 一键启动：必须按依赖顺序，否则客户端连不上服务端、推流抓不到画面
const BRING_UP = [
  ['server', 8], ['client', 30], ['camguard', 8], ['camera', 8],
  ['ai', 45], ['watchdog', 5], ['capture', 40],
];
// 一键停止：反着来，先断推流再停画面源
const BRING_DOWN = ['watchdog', 'capture', 'ai', 'legacyBot', 'camera', 'camguard', 'client', 'server'];

let svcBusy = false;

function svcRowHtml(key, info) {
  const m = SVC_META[key] || { name: key, note: '' };
  const active = info?.active || 'unknown';
  const cls = active === 'active' ? 'ok' : (active === 'failed' ? 'err' : '');
  const en = info?.enabled === 'enabled' ? '开机自启' : (info?.enabled || '');
  return `<div class="row" style="flex-wrap:wrap;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)">
    <span style="min-width:190px">${esc(m.name)}</span>
    <span class="pill ${cls}" style="min-width:78px;text-align:center">${esc(active)}</span>
    <span class="meta" style="min-width:66px">${esc(en)}</span>
    <span class="meta" style="flex:1;min-width:140px">${esc(m.note)}</span>
    <button class="small" data-svc="${key}" data-act="start">启动</button>
    <button class="small" data-svc="${key}" data-act="stop">停止</button>
    <button class="small" data-svc="${key}" data-act="restart">重启</button>
  </div>`;
}

async function refreshServices(view) {
  const r = await api('/api/mc/services').catch((e) => ({ ok: false, error: e.message }));
  if (!r?.ok) {
    $('#mcServices', view).innerHTML = `<span class="meta">读取失败：${esc(r?.error || '未知错误')}</span>`;
    $('#mcSvcSummary', view).textContent = '';
    return;
  }
  const svc = r.services || {};
  $('#mcServices', view).innerHTML = SVC_ORDER.map((k) => svcRowHtml(k, svc[k])).join('');
  const up = SVC_ORDER.filter((k) => svc[k]?.active === 'active' && k !== 'legacyBot').length;
  $('#mcSvcSummary', view).textContent = `运行中 ${up}/${SVC_ORDER.length - 1}`;
}

function showSvcLog(view, text) {
  const el = $('#mcSvcLog', view);
  if (!el) return;
  el.style.display = text ? 'block' : 'none';
  el.textContent = text || '';
}

async function oneService(view, key, action) {
  const m = SVC_META[key] || { name: key };
  showSvcLog(view, `→ ${m.name} ${action} …`);
  const r = await api('/api/mc/service', 'POST', { key, action }).catch((e) => ({ ok: false, error: e.message }));
  const line = r?.ok
    ? `✅ ${m.name} ${action} → state=${r.state} enabled=${r.enabled}\n${r.detail || ''}`
    : `❌ ${m.name} ${action} 失败：${r?.error || '未知错误'}`;
  showSvcLog(view, line.trim());
  toast(r?.ok ? `${m.name}：${action} 完成（${r.state}）` : `失败：${r?.error || '未知错误'}`, r?.ok ? 'ok' : 'err');
  await refreshServices(view);
}

// 等某个服务到达期望状态（轮询 /api/mc/services），最多等 timeoutMs
async function waitSvc(key, expect, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const d = await api('/api/mc/services').catch(() => null);
    const st = d?.services?.[key]?.active;
    if (Array.isArray(expect) ? expect.includes(st) : st === expect) return st;
  }
  return 'timeout';
}

async function allUp(view) {
  showSvcLog(view, '按依赖顺序启动中（服务端→客户端→相机→AI→看门狗→推流）…');
  const lines = [];
  for (const [key, wait] of BRING_UP) {
    const m = SVC_META[key]?.name || key;
    const r = await api('/api/mc/service', 'POST', { key, action: 'start' }).catch((e) => ({ ok: false, error: e.message }));
    lines.push(`→ ${m} start: ${r?.ok ? r.state : '失败 ' + (r?.error || '')}`);
    showSvcLog(view, lines.join('\n'));
    if (!r?.ok) continue;
    const st = await waitSvc(key, ['active', 'failed'], wait * 1000);
    lines.push(`   等待就绪：${st}`);
    showSvcLog(view, lines.join('\n'));
  }
  lines.push('—— 启动流程结束 ——');
  showSvcLog(view, lines.join('\n'));
  toast('一键启动流程结束，看下方日志', 'ok');
  await refreshServices(view);
}

async function allDown(view) {
  showSvcLog(view, '按反序停止（看门狗→推流→AI→相机→客户端→服务端）…');
  const lines = [];
  for (const key of BRING_DOWN) {
    const m = SVC_META[key]?.name || key;
    const r = await api('/api/mc/service', 'POST', { key, action: 'stop' }).catch((e) => ({ ok: false, error: e.message }));
    lines.push(`→ ${m} stop: ${r?.ok ? r.state : '失败 ' + (r?.error || '')}`);
    showSvcLog(view, lines.join('\n'));
  }
  lines.push('—— 停止流程结束 ——');
  showSvcLog(view, lines.join('\n'));
  toast('一键停止流程结束，看下方日志', 'ok');
  await refreshServices(view);
}

async function standbyAction(view, action) {
  const r = await api('/api/mc/standby', 'POST', { action }).catch((e) => ({ ok: false, error: e.message }));
  if (r?.ok) {
    toast(action === 'on' ? '已切到待机封面' : '已切回游戏画面', 'ok');
    showSvcLog(view, r.detail || '');
  } else {
    toast(`失败：${r?.error || '未知错误'}`, 'err');
  }
  await refreshStandby(view);
}

async function refreshStandby(view) {
  const r = await api('/api/mc/standby').catch(() => null);
  const el = $('#mcStandbyState', view);
  if (!el) return;
  const mode = r?.mode || '';
  el.textContent = mode || (r?.ok ? '未知' : '读取失败');
  el.className = 'pill ' + (mode === 'standby' ? 'warn' : (mode === 'live' ? 'ok' : ''));
}


// ———————————————————————————— 画质配置 ————————————————————————————
let presetsCache = null;

function fillConfigForm(view, cfg) {
  const set = (id, v) => { const el = $(id, view); if (el && v !== undefined && v !== null) el.value = v; };
  set('#mcCfgW', cfg.w); set('#mcCfgH', cfg.h);
  set('#mcCfgRW', cfg.rw); set('#mcCfgRH', cfg.rh);
  set('#mcCfgFps', cfg.fps); set('#mcCfgBitrate', cfg.bitrate); set('#mcCfgRadius', cfg.radius);
  // 命中预设就选中它，否则显示「自定义」
  const sel = $('#mcCfgPreset', view);
  if (sel && presetsCache) {
    const hit = Object.entries(presetsCache).find(([, p]) => p.w === cfg.w && p.h === cfg.h);
    sel.value = hit ? hit[0] : '';
  }
}

async function loadConfig(view) {
  const r = await api('/api/mc/stream/config').catch(() => null);
  if (!r?.ok) return;
  presetsCache = r.presets || null;
  fillConfigForm(view, r.config || {});
}

async function saveConfig(view) {
  const num = (id) => Number($(id, view)?.value);
  const payload = {
    w: num('#mcCfgW'), h: num('#mcCfgH'),
    rw: num('#mcCfgRW'), rh: num('#mcCfgRH'),
    fps: num('#mcCfgFps'), bitrate: ($('#mcCfgBitrate', view)?.value || '').trim(),
    radius: num('#mcCfgRadius'),
  };
  const r = await api('/api/mc/stream/config', 'POST', payload).catch((e) => ({ ok: false, error: e.message }));
  if (!r?.ok) { toast('保存失败：' + (r?.error || '未知错误'), 'err'); return; }
  fillConfigForm(view, r.config || payload);
  toast(`已保存 ${r.config.w}×${r.config.h}@${r.config.fps}fps，正在重启推流…`, 'ok');
  // 画质要重启渲染进程才生效，这里顺手重启，省得再点一次
  await pushAction(view, 'restart');
}

export function applyPreset(view) {
  const sel = $('#mcCfgPreset', view);
  const p = sel && presetsCache ? presetsCache[sel.value] : null;
  if (p) fillConfigForm(view, { ...p, radius: Number($('#mcCfgRadius', view)?.value) || 28 });
}

async function sendCommand(view) {
  const input = $('#mcCmd', view);
  const cmd = (input.value || '').trim();
  if (!cmd) return;
  const r = await api('/api/mc/command', 'POST', { command: cmd }).catch((e) => ({ ok: false, error: e.message }));
  if (r?.ok) {
    toast('已投递：' + cmd, 'ok');
    input.value = '';
  } else {
    toast('投递失败：' + (r?.error || '未知错误'), 'err');
  }
}

export async function mount(root) {
  const view = await mountFragment(root, 'mc');
  await refresh(view);
  await refreshLog(view);
  await refreshStream(view);
  await refreshStreamLog(view);
  const stopA = every(5000, () => refresh(view));
  const stopB = every(5000, () => refreshLog(view));
  const stopC = every(4000, () => refreshStream(view));
  const stopD = every(5000, () => refreshStreamLog(view));

  $('#mcCmdSend', view).addEventListener('click', () => sendCommand(view));
  $('#mcCmd', view).addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') sendCommand(view);
  });

  // 直播：开播 / 下播 / 刷新房间状态
  $('#mcLiveStart', view)?.addEventListener('click', () => liveAction(view, 'start'));
  $('#mcLiveStop', view)?.addEventListener('click', () => liveAction(view, 'stop'));
  $('#mcLiveRefresh', view)?.addEventListener('click', () => liveAction(view, 'status'));
  // 推流进程：启动 / 重启 / 停止
  $('#mcPushStart', view)?.addEventListener('click', () => pushAction(view, 'start'));
  $('#mcPushRestart', view)?.addEventListener('click', () => pushAction(view, 'restart'));
  $('#mcPushStop', view)?.addEventListener('click', () => pushAction(view, 'stop'));
  // 画质：预设下拉 + 保存（保存后自动重启推流）
  $('#mcCfgPreset', view)?.addEventListener('change', () => applyPreset(view));
  $('#mcCfgSave', view)?.addEventListener('click', () => saveConfig(view));
  await loadConfig(view);

  // 整机控制：服务启停（事件委托，行是动态渲染的）
  $('#mcSvcRefresh', view)?.addEventListener('click', async () => {
    toast('正在读取（SSH 查询约 2~3 秒）…', 'info');
    await refreshServices(view);
    await refreshStandby(view);
  });
  $('#mcServices', view)?.addEventListener('click', (ev) => {
    const btn = ev.target?.closest?.('button[data-svc]');
    if (!btn || svcBusy) return;
    svcBusy = true;
    oneService(view, btn.dataset.svc, btn.dataset.act).finally(() => { svcBusy = false; });
  });
  $('#mcAllUp', view)?.addEventListener('click', () => {
    if (svcBusy) return;
    svcBusy = true;
    allUp(view).finally(() => { svcBusy = false; });
  });
  $('#mcAllDown', view)?.addEventListener('click', () => {
    if (svcBusy) return;
    svcBusy = true;
    allDown(view).finally(() => { svcBusy = false; });
  });
  // 待机封面
  $('#mcStandbyOn', view)?.addEventListener('click', () => standbyAction(view, 'on'));
  $('#mcStandbyOff', view)?.addEventListener('click', () => standbyAction(view, 'off'));
  $('#mcStandbyRefresh', view)?.addEventListener('click', () => refreshStandby(view));

  // 功耗 / 频率：档位按钮（事件委托）+ 手动应用

  // 首次读一次服务状态、待机模式、功耗策略（不阻塞其它卡片）
  refreshServices(view);
  refreshStandby(view);

  return () => { stopA(); stopB(); stopC(); stopD(); };
}
