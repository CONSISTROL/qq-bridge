// P1 验证：qq_save_sticker 的服务端行为（本地图库 / base64 / 远程开关 / SSRF / 限流）
//
// 用法：node scripts/test-p1-save-sticker.mjs [会话key]
// 需要桥接正在运行（控制台 3100）。会创建少量测试表情，结束后自动删除。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = process.argv[2] || 'private:1472298635';
const BASE = 'http://127.0.0.1:3100';
const CONSOLE_TOKEN = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const ONE_BOT = {
  url: String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
  token: cfg.snowluma?.accessToken || ''
};

const STICKER_DIR = path.join(ROOT, 'assets', 'stickers');
const TEST_IMG = 'p1-test.png';
const NOT_IMG = 'p1-not-image.png';

let failures = 0;
const created = [];

function check(label, ok, detail) {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function consoleApi(pathname, body, method = 'POST') {
  const res = await fetch(BASE + pathname, {
    method,
    headers: { 'content-type': 'application/json', 'x-console-token': CONSOLE_TOKEN },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

async function saveSticker(image, extra = {}) {
  return consoleApi('/api/socialV2/save-sticker', { key: KEY, image, ...extra });
}

async function oneBot(action, params) {
  const res = await fetch(`${ONE_BOT.url}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ONE_BOT.token}` },
    body: JSON.stringify(params)
  });
  return res.json();
}

function errText(res) { return String(res.json?.error ?? res.text ?? '').slice(0, 160); }

try {
  fs.mkdirSync(STICKER_DIR, { recursive: true });
  fs.writeFileSync(path.join(STICKER_DIR, NOT_IMG), 'this is not an image');

  // 1) 路径穿越
  const traversal = await saveSticker('../../etc/passwd');
  check('拒绝路径穿越', traversal.json?.ok === false && /纯文件名|非法/.test(errText(traversal)), errText(traversal));

  // 2) 图库里不存在
  const missing = await saveSticker('definitely-not-here.png');
  check('图库缺图时报错', missing.json?.ok === false && /找不到/.test(errText(missing)), errText(missing));

  // 3) 图库文件不是图片
  const notImage = await saveSticker(NOT_IMG);
  check('拒绝非图片文件', notImage.json?.ok === false && /不是有效图片/.test(errText(notImage)), errText(notImage));

  // 4) base64 不是图片
  const badB64 = await saveSticker('data:image/png;base64,aGVsbG8gd29ybGQ=');
  check('拒绝非图片 base64', badB64.json?.ok === false && /不是有效图片/.test(errText(badB64)), errText(badB64));

  // 5) 远程 URL 默认禁用
  const remoteOff = await saveSticker('https://i0.hdslb.com/bfs/emote/test.png', { source: 'url' });
  check('默认拒绝远程 URL', remoteOff.json?.ok === false && /远程图片已禁用/.test(errText(remoteOff)), errText(remoteOff));

  // 6) 正例：本地图库
  const ok = await saveSticker(TEST_IMG, { source: 'library', remark: 'P1测试' });
  check('本地图库保存成功', ok.json?.ok === true && !!ok.json?.emojiId, `emojiId=${ok.json?.emojiId ?? '-'} via=${ok.json?.via ?? '-'}`);
  if (ok.json?.emojiId) created.push(String(ok.json.emojiId));

  // 7) 打开远程开关后，内网地址必须被 SSRF 防护拦掉
  await consoleApi('/api/socialV2/config', { image: { allowRemoteUrl: true } });
  const ssrf = await saveSticker('http://127.0.0.1:3100/');
  check('开启远程后仍拒绝内网地址', ssrf.json?.ok === false, errText(ssrf));
  await consoleApi('/api/socialV2/config', { image: { allowRemoteUrl: false } });

  // 8) 限流：把每分钟上限压到 1，再存第二张应当 429
  await consoleApi('/api/socialV2/config', { image: { maxPerMinute: 1 } });
  const second = await saveSticker(TEST_IMG, { source: 'library', remark: 'P1限流' });
  check('超过每分钟上限返回 429', second.status === 429, `status=${second.status} ${errText(second)}`);
  if (second.json?.emojiId) created.push(String(second.json.emojiId));
  await consoleApi('/api/socialV2/config', { image: { maxPerMinute: 5 } });
} catch (error) {
  check('测试执行', false, String(error?.message ?? error));
} finally {
  // 清理：删除测试创建的表情 + 测试用非图片文件
  for (const emojiId of created) {
    try {
      const del = await oneBot('delete_custom_face', { emoji_id: emojiId });
      console.log(`   [cleanup] 删除测试表情 ${emojiId}: ${del?.status ?? '?'}`);
    } catch (error) {
      console.log(`   [cleanup] 删除测试表情 ${emojiId} 失败：${error?.message ?? error}`);
    }
  }
  try { fs.unlinkSync(path.join(STICKER_DIR, NOT_IMG)); } catch {}
  const image = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).socialV2?.image ?? {};
  console.log(`   [cleanup] 当前 image 配置：allowRemoteUrl=${image.allowRemoteUrl} maxPerMinute=${image.maxPerMinute} maxBytes=${image.maxBytes}`);
}

console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures === 0 ? 0 : 1);
