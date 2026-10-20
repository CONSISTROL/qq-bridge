/**
 * Minecraft 控制模块 —— 让 QQ 里的 AI 能开关「推流 / AI 游玩 / 服务端」。
 *
 * 架构（重要）：
 *   qq-bridge 跑在**云端服务器**，而 MC 全套服务在 **tzd（10.8.0.2）**。
 *   所以本模块通过 SSH 调用 tzd 上的 systemctl，而不是本地 systemctl。
 *   免密通道：云端 /root/.ssh/id_ed25519 → tzd 的 authorized_keys（已装好）。
 *
 * 为什么不让 qq-bridge 在本地直接 systemctl：
 *   它和 MC 不在同一台机器上。这是最容易搞错的一点。
 *
 * 设计原则：
 *   - 只暴露**固定动作**（start/stop/restart/status），不接受任意命令，避免被注入。
 *   - 每个动作有超时（默认 45s），失败返回明确错误，不抛异常给调用方。
 *   - B站开播要带 NODE_OPTIONS=--dns-result-order=ipv4first
 *     （tzd 上 IPv6 不通，Node 的 fetch 默认优先 IPv6 会失败 —— 详见维护文档第 25 节）。
 */
import { execFile } from 'node:child_process';

const MC_HOST = process.env.MC_SSH_HOST || '10.8.0.2';
const MC_USER = process.env.MC_SSH_USER || 'root';
const MC_KEY = process.env.MC_SSH_KEY || '/root/.ssh/id_ed25519';
const MC_TIMEOUT = Number(process.env.MC_SSH_TIMEOUT || 45000);

/** 允许控制的服务单元（白名单，不做任意服务名透传） */
const UNITS = {
  server: 'mcserver',      // Paper 服务端
  ai: 'mcmind',            // Mindcraft（LLM 驱动的 AI 玩家）
  legacyBot: 'mcbot',      // 旧的自己写的 bot（与 mcmind 同名互斥）
  capture: 'mccapture',    // 推流（x11grab + HUD → NVENC → B站）
  camera: 'mcfollow',      // 跟随相机
  camguard: 'mccamguard',  // 相机守护
  hotbar: 'hotbar-sync',   // 快捷栏同步
};

