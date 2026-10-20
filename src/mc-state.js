// MC（Minecraft）状态聚合 —— 给控制台和 MCP 工具用的只读视图。
//
// 数据来源是 bot 自己写的状态文件（同机同用户，直接读盘，不额外开 HTTP 服务）：
//   /home/wx/mc/bot/bot-state.json        —— bot 在线状态/位置/血量/背包
//   /home/wx/mc/bot/milestone-state.json  —— 15 个里程碑的进度
//   /home/wx/mc/server/logs/server.pid    —— 服务端进程
//
// 只读，不写任何 MC 侧文件；bot 的命令投递走 bot-command.txt（见 postCommand）。
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { readJsonSafe } from './json-store.js';

const MC_ROOT = process.env.MC_ROOT || '/home/wx/mc';
const BOT_DIR = path.join(MC_ROOT, 'bot');
const SERVER_DIR = path.join(MC_ROOT, 'server');

function readTextSafe(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 探测端口是否有监听者（用 TCP 连接，比 ss 更省事且无外部依赖） */
function portListening(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** 当前 bot 状态 */
function botState() {
  const s = readJsonSafe(path.join(BOT_DIR, 'bot-state.json'), null);
  if (!s) return { known: false };
  return {
    known: true,
    online: !!s.online,
    username: s.username ?? null,
    server: s.server ?? null,
    version: s.version ?? null,
    position: s.position ?? null,
    dimension: s.dimension ?? null,
    gameMode: s.gameMode ?? null,
    health: s.health ?? null,
    food: s.food ?? null,
    blockBelow: s.blockBelow ?? null,
    blockAtFeet: s.blockAtFeet ?? null,
    // bot 自己在做什么（HUD 上也显示这个）
    intent: s.intent ?? null,
    recentActions: Array.isArray(s.recentActions) ? s.recentActions : [],
    chunksLoaded: s.chunksLoaded ?? null,
    inventory: Array.isArray(s.inventory) ? s.inventory : [],
    players: Array.isArray(s.players) ? s.players : [],
    uptimeSec: s.uptimeSec ?? null,
    updatedAt: s.updatedAt ?? null,
  };
}

/** 里程碑进度 */
function milestoneState() {
  const st = readJsonSafe(path.join(BOT_DIR, 'milestone-state.json'), null);
  // 复刻 milestones.js 的定义（保持字段一致；MC 侧是权威定义，这里只做展示）
  const blocked = { 8: 'peaceful 难度下烈焰人不刷新', 9: '烈焰棒只能由烈焰人掉落（依赖 8）', 11: 'peaceful 难度下末影人不刷新', 12: '需要末影珍珠(11)+烈焰粉(9)', 13: '需要末影之眼(12)', 14: '需要末影之眼(12)', 15: '需要激活的末地传送门(14)' };
  const done = st?.done ?? {};
  const skipped = st?.skipped ?? {};
  const feasible = [1, 2, 3, 4, 5, 6, 7, 10];

  // 关键：里程碑完成状态存在**顶层 `completed` 数组**里，不是 `done[id].__complete`。
  //
  // 踩过的坑：早期把 `__complete` 挂在 `done[id]` 这个数组上当属性，
  // 但 JSON.stringify **只序列化数组下标**，自定义属性直接丢掉，
  // 于是落盘后永远读不回来。bot 那边因此每重启一次就把已完成里程碑重跑一遍，
  // 这里也一直显示 current=1 / done=[]（实测：bot 明明在跑里程碑 4，
  // 面板却显示"当前 1、已完成 无"）。
  // `completed` 是普通数组元素，能正常落盘；`__complete` 只作为旧数据兜底。
  const legacyDone = Object.keys(done)
    .map(Number)
    .filter((id) => done[id]?.__complete);
  const doneIds = Array.isArray(st?.completed) ? [...st.completed] : legacyDone;
  if (Array.isArray(st?.completed)) {
    for (const id of legacyDone) if (!doneIds.includes(id)) doneIds.push(id);
  }
  // current 以 bot 写下的为准（它可能正在跑一个"已完成集合里最后一个"之外的里程碑）
  const firstPending = feasible.find((id) => !doneIds.includes(id)) ?? null;
  const current = Number.isInteger(st?.current) ? st.current : firstPending;

  return {
    known: !!st,
    current,
    firstPending,
    done: doneIds.sort((a, b) => a - b),
    feasible,
    blocked,
    skipped,
    steps: Object.fromEntries(
      Object.entries(done).map(([id, arr]) => [id, (arr || []).filter((x) => x !== '__complete')])
    ),
    recent: Array.isArray(st?.log) ? st.log.slice(-15) : [],
  };
}

/** 服务端进程/端口/难度等 */
async function serverState() {
  const pid = parseInt(readTextSafe(path.join(SERVER_DIR, 'logs', 'server.pid'), '').trim(), 10) || null;
  const props = readTextSafe(path.join(SERVER_DIR, 'server.properties'));
  const pick = (k) => {
    const m = props.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const listening = await portListening(Number(pick('server-port') || 25565));
  return {
    running: pidAlive(pid),
    pid,
    listening,
    port: Number(pick('server-port') || 25565),
    gamemode: pick('gamemode'),
    difficulty: pick('difficulty'),
    whitelist: pick('white-list') === 'true',
    maxPlayers: Number(pick('max-players') || 0) || null,
    version: null,
  };
}

/** 汇总 */
/**
 * AI 记忆（MC bot 的 memory / lessons / experience）。
 *
 * 数据来源不是原文件，而是笔记本上 mc-memory-export.timer 汇总出来的派生文件：
 *   /home/wx/mc/bot/memory-state.json  （经 mcsync 镜像到本机）
 * 为什么用派生文件：memory.json 含对话窗口且每次对话都变，experience.md 已 370KB
 * 并且每 ~10 秒追加一条 —— 直接每 5 秒同步原文件太浪费。派生文件约 13KB。
 */
export function memoryState() {
  const m = readJsonSafe(path.join(BOT_DIR, 'memory-state.json'), null);
  if (!m) return { known: false };
  const exp = m.experience || {};
  return {
    known: true,
    updatedAt: m.updatedAt ?? null,
    memory: m.memory ?? '',
    memoryChars: Number(m.memoryChars) || 0,
    goal: m.goal ?? '',
    lessons: m.lessons ?? '',
    lessonsLines: Number(m.lessonsLines) || 0,
    experience: {
      entries: Number(exp.entries) || 0,
      chars: Number(exp.chars) || 0,
      tail: Array.isArray(exp.tail) ? exp.tail : [],
    },
    turns: m.turns || { count: 0, chars: 0 },
    files: m.files || {},
    caps: m.caps || {},
    // 目标有两个来源，别混：
    //  goal           —— MISSION.md 的 15 个里程碑总目标（始终存在，权威）
    //  selfPromptGoal —— 自驱模式下提示词里的 goal；里程碑任务模式下为空
    // 一开始只从 turns 抠 goal，取到空：self_prompting_state=0 时 turns 里没那段话。
    milestone: m.milestone || {},
    selfPromptGoal: m.selfPromptGoal || '',
    selfPromptingState: m.selfPromptingState ?? null,
  };
}

export async function getMcStatus() {
  const [server] = await Promise.all([serverState()]);
  const bot = botState();
  const milestones = milestoneState();
  const viewerPort = 3200;
  return {
    bot,
    server,
    milestones,
    viewer: {
      // 浏览器实际入口（经 nginx 443，不用另开安全组）
      publicUrl: 'https://anihub.xin/mc/',
      localPort: viewerPort,
      running: await portListening(viewerPort),
    },
  };
}

/**
 * 把 getMcStatus() 的结果压成一小块**可注入 prompt 的实时状态文本**。
 *
 * 为什么要单独一个函数：QQ 侧的 agent 和 tzd 上真正玩 MC 的 agent 是**两套独立上下文**，
 * QQ 侧默认对"MC 里正在发生什么"一无所知 —— 群友问"它现在干嘛呢 / 推到哪一步了"，
 * 只能靠 AI 自己想起来调 mc_control_status，实际表现就是答不上来或答得含糊。
 * 抽成纯函数（不做 IO）是为了能单独跑一遍看输出，不用起整个 bridge。
 *
 * 返回空串表示拿不到状态 —— 调用方应当**静默跳过**，绝不因此影响回复。
 */
// ── 动作名 → 中文 ────────────────────────────────────────────────────────
// 状态导出层写的 intent 是 Mindcraft 的动作标签（实测就是 "action:stay" 这种），
// 直接塞进提示词，QQ 侧的 agent 会照抄成"它正在做 action:stay"。
// 这张表与直播 HUD 的 hud-render.py 里 _ACTION_ZH **保持一致** ——
// 画面上的说法和 QQ 里的说法必须是同一套，否则观众和群友会对不上。
const ACTION_ZH = {
  collectblocks: '采集方块', collectblock: '采集方块',
  craftrecipe: '合成物品', craft: '合成物品', smeltitem: '烧炼',
  gotoposition: '走路前往', movetoplayer: '走向玩家', gotoplayer: '走向玩家',
  digblock: '挖掘方块', breakblock: '挖掘方块', placeblock: '放置方块',
  attack: '攻击', attackentity: '攻击', followplayer: '跟随玩家',
  stay: '原地待命', goal: '设定目标', endgoal: '结束当前目标',
  searchforblock: '寻找方块', pickupitem: '捡拾物品', consume: '吃东西',
  equip: '换装备', giveitem: '给物品', wait: '等待', sleep: '睡觉',
  usechest: '开箱子', putincontainer: '存入箱子', takefromcontainer: '取箱子物品',
  movetonearby: '就近移动', lookat: '看向目标',
  getcraftingplan: '规划合成方案', getiteminfo: '查看物品信息', iteminfo: '查看物品信息',
  checkitem: '查看背包', checkinventory: '查看背包', stats: '查看状态',
  lookatplayer: '看向玩家', moveaway: '走开', moveawayfrom: '走开',
  clearitem: '丢弃手中物品', clearitems: '清空背包', discard: '丢弃物品',
  useitem: '使用物品', useon: '对目标使用', gooutside: '走到户外',
  attacknearby: '攻击附近目标', defend: '自卫', retreat: '撤退',
  inventory: '整理背包', nearbyblocks: '查看附近方块',
  digdown: '向下挖', giveplayer: '给玩家物品', startconversation: '搭话',
  entities: '查看附近实体', rememberhere: '记住地点', newaction: '执行自定义动作',
};

const stripQuote = (x) => String(x || '').trim().replace(/^["']|["']$/g, '');

/** 'action:craftRecipe' / '!collectBlocks("stone", 12)' → '采集 stone ×12' */
function friendlyIntent(raw) {
  const s = String(raw || '').trim();
  if (!s || s === '—') return '';
  // 已经是中文（例如看门狗挂的自提醒、'空闲（等待指令）'）就原样用
  if (/[\u4e00-\u9fff]/.test(s) && !/^(?:action:)?!?[A-Za-z_]+\s*\(/.test(s)) return s.slice(0, 140);
  const m = s.match(/^(?:action:)?!?([A-Za-z_][A-Za-z0-9_]*)\s*\(?(.*)$/);
  if (!m) return s.slice(0, 140);
  const key = m[1].toLowerCase().replace(/[^a-z]/g, '');
  const arg = String(m[2] || '').replace(/\)+\s*$/, '').trim();
  if (['collectblocks', 'collectblock', 'digblock', 'searchforblock'].includes(key) && arg) {
    const parts = arg.split(',').map(stripQuote);
    if (parts[0]) return `${ACTION_ZH[key] || '采集'} ${parts[0]}${parts.length > 1 && parts[1] ? ' ×' + parts[1] : ''}`;
  }
  const zh = ACTION_ZH[key];
  if (zh) {
    const first = stripQuote(String(arg).split(',')[0]);
    return (first && first.length < 18) ? `${zh} ${first}` : zh;
  }
  return `执行 ${m[1]}`;
}

export function formatMcStatusBlock(st) {
  const b = st?.bot ?? {};
  if (!b.known) return '';
  const L = [];
  // ★ 这里必须用第一人称写。
  //   原来写的是【当前 MC 直播状态】+「群里聊到"它 / bot / MC / 直播"时…」，
  //   模型于是把游戏里的那个角色当成第三方（甚至当成自己的小号）来谈论：
  //   群里问"你干嘛呢"，它答得像在说别人。
  //   MC 里那个 bot 就是你本人 —— 你在这边聊 QQ，那边是你的角色在玩。
  L.push('【你自己此刻在 MC 里的情况·系统自动同步，不是群友说的，也不是别人】');
  const uname = b.username ?? '?';
  let line2 = `你的游戏角色 ${uname} 现在${b.online ? '在线' : '离线'}`;
  if (b.dimension) line2 += ` @ ${b.dimension}`;
  if (b.gameMode) line2 += ` / ${b.gameMode}`;
  if (b.health != null) line2 += ` / 血量 ${b.health}`;
  if (b.food != null) line2 += ` / 饱食 ${b.food}`;
  L.push(line2);
  const p = b.position;
  if (p && typeof p.x === 'number') {
    L.push(`你的坐标：${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`);
  }
  const m = st?.milestones ?? {};
  if (m.known) {
    const done = Array.isArray(m.done) ? m.done : [];
    L.push(`你的里程碑：第 ${m.current ?? '?'} 个（已完成 ${done.length} 个${done.length ? '：' + done.join('、') : ''}）`);
  }
  if (b.intent) {
    const it = friendlyIntent(b.intent);
    if (it) L.push(`你正在做：${it.slice(0, 140)}`);
  }
  if (Array.isArray(b.inventory) && b.inventory.length) {
    // 状态导出层把物品写成 "名字x数量" 的紧凑格式，这里还原成好看一点的样子
    const inv = b.inventory.slice(0, 12).map((x) => String(x).replace(/x(\d+)$/, ' ×$1'));
    L.push(`你的背包：${inv.join('、')}`);
  }
  const recent = Array.isArray(b.recentActions) ? b.recentActions.filter(Boolean).slice(-2) : [];
  if (recent.length) {
    L.push('你最近的动静：\n' + recent.map((x) => '  - ' + String(x).slice(0, 170)).join('\n'));
  }
  L.push('（以上都是你自己在 MC 里的实时状态 —— 那个游戏角色就是你本人，不是别人，也不是你的小号。'
       + '群里问"你在干嘛 / 玩到哪了 / 直播里在做什么 / 第几个里程碑了"，你就用第一人称直接答（我/我的），'
       + '别用"它""那个 bot""另一个我"这种说法。工具 mc_status / mc_milestone 查的也是你自己，'
       + '所以一般不必调工具，看上面这段就够。）');
  return L.join('\n');
}

/**
 * 给 bot 投递一条指令（写 bot-command.txt，由 botd.js 轮询执行）。
 * 返回投递结果；真正的执行结果要去 bot-state.json / 日志看。
 */
export function postCommand(text) {
  const cmd = String(text || '').trim();
  if (!cmd) return { ok: false, error: '指令为空' };
  if (cmd.length > 200) return { ok: false, error: '指令过长（>200）' };
  const file = path.join(BOT_DIR, 'bot-command.txt');
  try {
    fs.mkdirSync(BOT_DIR, { recursive: true });
    fs.writeFileSync(file, cmd + '\n', { encoding: 'utf8', mode: 0o600 });
    return { ok: true, delivered: cmd };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** bot 最近日志（尾部若干行，脱敏无关，只读文本） */
export function recentBotLog(limit = 40) {
  const text = readTextSafe(path.join(BOT_DIR, 'bot.log'));
  if (!text) return [];
  const lines = text.split('\n').filter(Boolean);
  // limit <= 0 表示"全都要"；正数则按请求返回，上限放到 50000 行
  // （原来硬顶 400，控制台就只能看个尾巴，历史明明还在文件里）
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return lines;
  return lines.slice(-Math.max(1, Math.min(50000, n)));
}

export const MC_PATHS = { MC_ROOT, BOT_DIR, SERVER_DIR };

// ———————————————————————————— 直播推流（/home/wx/mc/stream）————————————————————————————
//
// 控制台里要能开播/推流，但**不能让 HTTP 处理函数同步等命令跑完**：
// bridge 还要收发 QQ 消息，spawnSync 阻塞 2~4 秒会把消息循环卡住。
// 所以动作一律 detached 异步启动、输出重定向到日志文件，前端轮询状态。
const STREAM_DIR = process.env.MC_STREAM_DIR || path.join(MC_ROOT, 'stream');
const STREAM_SH = path.join(STREAM_DIR, 'stream.sh');
const BILI_LIVE = path.join(STREAM_DIR, 'bili-live.js');
const STREAM_LOG = path.join(STREAM_DIR, 'stream.log');
const STREAM_PID = path.join(STREAM_DIR, 'stream.pid');
const STREAM_ENV = path.join(STREAM_DIR, 'stream.env');
const ROOM_JSON = path.join(STREAM_DIR, 'room.json');
const ACTION_LOG = path.join(STREAM_DIR, 'console-action.log');
const LIVE_LOG = path.join(STREAM_DIR, 'bili-live.console.log');

function tailLines(file, limit = 40) {
  const text = readTextSafe(file, '');
  if (!text) return [];
  return text.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(500, limit)));
}

/** 推流日志（render-stream.js 的输出） */
export function recentStreamLog(limit = 60) {
  return tailLines(STREAM_LOG, limit);
}

/** 异步跑一个命令，输出追加到日志文件；立刻返回，不阻塞消息循环 */
function spawnLogged(cmd, args, logFile) {
  try {
    fs.mkdirSync(STREAM_DIR, { recursive: true });
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(cmd, args, { cwd: STREAM_DIR, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    fs.closeSync(fd);
    return { ok: true, pending: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** 推流进程控制：只允许 start / stop / restart（固定动作，不接受任意命令） */
export function runStreamAction(action) {
  const a = String(action || '').trim();
  if (!['start', 'stop', 'restart'].includes(a)) return { ok: false, error: '只支持 start / stop / restart' };
  return spawnLogged('bash', [STREAM_SH, a], ACTION_LOG);
}

/** B站直播控制：start（换推流码）/ stop（下播）/ status（刷新房间状态） */
export function runLiveAction(action, title = '') {
  const a = String(action || '').trim();
  if (!['start', 'stop', 'status'].includes(a)) return { ok: false, error: '只支持 start / stop / status' };
  const args = [BILI_LIVE, a];
  if (a === 'start' && title) {
    // 用 argv 传参、不经过 shell；只做换行与长度清理
    args.push('--title', String(title).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 40));
  }
  return spawnLogged(process.execPath, args, LIVE_LOG);
}

// ———————————————— 画质配置（控制台可改）————————————————
const STREAM_CONFIG = path.join(STREAM_DIR, 'stream-config.json');

/** 画质预设：分辨率 / 光线投射分辨率 / 帧率 / 码率 */
export const QUALITY_PRESETS = {
  '480p': { w: 854, h: 480, rw: 320, rh: 180, fps: 8, bitrate: '1200k' },
  '540p': { w: 960, h: 540, rw: 384, rh: 216, fps: 8, bitrate: '1600k' },
  '720p': { w: 1280, h: 720, rw: 512, rh: 288, fps: 6, bitrate: '2500k' },
  '1080p': { w: 1920, h: 1080, rw: 640, rh: 360, fps: 4, bitrate: '4000k' },
};
const CFG_LIMITS = {
  w: [320, 1920], h: [180, 1080], rw: [128, 960], rh: [72, 540],
  fps: [2, 30], radius: [16, 48], bitrate: [200, 8000],
};
const CFG_DEFAULTS = { w: 640, h: 360, rw: 256, rh: 144, fps: 8, bitrate: '1000k', radius: 28 };

/** 取当前画质配置（文件缺项用默认补齐） */
export function getStreamConfig() {
  const saved = readJsonSafe(STREAM_CONFIG, {}) || {};
  const out = { ...CFG_DEFAULTS };
  for (const k of ['w', 'h', 'rw', 'rh', 'fps', 'radius']) {
    const v = Number(saved[k]);
    if (Number.isFinite(v)) out[k] = v;
  }
  if (typeof saved.bitrate === 'string' && /^\d+k$/i.test(saved.bitrate.trim())) out.bitrate = saved.bitrate.trim().toLowerCase();
  return out;
}

/**
 * 写画质配置。**所有数值都在这里钳制**：
 * x264 要求宽高为偶数，帧率/分辨率写太大这台 2 核机也跑不动，码率超出 B站 接受范围会被拒。
 */
export function setStreamConfig(patch = {}) {
  const cur = getStreamConfig();
  const next = { ...cur };
  for (const k of ['w', 'h', 'rw', 'rh', 'fps', 'radius']) {
    if (patch[k] === undefined || patch[k] === '') continue;
    const v = Number(patch[k]);
    if (!Number.isFinite(v)) return { ok: false, error: `${k} 不是数字` };
    const [lo, hi] = CFG_LIMITS[k];
    next[k] = Math.min(hi, Math.max(lo, Math.round(v)));
  }
  // x264 只吃偶数宽高
  next.w -= next.w % 2;
  next.h -= next.h % 2;
  next.rw -= next.rw % 2;
  next.rh -= next.rh % 2;
  // 投射分辨率不该超过输出分辨率，否则纯浪费 CPU
  if (next.rw > next.w) next.rw = next.w;
  if (next.rh > next.h) next.rh = next.h;

  if (patch.bitrate !== undefined && patch.bitrate !== '') {
    const m = String(patch.bitrate).trim().toLowerCase().match(/^(\d+)k$/);
    if (!m) return { ok: false, error: '码率格式应为 1000k 这样' };
    const [lo, hi] = CFG_LIMITS.bitrate;
    next.bitrate = `${Math.min(hi, Math.max(lo, Number(m[1])))}k`;
  }
  try {
    fs.writeFileSync(STREAM_CONFIG, JSON.stringify({ ...next, updatedAt: Date.now() }, null, 2) + '\n');
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
  return { ok: true, config: next, note: '需要 ./stream.sh restart 才生效（控制台按钮会自动重启）' };
}

/** 直播/推流汇总状态（给控制台轮询） */
export function getStreamStatus() {
  const pid = Number(readTextSafe(STREAM_PID, '').trim()) || null;
  const running = pidAlive(pid);
  const room = readJsonSafe(ROOM_JSON, null);
  const log = tailLines(STREAM_LOG, 200);

  // 抓最近一次统计行：
  //   ▶ 431 帧（丢 48）　实测 7.1fps　耗时: 投射 71ms + 合成 299ms　网格 46 次（上次 127ms）
  let stats = null;
  for (let i = log.length - 1; i >= 0; i--) {
    const m = log[i].match(/▶\s*(\d+)\s*帧（丢\s*(\d+)）.*?实测\s*([\d.]+)fps.*?投射\s*(\d+)ms\s*\+\s*合成\s*(\d+)ms.*?网格\s*(\d+)\s*次/);
    if (m) {
      stats = { frames: +m[1], dropped: +m[2], fps: +m[3], rayMs: +m[4], composeMs: +m[5], gridBuilds: +m[6] };
      break;
    }
  }
  let logAgeSec = null;
  try { logAgeSec = Math.round((Date.now() - fs.statSync(STREAM_LOG).mtimeMs) / 1000); } catch { /* 无日志 */ }

  const liveLog = tailLines(LIVE_LOG, 80);
  const liveText = liveLog.join('\n');
  const faceAuth = (liveText.match(/https:\/\/www\.bilibili\.com\/blackboard\/live\/face-auth-middle\.html\S*/) || [])[0] || null;
  const rtmp = (liveText.match(/rtmp:\/\/[^\s|]+/) || [])[0] || null;

  let hasPushUrl = false;
  try { hasPushUrl = fs.statSync(STREAM_ENV).size > 0; } catch { hasPushUrl = false; }

  return {
    streamDir: STREAM_DIR,
    push: { running, pid, logAgeSec, stats, recent: log.slice(-6) },
    hasPushUrl,
    // 串流码只存在 stream.env 里，绝不回传前端；这里只给一个隐去 key 的形态
    pushUrlMasked: rtmp ? rtmp.replace(/(key=)[^&\s]+/g, '$1***').replace(/(streamname=)[^&\s]+/g, '$1***') : null,
    room: room || null,
    config: getStreamConfig(),
    live: { lastOutput: liveLog.slice(-16), faceAuth },
  };
}
