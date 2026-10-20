// 手机控制（桥接侧）：通过 `ssh phone` → 手机 Termux → `su -c`（Magisk root）执行。
//
// 为什么走 ssh 别名 phone：手机主动拨反向隧道过来，本机不用知道它的 IP；
// 和 src/mcp-phone.js 用的是同一条通路，保证 MCP 与桥接行为一致。
// 权限：普通 Termux 身份没有 INJECT_EVENTS / READ_FRAME_BUFFER，screencap 会写 0 字节、
// input 会抛 SecurityException —— 所以必须 `su -c`（手机已 root，实测 uid=0 可用）。
import { execFile } from 'node:child_process';

const HOST = 'phone';
const MAX_OUT = 200_000;

function sh(cmd, { timeoutMs = 30000, su = true } = {}) {
  const remote = su ? `su -c ${JSON.stringify(cmd)}` : cmd;
  return new Promise((resolve) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', HOST, remote], { timeout: timeoutMs, maxBuffer: MAX_OUT }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout ?? ''), err: String(stderr ?? '').slice(0, 2000), code: error?.code ?? 0 });
    });
  });
}

/** 状态：型号/系统/电量/屏幕/前台应用。 */
export async function phoneStatus() {
  const one = await sh('getprop ro.product.model; getprop ro.build.version.release');
  const [model = '', version = ''] = one.out.trim().split('\n');
  const bat = await sh('dumpsys battery | grep -E "level|status|temperature"');
  const lvl = /level:\s*(\d+)/.exec(bat.out);
  const st = /status:\s*(\d+)/.exec(bat.out);
  const temp = /temperature:\s*(\d+)/.exec(bat.out);
  const scr = await sh('dumpsys power | grep -E "mWakefulness=|Display Power" | head -3');
  const awake = /mWakefulness=(\w+)/.exec(scr.out)?.[1] || '';
  const act = await sh('dumpsys window | grep -E "mCurrentFocus|mFocusedApp" | head -2');
  const focus = /mCurrentFocus=([^}\n]+)/.exec(act.out)?.[1]?.trim() || '';
  return {
    ok: one.ok,
    model, android: version,
    battery: lvl ? Number(lvl[1]) : null,
    charging: st ? Number(st[1]) === 2 || Number(st[1]) === 5 : null,
    temperatureC: temp ? Number(temp[1]) / 10 : null,
    screenAwake: awake || 'unknown',
    foreground: focus,
    raw: { battery: bat.out.trim(), power: scr.out.trim(), window: act.out.trim() }
  };
}

/** 截图：root 写 /data/local/tmp 再 cat 回 base64（PNG）。 */
export async function phoneScreenshot({ timeoutMs = 45000 } = {}) {
  const path = `/data/local/tmp/qqb-${Date.now()}.png`;
  const cap = await sh(`screencap -p ${path}`, { timeoutMs });
  if (!cap.ok) return { ok: false, error: `截图失败：${cap.err || cap.out || 'screencap 失败'}` };
  const cat = await sh(`base64 ${path}; rm -f ${path}`, { timeoutMs });
  const b64 = cat.out.replace(/\s+/g, '');
  if (!b64) return { ok: false, error: '截图是空的（可能没开屏或没权限）' };
  return { ok: true, data: b64, mimeType: 'image/png', bytes: Math.round((b64.length * 3) / 4) };
}

/** 操作：tap / swipe / key / text。坐标是屏幕像素。 */
export async function phoneAct({ action, x, y, x2, y2, ms, keycode, text } = {}) {
  const a = String(action || '').toLowerCase();
  let cmd = '';
  if (a === 'tap') {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'tap 需要 x/y' };
    cmd = `input tap ${Math.round(x)} ${Math.round(y)}`;
  } else if (a === 'swipe') {
    if (![x, y, x2, y2].every(Number.isFinite)) return { ok: false, error: 'swipe 需要 x/y/x2/y2' };
    cmd = `input swipe ${Math.round(x)} ${Math.round(y)} ${Math.round(x2)} ${Math.round(y2)} ${Math.max(50, Number(ms) || 300)}`;
  } else if (a === 'key') {
    const code = Number(keycode) || ({ back: 4, home: 3, recents: 187, power: 26, enter: 66 }[String(keycode || '').toLowerCase()] || 0);
    if (!code) return { ok: false, error: 'key 需要 keycode（数字或 back/home/recents/power/enter）' };
    cmd = `input keyevent ${code}`;
  } else if (a === 'text') {
    if (!String(text || '').trim()) return { ok: false, error: 'text 需要内容' };
    // input text 不支持空格/中文：空格转 %s，非 ASCII 走 am broadcast（多数机型也不支持中文，如实返回）
    cmd = `input text ${JSON.stringify(String(text).replace(/ /g, '%s'))}`;
  } else {
    return { ok: false, error: 'action 只能是 tap / swipe / key / text' };
  }
  const r = await sh(cmd, { timeoutMs: 20000 });
  return r.ok ? { ok: true, action: a, cmd } : { ok: false, error: r.err || r.out || '执行失败' };
}

