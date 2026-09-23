// qq_pick_sticker 端到端测试（隔离实例 + 假 OneBot HTTP 服务）。
//
// 链路：POST /api/socialV2/pick-sticker（挑图）
//   → 拿本地图库候选 id
//   → 再 POST 带 send.id（真发）
//   → 断言假 OneBot 收到 send_private_msg，且 image 段是 base64 图片
//
// 不碰线上 bridge / 真 QQ：用 QQ_BRIDGE_CONFIG + QQ_BRIDGE_STATE_DIR 起隔离实例，
// snowluma 指向本脚本的假 OneBot（WS 连不上会回退 HTTP）。
//
// 说明：这里走「本地图库 → qq_send_image」通道。收藏表情（QQ 表情 URL）通道在测试环境里
// 过不去 —— safeFetchBuffer 会正确拒绝 127.0.0.1，这是 SSRF 防护的预期行为，不是 bug。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = '/tmp/qqbridge-pick-e2e';
const PORT = 3999;          // 假 OneBot
const BRIDGE_PORT = 3198;   // 隔离实例控制台
const STATE = path.join(TMP, 'state');
const LIB = path.join(STATE, 'images');
const E2E_TOKEN = 'e2e-console-token-0123456789';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}${extra ? ` — ${extra}` : ''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 假 OneBot ─────────────────────────────────────────────────────────────
const received = [];
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 忽略 */ }
    received.push({ action: req.url.replace(/^\//, ''), body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1000 + received.length } }));
  });
});

// ── 隔离配置 + 本地图库 ───────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(LIB, { recursive: true });
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
cfg.consolePort = BRIDGE_PORT;
cfg.consoleToken = E2E_TOKEN;
cfg.snowluma = { ...(cfg.snowluma ?? {}), wsUrl: 'ws://127.0.0.1:1/', httpUrl: `http://127.0.0.1:${PORT}` };
cfg.dsh = { ...(cfg.dsh ?? {}), baseUrl: 'http://127.0.0.1:1' };
cfg.socialV2.sticker.pick.minIntervalMs = 0;        // 测试里不受冷却影响
cfg.socialV2.sticker.pick.onlineFallback = false;   // 默认不出网
cfg.socialV2.image.libraryDir = LIB;
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify(cfg, null, 2));
if (!fs.existsSync(path.join(TMP, 'config.json'))) throw new Error('测试配置写入失败');

// 放一张真图进图库（用仓库里的现成素材，保证 looksLikeImageBuffer 通过）
const srcImg = fs.readdirSync(path.join(ROOT, 'assets', 'stickers'))
  .filter((f) => /^style-.*\.(png|jpg)$/i.test(f))
  .map((f) => ({ f, size: fs.statSync(path.join(ROOT, 'assets', 'stickers', f)).size }))
  .sort((a, b) => a.size - b.size)[0];
fs.copyFileSync(path.join(ROOT, 'assets', 'stickers', srcImg.f), path.join(LIB, 'laugh-sticker.jpg'));
fs.writeFileSync(path.join(LIB, 'index.json'), JSON.stringify({
  version: 1,
  items: [{
    file: 'laugh-sticker.jpg',
    source: 'style',
    origin: '大笑表情包',
    title: '绷不住',
    width: 400, height: 400, bytes: srcImg.size, sha256: 'e2e'
  }]
}, null, 2));
// QQ 收藏表情库留空：本用例只验证本地图库通道（收藏表情通道受 SSRF 防护限制，见文件头说明）
fs.writeFileSync(path.join(STATE, 'stickers.json'), '[]');

const bridge = spawn(process.execPath, [path.join(ROOT, 'src', 'bridge.js')], {
  cwd: ROOT,
  env: { ...process.env, QQ_BRIDGE_CONFIG: path.join(TMP, 'config.json'), QQ_BRIDGE_STATE_DIR: STATE },
  stdio: ['ignore', 'pipe', 'pipe']
});
let bridgeLog = '';
bridge.stdout.on('data', (d) => { bridgeLog += d.toString(); });
bridge.stderr.on('data', (d) => { bridgeLog += d.toString(); });

