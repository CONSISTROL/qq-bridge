// 手机 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 作用：把域外手机(Android)变成 agent 的一个可执行远端。
// 通路：本机 → ssh phone(反向隧道) → 手机的 Termux sshd → 手机 shell。
//
// 安全设计：
// - 只暴露「在手机上跑命令 / 看屏幕 / 点屏幕」三类动作，不碰本机文件系统以外的东西。
// - ssh 目标固定为 ssh 别名 phone（隧道由手机主动拨出建立），不做任何转发/跳板。
// - 屏幕相关工具只是包装 adb input 语义，不绕过手机自身的锁屏/权限模型。
// - 本 server 不读 config.json 的敏感字段，只认一个可选的 sshHost 覆盖项。
//
// 注意：UI 注入(input tap/swipe/key)在 MIUI 上需要 root 身份，
// 以普通 app 身份执行会抛 INJECT_EVENTS 权限异常 —— 见 README 的说明。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DEFAULT_HOST = 'phone';
const MAX_OUTPUT = 200_000;   // 单次命令回传上限，防把上下文冲爆
const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 600_000;

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** ssh 别名：允许 config.json 里 phone.sshHost 覆盖，默认 phone。 */
function sshHost() {
  const c = loadConfig();
  const h = c?.phone?.sshHost;
  return typeof h === 'string' && h.trim() ? h.trim() : DEFAULT_HOST;
}

/**
 * ssh 的用户配置默认从 $HOME/.ssh/config 读，而本 server 由 DSH spawn，
 * 环境里未必有 HOME（实测缺 HOME 时别名 phone 会被当成字面主机名，
 * 报 "hostname contains invalid characters"）。所以显式定位配置文件，
 * 并且不依赖 HOME 也能工作。
 */
function sshConfigPath() {
  const c = loadConfig();
  const p = c?.phone?.sshConfig;
  if (typeof p === 'string' && p.trim()) return p.trim();
  const home = process.env.HOME || process.env.USERPROFILE || '/root';
  return path.join(home, '.ssh', 'config');
}

function sshArgs(remoteCommand = []) {
  const args = [
    '-T',                                   // 不要 TTY：否则远端命令会被本地 shell 吃掉
    '-o', 'BatchMode=yes',                  // 禁止交互式提问，避免把工具调用挂死
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ConnectTimeout=10',
  ];
  // 显式指定配置文件；即使别名因此不可用，也会退回下面的显式连接参数
  const cfgPath = sshConfigPath();
  if (fs.existsSync(cfgPath)) args.push('-F', cfgPath);
  else args.push('-F', '/dev/null');
  // 不依赖别名也能连上（config.json 的 phone.host/port/user 可覆盖）
  const c = loadConfig();
  const ph = c?.phone ?? {};
  if (ph.host) args.push('-o', `HostName=${ph.host}`);
  if (ph.port) args.push('-o', `Port=${ph.port}`);
  if (ph.user) args.push('-o', `User=${ph.user}`);
  if (ph.identityFile) args.push('-i', ph.identityFile, '-o', 'IdentitiesOnly=yes');
  // 主机名必须在远端命令之前：ssh [选项] 主机 [命令...]。
  // 之前写反了导致 "sh -s" 被当成主机名，报 hostname contains invalid characters。
  return [...args, sshHost(), ...remoteCommand];
}

/**
 * 在手机上执行一段 shell 脚本，返回 { ok, code, stdout, stderr, timedOut }。
 * 命令通过 stdin 传给远端的 sh，避免多层引号被逐层剥掉。
 */
function runOnPhone(script, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve) => {
    const child = execFile(
      'ssh',
      sshArgs(['sh -s']),
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error?.killed) || error?.signal === 'SIGTERM';
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          timedOut,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
    child.stdin.on('error', () => {});   // 远端提前退出时忽略 EPIPE
    child.stdin.end(script, 'utf8');
  });
}

function clip(s) {
  const t = String(s ?? '');
  if (t.length <= MAX_OUTPUT) return t;
  return `${t.slice(0, MAX_OUTPUT)}\n…[输出被截断，共 ${t.length} 字符]`;
}

function fmt(r, headline) {
  const parts = [headline];
  if (r.stdout) parts.push(`--- stdout ---\n${clip(r.stdout)}`);
  if (r.stderr) parts.push(`--- stderr ---\n${clip(r.stderr)}`);
  if (!r.stdout && !r.stderr) parts.push('(无输出)');
  if (r.timedOut) parts.push('⚠️ 命令超时被中断');
  else if (!r.ok) parts.push(`⚠️ 退出码 ${r.code}`);
  return { content: [{ type: 'text', text: parts.join('\n') }], isError: !r.ok };
}