/** POSIX 单引号转义：把任意文本变成可安全嵌入 shell 的字面量 */
function shq(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

/**
 * 在 tzd 上跑一段脚本。
 *
 * ★ 必须把脚本作为**单个参数**传给 ssh：
 *   ssh 会把命令行上的多个 argv 用空格拼成"一条远端命令"，
 *   所以 execFile('ssh', [...,'bash','-lc',script]) 到远端会变成
 *   `bash -lc <script 被空格拆开>` → 报 "syntax error near unexpected token"。
 *   正确做法是拼成一个字符串：bash -lc '<转义后的脚本>'。
 */
function sshScript(script, timeoutMs = MC_TIMEOUT) {
  const remote = `bash -lc ${shq(script)}`;
  return new Promise((resolve) => {
    execFile(
      'ssh',
      [
        '-i', MC_KEY,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'BatchMode=yes',
        '-o', 'LogLevel=ERROR',
        '-o', `ConnectTimeout=${Math.min(15, Math.ceil(timeoutMs / 1000))}`,
        `${MC_USER}@${MC_HOST}`,
        remote,
      ],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // 远端 stderr 里可能有 ssh 自己的告警，取最后一行更有用
          const lines = String(stderr || err.message || '').trim().split('\n').filter(Boolean);
          resolve({ ok: false, error: lines.slice(-3).join(' | ').slice(0, 400), stdout: (stdout || '').trim() });
        } else {
          resolve({ ok: true, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
        }
      },
    );
  });
}

// ————————————————— 状态查询 —————————————————

/** 各服务的 active/enabled 状态；只读，快 */
export async function getMcServices() {
  // 以 SERVICE_KEYS 为准（那是控制面完整清单，含 mcvanilla / mc-ai-watchdog），
  // 再并入 UNITS 里可能没进 SERVICE_KEYS 的项。只查存在的 unit，避免拼错名字。
  const units = [...new Set([...Object.values(SERVICE_KEYS ?? {}), ...Object.values(UNITS)])];
  const names = units.join(' ');
  const r = await sshScript(
    `for u in ${names}; do printf '%s|%s|%s\\n' "$u" "$(systemctl is-active $u 2>/dev/null)" "$(systemctl is-enabled $u 2>/dev/null)"; done`,
    20000,
  );
  if (!r.ok) return { ok: false, error: r.error };
  const services = {};
  for (const line of r.stdout.split('\n')) {
    const [u, active, enabled] = line.split('|');
    if (u) services[u] = { active: active || 'unknown', enabled: enabled || 'unknown' };
  }
  return { ok: true, services };
}

/** 直播/推流状态：B站房间 + RTMP 连接 + HUD */
export async function getStreamStatus() {
  const r = await sshScript(
    `cd /home/wx/mc/stream || exit 1
     echo "=== room ==="
     NODE_OPTIONS=--dns-result-order=ipv4first timeout 20 node bili-live.js status 2>&1 | tail -2
     echo "=== rtmp ==="
     ss -tnp 2>/dev/null | grep -c ':1935'
     echo "=== ffmpeg ==="
     pgrep -c -x ffmpeg 2>/dev/null || echo 0
     echo "=== hud ==="
     grep -a '开始写帧' /home/wx/mc/stream/hud.log 2>/dev/null | tail -1
     echo "=== temp ==="
     sensors 2>/dev/null | grep 'Package id 0' | grep -oE '\\+[0-9.]+' | head -1`,
    45000,
  );
  if (!r.ok) return { ok: false, error: r.error };
  const out = r.stdout;
  const pick = (marker) => {
    const m = out.split(`=== ${marker} ===`)[1];
    return m ? m.split('===')[0].trim() : '';
  };
  return {
    ok: true,
    room: pick('room'),
    rtmpConnections: Number(pick('rtmp')) || 0,
    ffmpegProcesses: Number(pick('ffmpeg')) || 0,
    hud: pick('hud'),
    cpuTemp: pick('temp'),
    streaming: (Number(pick('rtmp')) || 0) > 0,
  };
}

// ————————————————— 动作 —————————————————

/** 启停推流（capture = ffmpeg 推流进程；camera = 跟随相机与控制台里的相机守护） */
export async function controlStream(action) {
  const a = String(action || '').trim();
  if (!['start', 'stop', 'restart'].includes(a)) {
    return { ok: false, error: '只支持 start / stop / restart' };
  }
  // 推流要有画面源，所以开播时连相机一起拉起
  const script = a === 'stop'
    ? `systemctl stop ${UNITS.capture}; sleep 1; systemctl is-active ${UNITS.capture} || true`
    : `systemctl start ${UNITS.camera} ${UNITS.camguard} 2>/dev/null; \
       systemctl ${a} ${UNITS.capture}; sleep 6; systemctl is-active ${UNITS.capture} || true`;
  const r = await sshScript(script, 60000);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, action: a, state: r.stdout.split('\n').pop() };
}

/** 启停 AI 游玩（mcmind = Mindcraft）。注意：mcmind 与 mcbot 同名互斥，起一个会顶掉另一个 */
export async function controlAi(action) {
  const a = String(action || '').trim();
  if (!['start', 'stop', 'restart'].includes(a)) {
    return { ok: false, error: '只支持 start / stop / restart' };
  }
  // 起 AI 前先停掉旧 bot，避免同名顶号
  const script = a === 'stop'
    ? `systemctl stop ${UNITS.ai}; systemctl stop ${UNITS.legacyBot} 2>/dev/null || true; \
       systemctl is-active ${UNITS.ai} || true`
    : `systemctl stop ${UNITS.legacyBot} 2>/dev/null || true; \
       systemctl ${a} ${UNITS.ai}; sleep 8; systemctl is-active ${UNITS.ai} || true`;
  const r = await sshScript(script, 60000);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, action: a, state: r.stdout.split('\n').pop() };
}

/** 启停 MC 服务端 */
export async function controlServer(action) {
  const a = String(action || '').trim();
  if (!['start', 'stop', 'restart'].includes(a)) {
    return { ok: false, error: '只支持 start / stop / restart' };
  }
  const r = await sshScript(`systemctl ${a} ${UNITS.server}; sleep 3; systemctl is-active ${UNITS.server} || true`, 90000);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, action: a, state: r.stdout.split('\n').pop() };
}