/** 任意命令（高危，需 phoneExec 能力放行）。 */
export async function phoneShell(cmd, { timeoutMs = 60000 } = {}) {
  if (!String(cmd || '').trim()) return { ok: false, error: 'cmd 不能为空' };
  const r = await sh(cmd, { timeoutMs });
  return { ok: r.ok, out: r.out.slice(0, 8000), err: r.err, code: r.code };
}

/** 刷 B站（高层）：打开 App → 可选的搜索 → 刷几屏 → 截图 + 前台标题。 */
export async function phoneBili({ task = 'feed', query = '', swipes = 3 } = {}) {
  // 先亮屏 + 上滑解锁：锁屏状态下 App 起来了也看不到，等于白刷。
  const wake = await phoneWake();
  if (!wake.unlocked) {
    return { ok: false, error: wake.note, wake };
  }
  const pkgs = ['tv.danmaku.bili', 'com.bilibili.app', 'tv.danmaku.bilibili'];
  const exists = await sh('pm list packages | grep -i bili | head -3');
  const pkg = (pkgs.find((p) => exists.out.includes(p))) || (exists.out.match(/package:(\S+)/)?.[1] ?? '');
  if (!pkg) return { ok: false, error: '手机上没找到 B站 App（pm list packages 里没有 bili）' };
  const home = await sh('input keyevent 3'); // 先回桌面
  let launch = '';
  if (task === 'search' && query) {
    // 直接走 B站 搜索 deep link（多数版本支持）
    launch = `am start -a android.intent.action.VIEW -d ${JSON.stringify(`bilibili://search?keyword=${encodeURIComponent(query)}`)} ${pkg}`;
  } else {
    launch = `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`;
  }
  const r = await sh(launch, { timeoutMs: 30000 });
  await new Promise((res) => setTimeout(res, 2500));
  for (let i = 0; i < Math.max(0, Math.min(10, Number(swipes) || 0)); i++) {
    await sh('input swipe 540 1600 540 500 320', { timeoutMs: 12000 });
    await new Promise((res) => setTimeout(res, i === 0 ? 2200 : 1200));
  }
  const fg = await sh('dumpsys window | grep -E "mCurrentFocus" | head -1');
  const shot = await phoneScreenshot();
  return {
    ok: true, pkg, task,
    launchOk: r.ok,
    foreground: /mCurrentFocus=([^}\n]+)/.exec(fg.out)?.[1]?.trim() || '',
    screenshot: shot.ok ? { data: shot.data, mimeType: shot.mimeType, bytes: shot.bytes } : null,
    note: launch,
    wake
  };
}

/**
 * 亮屏 + 上滑解锁（无密码/图案时）。有密码就只能停在锁屏，如实返回。
 * 返回 { ok, awake, unlocked, note }——不假装成功。
 */
export async function phoneWake() {
  const wakefulness = async () => (await sh('dumpsys power | grep -m1 -E "mWakefulness="')).out.trim();
  // 锁屏判定用 dumpsys window policy 的 showing= 字段（MIUI 上比 mKeyguardShowing 可靠）
  const keyguardShowing = async () => /showing=true/.test((await sh('dumpsys window policy | grep -m3 -E "showing=|deviceHasKeyguard"')).out);
  let state = await wakefulness();
  let woke = false;
  if (!/Awake/.test(state)) {
    await sh('input keyevent 224', { timeoutMs: 12000 });      // WAKEUP
    await new Promise((r) => setTimeout(r, 1500));
    state = await wakefulness();
    if (!/Awake/.test(state)) {                                 // 有些机型 224 无效，按电源键
      await sh('input keyevent 26', { timeoutMs: 12000 });
      await new Promise((r) => setTimeout(r, 1800));
      state = await wakefulness();
    }
    woke = /Awake/.test(state);
  }
  let locked = await keyguardShowing();
  if (locked) {
    // 上滑（有密码/图案时只会停在输入界面，不会误操作别的）
    await sh('input swipe 610 2200 610 700 300', { timeoutMs: 12000 });
    await new Promise((r) => setTimeout(r, 1600));
    locked = await keyguardShowing();
  }
  if (locked) {                                                 // 部分机型还要 MENU 一下才退锁屏
    await sh('input keyevent 82', { timeoutMs: 10000 });
    await new Promise((r) => setTimeout(r, 1200));
    locked = await keyguardShowing();
  }
  const fg = (await sh('dumpsys window | grep -m1 -E "mCurrentFocus"')).out.trim();
  return {
    ok: true,
    awake: /Awake/.test(state),
    unlocked: !locked,
    woke,
    foreground: /mCurrentFocus=([^}\n]+)/.exec(fg)?.[1]?.trim() || '',
    note: locked ? '仍在锁屏：手机有密码/图案，只能你手动解锁（我做到「亮屏+上滑」为止）' : '已解锁'
  };
}