const KEY = 'private:10001';
async function api(pathname, body) {
  const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': E2E_TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

try {
  await new Promise((r) => fake.listen(PORT, '127.0.0.1', r));
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/api/socialV2/config`, { headers: { 'x-console-token': E2E_TOKEN } });
      up = res.ok;
    } catch { /* 还没起来 */ }
    if (!up) await sleep(500);
  }
  ok('隔离实例已启动', up);

  console.log('\n[1] 挑图（本地池）');
  const pick = await api('/api/socialV2/pick-sticker', { key: KEY, context: '哈哈哈哈笑死我了，这也太离谱' });
  ok('接口 200', pick.status === 200 && pick.json?.ok === true, JSON.stringify(pick.json).slice(0, 200));
  ok('时机门放行', pick.json?.moment?.allowed === true, JSON.stringify(pick.json?.moment));
  ok('识别出笑点意图', (pick.json?.intent || []).includes('laugh'), JSON.stringify(pick.json?.intent));
  const top = pick.json?.candidates?.[0];
  ok('给出本地候选', Boolean(top), JSON.stringify(pick.json?.candidates || []).slice(0, 200));
  ok('候选来自本地图库', top?.kind === 'library', JSON.stringify(top));
  ok('候选带可直接发送的 id', Boolean(top?.id));
  ok('没有出网搜索', pick.json?.onlineUsed === false);

  console.log('\n[2] 严肃语境被拦住');
  const serious = await api('/api/socialV2/pick-sticker', { key: KEY, context: '他奶奶住院了，我这几天都在医院' });
  ok('时机门拦住', serious.json?.moment?.allowed === false, serious.json?.moment?.reason);
  const blocked = await api('/api/socialV2/pick-sticker', { key: KEY, context: '他奶奶住院了', send: { id: top?.id } });
  ok('带 send 也拒绝发送（409）', blocked.status === 409, `status=${blocked.status}`);
  ok('没有真的发出消息', received.length === 0, JSON.stringify(received));

  console.log('\n[3] 真的发出去（send.id → 本地图库图片）');
  const sent = await api('/api/socialV2/pick-sticker', { key: KEY, context: '哈哈笑死，接个梗', send: { id: top?.id } });
  ok('发送接口 200', sent.status === 200 && sent.json?.ok === true, JSON.stringify(sent.json).slice(0, 300));
  ok('走图库图片通道', sent.json?.via === 'library', sent.json?.via);
  const msg = received.find((r) => r.action === 'send_private_msg');
  ok('假 OneBot 收到 send_private_msg', Boolean(msg), JSON.stringify(received.map((r) => r.action)));
  const segs = msg?.body?.message || [];
  const imgSeg = segs.find((s) => s.type === 'image');
  ok('消息里带 image 段（base64）', Boolean(imgSeg) && String(imgSeg.data?.file || '').startsWith('base64://'), JSON.stringify(segs).slice(0, 200));
  ok('base64 是非空真图片', String(imgSeg?.data?.file || '').length > 1000);
  ok('目标 QQ 正确', String(msg?.body?.user_id) === '10001', String(msg?.body?.user_id));

  console.log('\n[4] 同一轮不能再发一张（每轮上限）');
  const again = await api('/api/socialV2/pick-sticker', { key: KEY, context: '哈哈哈哈', send: { id: top?.id } });
  ok('被拦（409 或 ok:false）', again.status === 409 || again.json?.ok === false, JSON.stringify(again.json).slice(0, 200));
  ok('没有多发出第二条', received.filter((r) => r.action === 'send_private_msg').length === 1, String(received.length));

  console.log('\n[5] 候选之外的 id 不能发');
  const bad = await api('/api/socialV2/pick-sticker', { key: KEY, context: '哈哈', searchOnline: false, send: { id: 'not-a-real-sticker' } });
  ok('拒绝未知 id', bad.status >= 400, `status=${bad.status} ${JSON.stringify(bad.json).slice(0, 160)}`);

  console.log(`\n结果：${pass} 项通过 / ${fail} 项失败`);
} catch (error) {
  fail++;
  console.log(`❌ 测试异常：${error?.message ?? error}`);
  console.log(bridgeLog.split('\n').slice(-25).join('\n'));
} finally {
  bridge.kill('SIGKILL');
  fake.close();
  await sleep(400);
  const tail = bridgeLog.split('\n').filter((l) => /sticker|pick|错误|失败/.test(l)).slice(-10).join('\n');
  if (fail > 0 && tail) console.log(`\n桥接日志片段：\n${tail}`);
  process.exit(fail === 0 ? 0 : 1);
}