/** 控制台可手动启停的服务白名单（key → systemd unit）。给 /api/mc/service 用 */
export const SERVICE_KEYS = {
  server: UNITS.server,        // mcserver   世界
  client: 'mcvanilla',         // mcvanilla  游戏客户端（抓屏画面源）
  ai: UNITS.ai,                // mcmind     Mindcraft AI
  legacyBot: UNITS.legacyBot,  // mcbot      旧 bot（与 AI 同名互斥）
  capture: UNITS.capture,      // mccapture  推流
  camera: UNITS.camera,        // mcfollow   跟随相机
  camguard: UNITS.camguard,    // mccamguard 相机守护
  hotbar: UNITS.hotbar,        // hotbar-sync 快捷栏同步
  watchdog: 'mc-ai-watchdog',  // 里程碑看门狗（会反复拉起 AI，停机时要注意）
};

/**
 * 手动启停**单个**服务（控制台用，比 controlServer 粒度更细）。
 *
 * 注意 mccapture / mcmind 常见"停了之后 systemd 又因 Restart=/依赖 拉起"，
 * 所以返回里带上 `enabled`（是否开机自启）和停完之后的真实状态，
 * 让控制台能看出"停不掉"到底是没停成功还是被别的依赖拉起来了。
 */
export async function controlService(key, action) {
  const unit = SERVICE_KEYS[String(key || '').trim()];
  if (!unit) {
    return { ok: false, error: `未知服务：${key}（可选：${Object.keys(SERVICE_KEYS).join(' / ')}）` };
  }
  const a = String(action || '').trim();
  if (!['start', 'stop', 'restart'].includes(a)) {
    return { ok: false, error: '只支持 start / stop / restart' };
  }
  const wait = a === 'stop' ? 3 : 6;
  // reset-failed：mccapture/mcvanilla 被强杀时会留 failed 状态，不清掉下次 start 会直接失败
  const r = await sshScript(
    `systemctl ${a} ${unit} 2>&1 | tail -2; sleep ${wait}; systemctl reset-failed ${unit} 2>/dev/null; \
     printf '%s\\n' "state=$(systemctl is-active ${unit} 2>/dev/null)" "enabled=$(systemctl is-enabled ${unit} 2>/dev/null)"`,
    90000,
  );
  if (!r.ok) return { ok: false, error: r.error, unit, action: a };
  const out = r.stdout;
  const pick = (k) => (out.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1] || '';
  return {
    ok: true, action: a, key, unit,
    state: pick('state'),
    enabled: pick('enabled'),
    detail: out.trim().slice(-300),
  };
}

/**
 * 读功耗/频率策略（笔记本上的 mc-thermal.sh show）。
 *
 * 实测背景（2026-10-08）：这台 i5-9300H 的瓶颈是**散热**不是功耗 ——
 * 整机只烧 12~16W、温度就已 70°C（PL1 帽子 30W 根本没碰到）。
 * 所以往下压 PL1 基本没用，**真正能降温的是降频率上限**（降低工作电压）。
 * 风扇转速没有软件接口（sensors/hwmon 都没有 fan/rpm），只能靠降温间接压。
 */
export async function getThermal() {
  const r = await sshScript('/usr/local/bin/mc-thermal.sh show 2>&1', 25000);
  if (!r.ok) return { ok: false, error: r.error };
  const m = r.stdout.match(/^JSON=(\{.*\})$/m);
  if (!m) return { ok: false, error: '无法解析 mc-thermal.sh 输出', detail: r.stdout.slice(0, 300) };
  try {
    return { ok: true, ...JSON.parse(m[1]), detail: r.stdout.trim() };
  } catch (e) {
    return { ok: false, error: 'JSON 解析失败：' + e.message };
  }
}

/**
 * 写功耗/频率策略并立即应用（mc-thermal.sh set）。
 * fields 支持：PL1_W / PL2_W / MAX_MHZ / GOVERNOR / EPP。
 * 范围校验在笔记本那侧做（单一真值），这里只透传。
 */