function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const server = new McpServer({ name: 'phone', version: '0.1.0' });

// ---------------------------------------------------------------- phone_exec
server.registerTool(
  'phone_exec',
  {
    title: '在手机上执行 shell 命令',
    description:
      '在域外 Android 手机上执行一段 shell 命令并返回输出。这是操控手机的主要手段：'
      + '装包、读写文件、查状态、跑脚本都走它。手机是 Termux 环境（Android 的 Linux 用户态），'
      + '不是标准 Linux：没有 systemd，没有 apt 的 root 权限（root 需另走 su），部分命令缺失。'
      + '命令以手机 Termux 的普通应用身份运行，DEFAULT 不可用 DNS 之外的网络限制与标准桌面环境。'
      + '注意：adb 的 input 注入在 MIUI 上要 root 才能生效，普通身份会报 INJECT_EVENTS。',
    inputSchema: {
      command: z.string().describe('要执行的 shell 命令（可多行）。会以 sh -s 从 stdin 送入。'),
      timeoutMs: z.number().int().min(1000).max(MAX_TIMEOUT).optional()
        .describe(`超时毫秒，默认 ${DEFAULT_TIMEOUT}，最大 ${MAX_TIMEOUT}。`),
      sudo: z.boolean().optional()
        .describe('是否用 su 提权再执行（手机上已 root 时可用）。默认 false。'),
    },
  },
  async ({ command, timeoutMs, sudo }) => {
    const script = sudo ? `su -c ${q(command)}` : command;
    const r = await runOnPhone(script, timeoutMs ?? DEFAULT_TIMEOUT);
    return fmt(r, `手机执行完成（退出码 ${r.code}）`);
  },
);

// ------------------------------------------------------------ phone_status
server.registerTool(
  'phone_status',
  {
    title: '检查手机是否在线可达',
    description:
      '探活：检查反向隧道是否还通、手机 sshd 是否响应。返回手机型号/系统版本/电量/屏幕与锁屏状态。'
      + '在调用其他手机工具前先用它确认链路，能省掉大量莫名的超时。',
    inputSchema: {},
  },
  async () => {
    const script = [
      'echo "HOST=$(hostname 2>/dev/null)"',
      'echo "USER=$(id -un 2>/dev/null)"',
      'echo "MODEL=$(/system/bin/getprop ro.product.model 2>/dev/null)"',
      'echo "ANDROID=$(/system/bin/getprop ro.build.version.release 2>/dev/null)"',
      'echo "KERNEL=$(uname -srm)"',
      'echo "STORAGE_AVAIL=$(df -h /data/data/com.termux/files/home 2>/dev/null | tail -n 1 | tr -s " " | cut -d" " -f4)"',
      'echo "TUNNEL=up"',
      // 电量需要 root；Termux 应用身份读不到 sysfs 电池节点，
      // 而 /system/bin/su 在 Termux 挂载命名空间里不可见（Magisk 只授权给 adb 的 shell 用户）。
      'B="/system/bin/dumpsys battery 2>/dev/null"',
      'BL=$(/system/bin/dumpsys battery 2>/dev/null | grep level)',
      'if [ -n "$BL" ]; then echo "BATT=${BL##*: }"; else echo "BATT=(需 root 才能读)"; fi',
      'echo "ROOT=$(if [ -x /system/bin/su ] || [ -x /debug_ramdisk/su ]; then echo available; else echo unavailable; fi)"',
    ].join('\n');
    const r = await runOnPhone(script, 25_000);
    if (!r.ok && !r.stdout) {
      return {
        content: [{
          type: 'text',
          text: `手机不可达。隧道可能已断或手机休眠/被杀后台。\n--- stderr ---\n${clip(r.stderr)}`,
        }],
        isError: true,
      };
    }
    return fmt(r, '手机在线');
  },
);

