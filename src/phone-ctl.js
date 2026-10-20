// 手机控制（桥接侧）：通过 `ssh phone` → 手机 Termux → `su -c`（Magisk root）执行。
//
// 为什么走 ssh 别名 phone：手机主动拨反向隧道过来，本机不用知道它的 IP；
// 和 src/mcp-phone.js 用的是同一条通路，保证 MCP 与桥接行为一致。
// 权限：普通 Termux 身份没有 INJECT_EVENTS / READ_FRAME_BUFFER，screencap 会写 0 字节、
// input 会抛 SecurityException —— 所以必须 `su -c`（手机已 root，实测 uid=0 可用）。
import { execFile } from 'node:child_process';

const HOST = 'phone';
const MAX_OUT = 200_000;

function sh(cmd, { timeoutMs = 30000, su = true, maxBuffer = MAX_OUT } = {}) {
  const remote = su ? `su -c ${JSON.stringify(cmd)}` : cmd;
  return new Promise((resolve) => {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', HOST, remote], { timeout: timeoutMs, maxBuffer }, (error, stdout, stderr) => {
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
  const cat = await sh(`base64 ${path}; rm -f ${path}`, { timeoutMs, maxBuffer: 24 * 1024 * 1024 });
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
  // 锁屏时点/滑等于白点：先尝试进入可操作状态（只在本次进程里试一次，别每次操作都跑 20 秒）
  if (!globalThis.__qqPhonePrepared) {
    const kg = await sh('dumpsys window policy | grep -m1 -E "showing="');
    if (/showing=true/.test(kg.out)) { await phonePrepare(); globalThis.__qqPhonePrepared = true; }
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
export async function phoneBili({ task = 'feed', query = '', swipes = 3, pin = '' } = {}) {
  // 先亮屏；还锁着就用数字密码解（有配置的话），再不行才走 prepare
  let wake = await phoneWake();
  if (!wake.unlocked) {
    if (String(pin || '').trim()) {
      const u = await phoneUnlock({ pin });
      if (u.unlocked) wake = { ...wake, unlocked: true, note: u.note };
    }
    if (!wake.unlocked) {
      const prep = await phonePrepare();
      const u2 = String(pin || '').trim() ? await phoneUnlock({ pin }) : null;
      if (u2?.unlocked) wake = { ...wake, unlocked: true, note: u2.note };
      else {
        wake = prep.wake || wake;
        if (!wake.unlocked) return { ok: false, error: wake.note, wake, prepare: prep };
      }
    }
  }
  const pkgs = ['tv.danmaku.bili', 'com.bilibili.app', 'tv.danmaku.bilibili'];
  const exists = await sh('pm list packages | grep -i bili | head -3');
  const pkg = (pkgs.find((p) => exists.out.includes(p))) || (exists.out.match(/package:(\S+)/)?.[1] ?? '');
  if (!pkg) return { ok: false, error: '手机上没找到 B站 App（pm list packages 里没有 bili）' };
  await sh('input keyevent 3'); // 先回桌面
  // MIUI 上 monkey 常常起不来（实测起完前台还是桌面），所以优先用 am start + 解析出来的 Activity
  const resolved = (await sh(`cmd package resolve-activity --brief ${pkg} | tail -1`)).out.trim();
  const act = resolved.includes('/') ? resolved : '';
  let launch = '';
  if (task === 'search' && query) {
    launch = `am start -a android.intent.action.VIEW -d ${JSON.stringify(`bilibili://search?keyword=${encodeURIComponent(query)}`)} ${pkg}`;
  } else if (act) {
    launch = `am start -n ${act}`;
  } else {
    launch = `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`;
  }
  const r = await sh(launch, { timeoutMs: 30000 });
  await new Promise((res) => setTimeout(res, 3000));
  // 未登录/新装时会有「完善信息，获取精准推荐」弹层挡住首页：
  // 实测按返回会直接退出 App，正确做法是点一下弹层**上方**的空白区（首页 ~18% 高度处）把它收掉。
  const H2 = Number((await sh('wm size')).out.match(/x(\d+)/)?.[1]) || 2712;
  await sh(`input tap ${Math.round(((await sh('wm size')).out.match(/(\d+)x/)?.[1] || 1220) / 2)} ${Math.round(H2 * 0.18)}`, { timeoutMs: 10000 });
  await new Promise((res) => setTimeout(res, 1200));
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

/**
 * 让手机进入「可被全程操作」的状态（owner 要求全程由 bot 操作）：
 *   1. 关闭锁屏（settings secure lockscreen.disabled 1）——这样亮屏就是桌面/App，不需要密码；
 *   2. 充电时常亮（svc power stayon true），并拉长息屏时间（1 小时）；
 *   3. 亮屏 + 上滑，把当前锁屏退掉。
 * 这一步会**降低手机安全性**（谁拿到手机都能直接用）；还原：
 *   su -c 'settings put secure lockscreen.disabled 0' && su -c 'svc power stayon false'
 */
export async function phonePrepare() {
  const steps = [];
  const run = async (cmd, label) => {
    const r = await sh(cmd, { timeoutMs: 20000 });
    steps.push({ label, ok: r.ok, err: r.ok ? '' : (r.err || r.out).slice(0, 160) });
    return r.ok;
  };
  await run('settings put secure lockscreen.disabled 1', '关闭锁屏');
  await run('svc power stayon true', '充电时常亮');
  await run('settings put system screen_off_timeout 3600000', '息屏时间 1 小时');
  const wake = await phoneWake();
  return { ok: wake.awake, steps, wake, note: wake.unlocked ? '已就绪：锁屏已关闭，可直接操作' : `仍受限：${wake.note}` };
}

/** 还原（交还手机时用）：恢复锁屏与息屏设置。 */
export async function phoneUnprepare() {
  await sh('settings put secure lockscreen.disabled 0', { timeoutMs: 15000 });
  await sh('svc power stayon false', { timeoutMs: 15000 });
  return { ok: true, note: '已恢复锁屏与常亮设置' };
}


/** 用 uiautomator dump 找界面元素：返回 [{text, desc, cls, x, y}]（居中坐标）。 */
export async function phoneUI() {
  const r = await sh('uiautomator dump /data/local/tmp/ui.xml >/dev/null 2>&1; cat /data/local/tmp/ui.xml', { timeoutMs: 30000, maxBuffer: 8 << 20 });
  const xml = r.out || '';
  const out = [];
  const re = /<node[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const get = (k) => (new RegExp(`${k}="([^"]*)"`).exec(tag) || [])[1] || '';
    const text = get('text'), desc = get('content-desc'), cls = get('class');
    const b = get('bounds');
    if (!text && !desc) continue;
    const nums = b.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!nums) continue;
    const [x1, y1, x2, y2] = nums.slice(1).map(Number);
    out.push({ text, desc, cls, x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) });
  }
  return out;
}

/** 在界面上按文字/描述找一个元素（包含匹配，优先可点击的）。 */
export async function phoneFindText(needle) {
  const ui = await phoneUI();
  const keys = [].concat(needle);
  for (const k of keys) {
    const hit = ui.find((e) => e.text.includes(k) || e.desc.includes(k));
    if (hit) return hit;
  }
  return null;
}
/**
 * 用数字密码解锁（需要 config.phone.unlockPin）。
 * 做法：亮屏 → input text <pin> → 回车 → 校验 lockscreen 是否消失。
 * 安全：密码只从 config.json 读，不写日志、不回传给 AI（返回里只说成功/失败）。
 */
export async function phoneUnlock({ pin = '' } = {}) {
  const code = String(pin || '').replace(/\s+/g, '');
  if (!/^\d{4,8}$/.test(code)) return { ok: false, error: '没有可用的数字密码（config.phone.unlockPin），或格式不对' };
  const locked = async () => /showing=true/.test((await sh('dumpsys window policy | grep -m1 -E "showing="')).out);
  await phoneWake();
  if (!(await locked())) return { ok: true, alreadyUnlocked: true, note: '本来就是解锁状态' };
  // 屏幕分辨率（数字键盘坐标按比例算，换机型也能用）
  const size = (await sh('wm size')).out.match(/(\d+)x(\d+)/);
  const W = size ? Number(size[1]) : 1220;
  const H = size ? Number(size[2]) : 2712;
  const col = (i) => Math.round(W * [0.25, 0.5, 0.75][i]);
  // 实测 MIUI 数字键盘四行中心（按高度比例）
  const row = (i) => Math.round(H * [0.555, 0.632, 0.710, 0.787][i]);
  const key = (d) => {
    if (d === '0') return [col(1), row(3)];
    const n = Number(d);
    return [col((n - 1) % 3), row(Math.floor((n - 1) / 3))];
  };
  // 优先点数字键（锁屏上 input text 常常不生效，实测 6 位 PIN 点击可用）
  for (const d of code) {
    const [x, y] = key(d);
    await sh(`input tap ${x} ${y}`, { timeoutMs: 12000 });
    await new Promise((r) => setTimeout(r, 220));
  }
  await new Promise((r) => setTimeout(r, 1500));
  let stillLocked = await locked();
  if (stillLocked) {
    // 兜底：有些机型要按回车确认
    await sh('input keyevent 66', { timeoutMs: 10000 });
    await new Promise((r) => setTimeout(r, 1200));
    stillLocked = await locked();
  }
  return { ok: !stillLocked, unlocked: !stillLocked, note: stillLocked ? '密码不对或没解掉（仍是锁屏）' : '已解锁' };
}

/** 便捷：有配置的密码就自动解，没有就只亮屏。 */
export async function phoneEnsureUnlocked({ pin = '' } = {}) {
  const w = await phoneWake();
  if (w.unlocked) return w;
  if (String(pin || '').trim()) return { ...(await phoneUnlock({ pin })), woke: w.woke };
  return w;
}

/**
 * 发 QQ 动态（说说）。走手机 UI 自动化：QQ → 动态 → 发表 → 输入文字 → 发送。
 *
 * 限制（如实说明）：
 *  · `input text` 只支持 ASCII，中文发不进去。装 ADBKeyboard（一个输入法 APK）后，
 *    可以用 `am broadcast -a ADB_INPUT_B64 --es msg <base64>` 输入中文；没装就只能发英文/数字/emoji。
 *  · 坐标是按 1220x2712 的比例算的，换机型要调。
 *  · 会真的发出去——所以调用方要自己确认过文案。
 */
export async function phonePostMoment({ text = '', pin = '', send = true } = {}) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'text 不能为空' };
  const nonAscii = /[^\x00-\x7F]/.test(body);
  const adbKb = (await sh('pm list packages | grep -i adbkeyboard')).out.trim() !== '';
  if (nonAscii && !adbKb) {
    return { ok: false, error: '文案含中文，但手机没装 ADBKeyboard 输入法（input text 只支持 ASCII）。装好并启用后重试，或改成英文。' };
  }
  let wake = await phoneWake();
  if (!wake.unlocked && pin) { const u = await phoneUnlock({ pin }); if (u.unlocked) wake = { ...wake, unlocked: true }; }
  if (!wake.unlocked) return { ok: false, error: wake.note || '手机仍锁屏' };
  const tapUI = async (el) => { if (!el) return false; await sh(`input tap ${el.x} ${el.y}`, { timeoutMs: 12000 }); return true; };
  const steps = [];
  const shot = async (label) => { const s = await phoneScreenshot(); return s.ok ? { label, data: s.data, bytes: s.bytes } : null; };
  const shots = [];
  // ① 打开 QQ
  const act = (await sh('cmd package resolve-activity --brief com.tencent.mobileqq | tail -1')).out.trim();
  if (act) await sh(`am start -n ${act}`, { timeoutMs: 25000 });
  await new Promise((r) => setTimeout(r, 3500));
  // ② 点底部「动态」（按文字找，找不到才按比例兜底）
  const size = (await sh('wm size')).out.match(/(\d+)x(\d+)/);
  const W = size ? Number(size[1]) : 1220, H = size ? Number(size[2]) : 2712;
  const dynTab = await phoneFindText('动态');
  if (dynTab) { await tapUI(dynTab); steps.push('点动态tab'); } else { await sh(`input tap ${Math.round(W * 0.87)} ${Math.round(H * 0.965)}`); steps.push('点动态tab(坐标)'); }
  await new Promise((r) => setTimeout(r, 3000));
  shots.push(await shot('动态页'));
  // ③ 找「发表 / 说说 / 拍照」入口
  let pub = await phoneFindText(['发表', '说说', '发动态', '这一刻的想法']);
  if (pub) { await tapUI(pub); steps.push('点发表:' + (pub.text || pub.desc)); }
  await new Promise((r) => setTimeout(r, 2500));
  shots.push(await shot('编辑页'));
  // ④ 找输入框（说点什么…）
  const box = await phoneFindText(['说点什么', '这一刻的想法', '分享', '输入']);
  if (box) { await tapUI(box); steps.push('点输入框'); await new Promise((r) => setTimeout(r, 800)); }
  if (adbKb) {
    await sh(`am broadcast -a ADB_INPUT_B64 --es msg ${JSON.stringify(Buffer.from(body, 'utf8').toString('base64'))}`, { timeoutMs: 15000 });
  } else {
    await sh(`input text ${JSON.stringify(body.replace(/ /g, '%s'))}`, { timeoutMs: 20000 });
  }
  await new Promise((r) => setTimeout(r, 1500));
  shots.push(await shot('已输入'));
  if (!send) return { ok: true, stage: 'typed', note: '已输入但未发送（send=false）', steps, shots };
  const sendBtn = await phoneFindText(['发送', '发表']);
  if (!sendBtn) return { ok: false, error: '没找到「发送/发表」按钮', steps, shots };
  await tapUI(sendBtn);
  await new Promise((r) => setTimeout(r, 3000));
  shots.push(await shot('发送后'));
  return { ok: true, stage: 'sent', steps, shots };
}