export async function setThermal(fields = {}) {
  const map = {
    PL1_W: (v) => `PL1_W=${Math.round(Number(v))}`,
    PL2_W: (v) => `PL2_W=${Math.round(Number(v))}`,
    MAX_MHZ: (v) => `MAX_MHZ=${Math.round(Number(v))}`,
    GOVERNOR: (v) => `GOVERNOR=${String(v)}`,
    EPP: (v) => `EPP=${String(v)}`,
  };
  const args = [];
  for (const [k, fmt] of Object.entries(map)) {
    if (fields[k] === undefined || fields[k] === null || fields[k] === '') continue;
    const n = Number(fields[k]);
    if (['PL1_W', 'PL2_W', 'MAX_MHZ'].includes(k) && !Number.isFinite(n)) {
      return { ok: false, error: `${k} 必须是数字` };
    }
    args.push(shq(fmt(fields[k])));
  }
  if (!args.length) return { ok: false, error: '没有可设置的字段' };
  // 末尾 `|| true`：mc-thermal.sh 用 exit 2 表示"校验拒绝"，
  // 但那不是执行失败 —— 不让它把 ssh 的退出码带成非零，否则只能看到
  // 一行 Command failed，看不到"❌ 频率超出范围"这种真正有用的原因。
  const r = await sshScript(`/usr/local/bin/mc-thermal.sh set ${args.join(' ')} 2>&1 || true`, 40000);
  if (!r.ok) return { ok: false, error: r.error };
  const out = r.stdout.trim();
  if (/❌/.test(out)) return { ok: false, error: out.split('\n')[0], detail: out };
  return { ok: true, detail: out, ...(await getThermal()) };
}

/**
 * 直播间待机封面开关（笔记本上由 standby.sh 实现）。
 *
 * 原理：不动推流链路（ffmpeg 一直抓 :99），只改
 *   1) /home/wx/mc/stream/mode  → HUD 改写透明帧
 *   2) :99 上一张全屏置顶的待机图
 * 所以切换时 RTMP 不断、**不需要重新开播**。
 */
export async function controlStandby(action, seconds = 0) {
  const a = String(action || '').trim();
  if (!['on', 'off', 'status'].includes(a)) {
    return { ok: false, error: '只支持 on / off / status' };
  }
  const arg = a === 'on' && Number(seconds) > 0 ? ` ${Number(seconds)}` : '';
  // status 只是读，用短超时
  const r = await sshScript(`/home/wx/mc/stream/standby.sh ${a}${arg} 2>&1 | tail -8`, a === 'status' ? 25000 : 45000);
  if (!r.ok) return { ok: false, error: r.error };
  const text = r.stdout.trim();
  // 兼容 standby.sh 的两种输出：
  //   on/off  → 「mode = standby」   （等号）
  //   status  → 「模式        : live」（全角/半角冒号）
  // ⚠️ 不能用 /\\bstandby\\b/ 全文找：输出里还有待机图路径 standby.png，
  //    那样 live 也会被误判成 standby（第一版踩过这个坑）。
  const mode = (text.match(/(?:模式\s*[：:]|mode\s*=)\s*(standby|live)/i) || [])[1] || '';
  return { ok: true, action: a, detail: text, mode: mode.toLowerCase() };
}

/**
 * B站开播/下播。
 *   开播 = 申请新推流码（写进 stream.env）
 *   下播 = 调 B站 API 关播
 * ⚠️ 开播必须带 ipv4first，否则 Node 的 fetch 走 IPv6 会超时失败。
 */
export async function controlLive(action, title = '') {
  const a = String(action || '').trim();
  if (!['start', 'stop', 'status'].includes(a)) {
    return { ok: false, error: '只支持 start / stop / status' };
  }
  const safeTitle = String(title || '').replace(/[^\w\u4e00-\u9fa5 \-]/g, '').slice(0, 40);
  const titleArg = a === 'start' && safeTitle ? ` --title '${safeTitle}'` : '';
  const r = await sshScript(
    `cd /home/wx/mc/stream || exit 1
     NODE_OPTIONS=--dns-result-order=ipv4first timeout 40 node bili-live.js ${a}${titleArg} 2>&1 | tail -8`,
    60000,
  );
  if (!r.ok) return { ok: false, error: r.error };
  const text = r.stdout;
  const opened = /已开播/.test(text);
  const needFace = /60043|人脸/.test(text);
  return {
    ok: true,
    action: a,
    opened,
    needFaceAuth: needFace,
    detail: text.slice(-600),
    hint: needFace
      ? 'B站要求人脸认证，需要账号本人在手机 App 上完成，无法绕过'
      : undefined,
  };
}

/** 一次拿全：服务状态 + 直播 + AI/服务端健康。给 QQ 里的状态问询用 */
export async function getFullStatus() {
  const [svc, stream] = await Promise.all([getMcServices(), getStreamStatus().catch((e) => ({ ok: false, error: String(e) }))]);
  const s = svc.ok ? svc.services : {};
  return {
    ok: svc.ok,
    error: svc.ok ? undefined : svc.error,
    services: s,
    stream,
    summary: {
      server: s[UNITS.server]?.active,
      ai: s[UNITS.ai]?.active,
      streaming: stream?.streaming ?? false,
      room: stream?.room,
      cpuTemp: stream?.cpuTemp,
    },
  };
}