// --------------------------------------------------------- phone_screenshot
server.registerTool(
  'phone_screenshot',
  {
    title: '给手机屏幕截一张图并直接看到',
    description:
      '截取手机当前画面并以图像内容返回（视觉模型可直接看到）。'
      + '用于判断当前在哪个界面、界面元素在哪、操作有没有生效。'
      + '注意：息屏状态下截到的是纯黑图；手机息屏/锁屏时先唤醒并解锁再截。',
    inputSchema: {
      maxWidth: z.number().int().min(120).max(2000).optional()
        .describe('返回图的最大宽度（等比缩放），默认 720，用于控制上下文占用。'),
    },
  },
  async ({ maxWidth = 720 }) => {
    const remote = '/data/data/com.termux/files/home/.phone_shot.png';
    const prep = [
      `rm -f ${remote}`,
      `screencap -p ${remote} 2>/dev/null || /system/bin/screencap -p ${remote}`,
      // 用 termux 自带的 png 转码能力有限，直接取原始 PNG，必要时在本地缩
      `ls -l ${remote} 2>/dev/null | awk '{print $5}'`,
    ].join('\n');
    const r = await runOnPhone(prep, 30_000);
    if (!r.ok) return fmt(r, '截屏失败');

    const size = parseInt(r.stdout.trim().split('\n').pop(), 10);
    if (!Number.isFinite(size) || size <= 0) {
      return {
        content: [{ type: 'text', text: '截屏失败：文件为空。手机可能息屏或权限不足。' }],
        isError: true,
      };
    }

    const b64 = await new Promise((resolve) => {
      const child = execFile('ssh', sshArgs([`base64 -w0 ${remote}`]), { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
        (error, stdout) => resolve(error ? null : String(stdout).replace(/\s+/g, '')));
    });
    void runOnPhone(`rm -f ${remote}`, 10_000);
    if (!b64) {
      return { content: [{ type: 'text', text: '截屏文件读取失败' }], isError: true };
    }
    return {
      content: [
        { type: 'text', text: `手机当前屏幕（PNG，约 ${Math.round(size / 1024)} KB，建议显示宽度 ${maxWidth}px）：` },
        { type: 'image', mimeType: 'image/png', data: b64 },
      ],
    };
  },
);

// ------------------------------------------------------------ phone_ui_tap
// MIUI/HyperOS 禁止普通应用注入输入事件（INJECT_EVENTS），所以默认走手机本机的 su。
const inputTools = [
  {
    name: 'phone_tap',
    title: '点击手机屏幕坐标',
    desc: '按坐标点击手机屏幕。坐标系是手机的物理像素（可用 phone_screen_info 查分辨率）。'
      + '注入前务必确认屏幕亮着且已解锁：息屏时注入会被静默丢弃（不报错但没效果），'
      + '锁屏时注入进不到应用。默认经 su 提权（MIUI 上必须）。',
    schema: {
      x: z.number().int().min(0).describe('横坐标（像素）'),
      y: z.number().int().min(0).describe('纵坐标（像素）'),
      sudo: z.boolean().optional().describe('是否用 su 提权，默认 true（MIUI 上普通身份必失败）'),
    },
    build: ({ x, y, sudo = true }) => ({ cmd: `input tap ${x} ${y}`, sudo }),
  },
  {
    name: 'phone_swipe',
    title: '在手机屏幕上滑动',
    desc: '从 (x1,y1) 滑到 (x2,y2)，用于滚动列表/翻页。durationMs 越大越慢。'
      + '注意：较慢的滑动(<300ms)更容易被识别为 fling 而滚动过头。默认经 su 提权。',
    schema: {
      x1: z.number().int().min(0), y1: z.number().int().min(0),
      x2: z.number().int().min(0), y2: z.number().int().min(0),
      durationMs: z.number().int().min(50).max(5000).optional().describe('滑动时长，默认 300ms'),
      sudo: z.boolean().optional().describe('是否用 su 提权，默认 true'),
    },
    build: ({ x1, y1, x2, y2, durationMs = 300, sudo = true }) => ({
      cmd: `input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`, sudo,
    }),
  },
  {
    name: 'phone_key',
    title: '给手机发送按键事件',
    desc: '发送一个按键。常用键码：3=HOME，4=返回，26=电源，66=回车，67=退格，'
      + '82=菜单，187=最近任务，224=唤醒，223=熄屏，279=粘贴。'
      + '重要：锁屏下输入数字必须【逐位、每位间隔数百毫秒】发，一次批量发多个 keycode 会被静默丢弃（不报错也不生效）。'
      + '默认经 su 提权。',
    schema: {
      code: z.number().int().min(0).describe('Android keycode'),
      sudo: z.boolean().optional().describe('是否用 su 提权，默认 true'),
    },
    build: ({ code, sudo = true }) => ({ cmd: `input keyevent ${code}`, sudo }),
  },
];

for (const t of inputTools) {
  server.registerTool(t.name, { title: t.title, description: t.desc, inputSchema: t.schema },
    async (args) => {
      const { cmd, sudo } = t.build(args);
      const script = sudo ? `su -c ${q(cmd)}` : cmd;
      const r = await runOnPhone(script, 20_000);
      if (!r.ok && /INJECT_EVENTS|SecurityException/i.test(r.stderr)) {
        return {
          content: [{
            type: 'text',
            text: '注入被系统拒绝（INJECT_EVENTS）。MIUI 禁止普通应用注入输入事件，'
              + '请用 sudo=true 走 root，或改用 phone_exec 执行其他不需要点击的操作。',
          }],
          isError: true,
        };
      }
      return fmt(r, '已注入');
    });
}

// ------------------------------------------------------- phone_screen_info
server.registerTool(
  'phone_screen_info',
  {
    title: '查看手机屏幕与锁屏状态',
    description:
      '返回分辨率、是否亮屏、是否锁屏、当前前台应用。做 UI 操作前先查它：'
      + '息屏时注入会被静默丢弃（不报错但没效果），锁屏时注入进不到应用。',
    inputSchema: {},
  },
  async () => {
    // dumpsys/wm 以普通应用身份在 Android 14 上返回空（系统服务拒绝不受信任的调用者），
    // 需要 root。这里两种身份都试一遍，让调用者一眼看到实际边界。
    const inner = [
      '/system/bin/wm size',
      '/system/bin/dumpsys power | grep mWakefulness= | head -n 1',
      '/system/bin/dumpsys window | grep mCurrentFocus | tail -n 1',
      '/system/bin/dumpsys window | grep -c isKeyguardShowing=true',
    ].join('; ');
    const script = [
      'echo "--- 普通应用身份 ---"',
      'SIZE=$(/system/bin/wm size 2>&1 | head -n 1); echo "SIZE=$SIZE"',
      'echo "--- 经 su 提权 ---"',
      `su -c ${q(inner)} 2>&1 | head -n 8`,
    ].join('\n');
    const r = await runOnPhone(script, 30_000);
    return fmt(r, '手机屏幕状态');
  },
);

// --------------------------------------------------------- phone_capability
server.registerTool(
  'phone_capability',
  {
    title: '检查手机上有哪些能力真正可用',
    description:
      '探测这台手机当前允许做什么：命令执行、文件读写、出站网络、屏幕截图、UI 注入、系统服务查询。'
      + '**需要看屏幕或点击前先调它**：Android 14 上以 Termux 应用身份运行时，'
      + '截屏（screencap 产出 0 字节）、UI 注入（INJECT_EVENTS）、系统服务（dumpsys/wm）'
      + '都会被系统拒绝，只有拿到 root 才可用。与其逐个踩坑，不如先看这里。',
    inputSchema: {},
  },
  async () => {
    // 注意：Android 的 /system/bin/sh 是很简陋的 mksh/dash 变体，
    // 复杂构造（嵌套命令替换 + case + 管道混排）容易触发
    // "Syntax error: Unterminated quoted string"。
    // 这里只用最简单的 if/赋值/重定向，避免再次踩坑。
    const script = [
      'echo "=== 基本身份 ==="',
      'echo "uid=$(id -u) user=$(id -un)"',
      'echo "=== root 通路 ==="',
      'FOUND=no',
      'for p in /debug_ramdisk/su /sbin/su /system/bin/su /system/xbin/su /su/bin/su; do',
      '  [ -x "$p" ] && { echo "  EXEC $p"; FOUND=yes; }',
      'done',
      'echo "  root=$FOUND"',
      'echo "=== 命令 ==="',
      'echo "  curl: $(command -v curl || echo none)"',
      'echo "=== 文件读写 ==="',
      'FT=$HOME/.cap.txt',
      'rm -f "$FT"',
      'echo probe > "$FT"',
      'if [ -s "$FT" ]; then echo "  OK"; else echo "  失败"; fi',
      'rm -f "$FT"',
      'echo "=== 系统服务(需 root) ==="',
      '/system/bin/dumpsys power > $HOME/.d.txt 2>&1',
      'if [ -s $HOME/.d.txt ]; then echo "  dumpsys: OK"; else echo "  dumpsys: 不可用(需 root)"; fi',
      'rm -f $HOME/.d.txt',
      'echo "=== 屏幕截图(需 root) ==="',
      'ST=$HOME/.cap.png',
      'rm -f "$ST"',
      '/system/bin/screencap -p "$ST" > /dev/null 2>&1',
      'SZ=0',
      'if [ -f "$ST" ]; then SZ=$(wc -c < "$ST"); fi',
      'if [ "$SZ" -gt 1000 ]; then echo "  可用 $SZ 字节"; else echo "  不可用(0 字节, 需 root)"; fi',
      'rm -f "$ST"',
      'echo "=== UI 注入(需 root) ==="',
      '/system/bin/input tap 1 1 > $HOME/.i.txt 2>&1',
      'if [ -s $HOME/.i.txt ]; then echo "  被拒:"; head -c 100 $HOME/.i.txt; else echo "  OK"; fi',
      'rm -f $HOME/.i.txt',
      'echo "=== 出站 ==="',
      'if /system/bin/ping -c 1 -W 3 139.196.173.199 > /dev/null 2>&1; then echo "  OK"; else echo "  失败"; fi',
    ].join('\n');
    const r = await runOnPhone(script, 40_000);
    return fmt(r, '手机能力探测');
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