// ————————————————— 服务器白名单 —————————————————
//
// 走 RCON（127.0.0.1:25575，密码在 server.properties）执行原版 whitelist 命令。
// 远端没有现成的 RCON 客户端可依赖，这里把最小客户端用 Python 内联脚本发过去；
// 脚本通过 base64 传输，避免引号/换行在不同 shell 下被吃掉。
//
// 安全边界：**不接受任意命令**。动作是固定枚举，玩家名必须匹配 Minecraft 用户名格式，
// 因为 RCON 是裸命令通道，命令一旦拼进去就没有第二道校验。

const MC_SERVER_DIR = process.env.MC_SERVER_DIR || '/home/wx/mc/server';

const RCON_PY = String.raw`
import socket, struct, sys
props = sys.argv[1]
port = 25575
password = ""
try:
    with open(props, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() == "rcon.port":
                port = int(v.strip())
            elif k.strip() == "rcon.password":
                password = v.strip()
except OSError:
    pass
if not password:
    print("RCON_PASSWORD_EMPTY")
    sys.exit(2)

def pack(req_id, ptype, body):
    payload = struct.pack("<ii", req_id, ptype) + body.encode("utf-8") + b"\x00\x00"
    return struct.pack("<i", len(payload)) + payload

def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise EOFError("connection closed")
        buf += chunk
    return buf

def read_packet(sock):
    (length,) = struct.unpack("<i", recv_exact(sock, 4))
    return recv_exact(sock, length)

try:
    sock = socket.create_connection(("127.0.0.1", port), timeout=5)
    sock.settimeout(5)
    sock.sendall(pack(1, 3, password))
    auth = read_packet(sock)
    if struct.unpack("<i", auth[:4])[0] == -1:
        print("RCON_AUTH_FAIL")
        sys.exit(3)
    sock.sendall(pack(2, 2, " ".join(sys.argv[2:])))
    out = read_packet(sock)
    print(out[8:].decode("utf-8", "replace").strip())
except OSError as e:
    print("RCON_CONNECT_FAIL: " + str(e))
    sys.exit(4)
`;

async function rconCommand(...args) {
  const b64 = Buffer.from(RCON_PY, 'utf8').toString('base64');
  const argText = args.map(shq).join(' ');
  const r = await sshScript(`echo ${shq(b64)} | base64 -d | python3 - ${shq(`${MC_SERVER_DIR}/server.properties`)} ${argText}`, 20000);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, output: r.stdout };
}

const WHITELIST_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const WHITELIST_ACTIONS = new Set(['add', 'remove', 'on', 'off', 'list', 'reload']);

/** 读取白名单：开关状态 + 名单（RCON `whitelist list`）。 */
export async function getWhitelist() {
  const [list, props] = await Promise.all([
    rconCommand('whitelist', 'list'),
    sshScript(`grep -E '^white-list=' ${shq(`${MC_SERVER_DIR}/server.properties`)} 2>/dev/null || true`, 10000),
  ]);
  if (!list.ok) return { ok: false, error: list.error };
  const line = String(list.output || '').trim();
  const m = /:\s*(.+)$/.exec(line);
  const names = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  const enabled = /=\s*true\s*$/i.test(String(props.stdout || ''));
  return { ok: true, enabled, names, output: line };
}

/**
 * 白名单动作：add / remove / on / off / list / reload。
 * add/remove 必须提供合法玩家名；其余动作忽略 name。
 */
export async function whitelistAction(action, name = '') {
  const a = String(action || '').trim().toLowerCase();
  if (!WHITELIST_ACTIONS.has(a)) return { ok: false, error: `未知动作：${a || '(空)'}（可用 add/remove/on/off/list/reload）` };
  if (a === 'list') return getWhitelist();
  if (a === 'add' || a === 'remove') {
    const player = String(name || '').trim();
    if (!WHITELIST_NAME_RE.test(player)) {
      return { ok: false, error: '玩家名必须是 1~16 位字母/数字/下划线（Minecraft 用户名格式）' };
    }
    const r = await rconCommand(`whitelist`, a, player);
    return r.ok ? { ok: true, action: a, name: player, output: r.output } : r;
  }
  const r = await rconCommand(`whitelist`, a);
  return r.ok ? { ok: true, action: a, output: r.output } : r;
}
