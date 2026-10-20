import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { validateFetchUrl as realValidateFetchUrl } from '../src/safe-fetch.js';
import { scrubFormulaicSpeech, describeScrub } from '../src/speech-style.js';
import sharp from 'sharp';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
async function test(name, run) {
  const h = await bridgeHarness();
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}
/** 需要自定义 config / globals 的用例。 */
async function testWith(opts, name, run) {
  const h = await bridgeHarness(opts);
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}
/** 打桥接控制台 API（GET/POST 都走这个）。 */
function apiRequest(server, path, { method = 'POST', body = null, agentToken = '' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? '' : JSON.stringify(body);
    const headers = {};
    if (payload) headers['content-type'] = 'application/json';
    if (agentToken) headers['x-agent-token'] = agentToken;
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path, method, headers }, (response) => {
      let raw = '';
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    request.setTimeout(20000, () => request.destroy(new Error('api request hung')));
    request.end(payload);
  });
}
await test('unavailable preset catalogue fails closed for QQ and learner sessions', async (h) => {
  h.setPresets([]);
  assert.equal(h.resolvePresetName('missing'), '');
  await assert.rejects(h.ensureSession('group:456'));
  await assert.rejects(h.ensureSlangLearnerSession());
  assert.equal(h.calls.created.length, 0);
});
await test('queued send rechecks allowlist at actual transport time', async (h) => {
  const sending = h.sendToQQ('group:456', 'fixture');
  h.cfg.allow.groups = [];
  await sending;
  assert.equal(h.calls.sent.length, 0);
});
await test('old prompt completion cannot delete replacement queue after reset', async (h) => {
  const release = [];
  h.api.sessions.prompt = async () => {
    await new Promise((resolve) => release.push(resolve));
    return { result: { ok: true, value: {} } };
  };
  const first = h.deliverPrompt('group:456', 'first');
  while (release.length < 1) await new Promise((resolve) => setImmediate(resolve));
  h.drainPromptQueue('group:456', 'reset');
  const second = h.deliverPrompt('group:456', 'second');
  while (release.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const replacement = h.promptQueues.get('group:456');
  release[0](); await first;
  assert.equal(h.promptQueues.get('group:456'), replacement);
  release[1](); await second;
});
await test('same-policy sessions are reused but legacy unlabelled sessions are replaced', async (h) => {
  const first = await h.ensureSession('private:123');
  assert.equal(await h.ensureSession('private:123'), first);
  delete h.state.sessionPolicies['private:123'];
  assert.notEqual(await h.ensureSession('private:123'), first);
});
// DSH 的 agent preset 在会话创建时读一次、之后永久锁定（agent-preset/locked），
// 所以预设文件改过之后，老会话必须退役重建，否则「改了预设等于没改」。
const stampFixture = { presetCompositionStamp: () => 'fixture-stamp' };
await testWith({ globals: stampFixture }, 'matching preset stamp keeps the session', async (h) => {
  const first = await h.ensureSession('private:123');
  assert.equal(await h.ensureSession('private:123'), first);
  assert.equal(h.state.sessionPresetStamps['private:123'], 'fixture-stamp');
});
await testWith({ globals: stampFixture }, 'changed/legacy preset stamp retires and rebuilds the session', async (h) => {
  const first = await h.ensureSession('private:123');
  // 老会话建于「记录组成戳」之前：没有记录 = 无法保证跑的是当前预设。
  delete h.state.sessionPresetStamps['private:123'];
  const second = await h.ensureSession('private:123');
  assert.notEqual(second, first);
  assert.ok(h.calls.archived.includes(first), '旧 DSH 会话已归档');
  assert.equal(h.state.sessionPresetStamps['private:123'], 'fixture-stamp', '新会话重新记戳');
});
// 这个回合的唤醒提示词是「先建好提示、再 ensureSession」的：刷新会话如果顺手轮换
// agent token / 重置 bootstrap，刚发出去的提示词就带着一个废令牌，整个回合调不动工具。
await testWith({ globals: stampFixture }, 'preset refresh keeps the token already handed to the model', async (h) => {
  const first = await h.ensureSession('private:123');
  const st = h.getSocialV2State('private:123');
  st.bootstrapSent = true;
  const tokenBefore = st.agentToken;
  delete h.state.sessionPresetStamps['private:123'];
  const second = await h.ensureSession('private:123');
  assert.notEqual(second, first, '会话确实换了');
  assert.equal(h.getSocialV2State('private:123').agentToken, tokenBefore, '令牌保留（否则唤醒提示里的 token 全部失效）');
  assert.equal(h.getSocialV2State('private:123').bootstrapSent, true, 'bootstrap 标记保留（不再重复引导）');
});
await test('takeBootstrapV2 only bootstraps a genuinely new conversation', async (h) => {
  const st = h.getSocialV2State('private:123');
  assert.equal(h.takeBootstrapV2(st), true, '新会话要引导');
  st.bootstrapSent = false;
  st.recentMessages.push({ sender: 'x', text: 'hi' });
  assert.equal(h.takeBootstrapV2(st), false, '有历史（会话被重建过）就不再引导');
  assert.equal(st.bootstrapSent, true, '顺手把标记修回去，不会每次唤醒都判定一遍');
});
// ── pixiv 取图回退链 ──
// 本机直连 pixiv 必然失败（DNS 污染），全靠管理员配的代理；代理出口快慢随时在变。
// 2026-09 线上事故就出在这里：AI 手里的 i.pximg 直链走的是「通用 URL 抓取」分支——
// 只有 20s 默认超时、没有回退链，代理稍慢就整条失败（AI 只好跟群友说「pixiv 没放行」）；
// 退回 pixiv.re 又撞上 522；而 bobopic 的「查看原图」通道已经整站退化成 404 占位图，
// 还差点被当成原图发进群。下面这些桩把新的顺序与保护钉住。
const PNG12 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
await testWith({ config: { socialV2: { image: { allowRemoteUrl: true } } }, globals: {
  safeFetch: async (u) => {
    if (String(u).includes('go.bobopic.com')) {
      return { statusCode: 200, url: String(u), body: '<img  id="main-img"  src="https://img01.sogoucdn.com/net/a/04/link?url=a.jpg">' };
    }
    throw new Error(`不该抓这个页面：${u}`);
  },
  safeFetchBuffer: async (u) => {
    if (String(u).includes('sogoucdn')) return { url: String(u), statusCode: 200, buffer: PNG12 };
    throw new Error(`不该抓这张图：${u}`);
  }
} }, '没配代理时 pixiv.re 直链落到 bobopic 原图通道', async (h) => {
  const r = await h.resolveImageBuffer('https://pixiv.re/91401787.png', {});
  assert.equal(r.via, 'url');
  assert.ok(r.url.includes('sogoucdn'), '用的是 bobopic 原图通道的地址');
});
await testWith({ config: { socialV2: { image: { allowRemoteUrl: true } } }, globals: {
  safeFetch: async () => { throw new Error('原图页挂了'); },
  safeFetchBuffer: async (u, max, opts) => {
    if (String(u).includes('pixiv.re')) {
      assert.equal(opts?.timeoutMs, 45000, 'pixiv.re 原图尝试要放宽超时（默认 20s 不够）');
      return { url: String(u), statusCode: 200, buffer: PNG12 };
    }
    throw new Error(`不该抓这张图：${u}`);
  }
} }, 'bobopic 通道失败后回退 pixiv.re（放宽到 45s）', async (h) => {
  const r = await h.resolveImageBuffer('https://i.pixiv.re/91401787.png', {});
  assert.ok(r.url.includes('pixiv.re'));
});
await testWith({ config: { socialV2: { image: { allowRemoteUrl: true } } }, globals: {
  safeFetch: async () => { throw new Error('原图页挂了'); },
  safeFetchBuffer: async (u) => {
    if (String(u).includes('img.pixivdaily.com')) return { url: String(u), statusCode: 200, buffer: PNG12 };
    throw new Error(`请求超时：${new URL(u).hostname}`);
  }
} }, '两个原图源都失败时退到 220px 缩略图（-220 后缀）', async (h) => {
  const r = await h.resolveImageBuffer('https://pixiv.re/91401787.png', {});
  assert.equal(r.url, 'https://img.pixivdaily.com/small/91401787.jpg-220');
});
// bobopic 404 占位图：它是合法图片，格式校验拦不住，必须显式认出来并继续回退
await testWith({ config: { socialV2: { image: { allowRemoteUrl: true } } }, globals: {
  safeFetch: async (u) => ({ statusCode: 200, url: String(u), body: '<img id="main-img" src="http://img.pixivdaily.com/404.jpg">' }),
  safeFetchBuffer: async (u) => ({ url: String(u), statusCode: 200, buffer: PNG12 })
} }, 'bobopic 404 占位图不会被当原图发出去', async (h) => {
  const r = await h.resolveImageBuffer('https://pixiv.re/91401787.png', {});
  assert.ok(!String(r.url).includes('404.jpg'), '绝不能把 404 占位图当原图发');
  assert.ok(String(r.url).includes('pixiv.re'), '继续回退到真正的原图源');
});
const pixivProxyCfg = { socialV2: { image: { allowRemoteUrl: true, pixiv: { enabled: true, proxy: 'http://127.0.0.1:7897' } } } };
await testWith({ config: pixivProxyCfg, globals: {
  pixivIllustOriginal: async (id) => ({
    id,
    original: `https://i.pximg.net/img-original/img/2026/09/22/07/00/02/${id}_p0.png`,
    large: `https://i.pximg.net/img-master/img/2026/09/22/07/00/02/${id}_p0_master1200.jpg`,
    xRestrict: 0,
    tags: []
  }),
  safeFetchBuffer: async (u, max, opts) => {
    assert.equal(opts?.proxy, 'http://127.0.0.1:7897', 'pixiv 取图必须走配置的代理');
    assert.equal(opts?.headers?.referer, 'https://www.pixiv.net/', 'i.pximg 要带 pixiv Referer');
    if (String(u).includes('img-original')) throw new Error('请求超时：i.pximg.net');
    if (String(u).includes('master1200')) return { url: String(u), statusCode: 200, buffer: PNG12 };
    throw new Error(`不该抓这张图：${u}`);
  }
} }, 'AI 给的 i.pximg 直链不再只走 20s 通用抓取：原图超时后落 master1200', async (h) => {
  const r = await h.resolveImageBuffer('https://i.pximg.net/img-original/img/2026/09/22/07/00/02/91401787_p0.png', {});
  assert.ok(r.url.includes('master1200'), '退到 pixiv 自己的 master1200');
});
await testWith({ config: pixivProxyCfg, globals: {
  pixivIllustOriginal: async () => { throw new Error('详情接口挂了'); },
  safeFetchBuffer: async (u) => ({ url: String(u), statusCode: 200, buffer: PNG12 })
} }, 'AI 给的 i.pximg 直链优先原样抓（回退链不再只认 pixiv.re）', async (h) => {
  const given = 'https://i.pximg.net/img-original/img/2026/09/22/07/00/02/91401787_p0.png';
  const r = await h.resolveImageBuffer(given, {});
  assert.equal(r.url, given);
  assert.equal(r.rendition, 'original', '原图档要如实标注');
});
// 分辨率事故（2026-09-24）：AI 把搜索结果里的 thumbUrl（250×250 方形裁切）拿来发，
// 旧逻辑「AI 给的直链优先原样抓」把它当成功发出去——用户看到的症状是「分辨率不对」。
const SQUARE_THUMB = 'https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/09/24/22/00/17/91401787_p0_square1200.jpg';
await testWith({ config: pixivProxyCfg, globals: {
  pixivIllustOriginal: async (id) => ({
    id,
    original: `https://i.pximg.net/img-original/img/2026/09/22/07/00/02/${id}_p0.png`,
    large: `https://i.pximg.net/img-master/img/2026/09/22/07/00/02/${id}_p0_master1200.jpg`,
    xRestrict: 0,
    tags: []
  }),
  safeFetchBuffer: async (u) => {
    const url = String(u);
    if (url.includes('/c/250x250')) return { url, statusCode: 200, buffer: PNG12 }; // 缩略图能拿到，但不许插队
    if (url.includes('img-original')) throw new Error('请求超时：i.pximg.net');
    if (url.includes('master1200')) return { url, statusCode: 200, buffer: PNG12 };
    throw new Error(`不该抓这张图：${url}`);
  }
} }, 'AI 给的 250×250 方形缩略图不许插队：先拿 1200px 档', async (h) => {
  const r = await h.resolveImageBuffer(SQUARE_THUMB, {});
  assert.ok(r.url.includes('master1200'), '用的是 1200px 而不是方图');
  assert.equal(r.rendition, 'large');
});
await testWith({ config: pixivProxyCfg, globals: {
  pixivIllustOriginal: async () => { throw new Error('详情接口挂了'); },
  safeFetch: async () => { throw new Error('原图页挂了'); },
  safeFetchBuffer: async (u, max, opts) => {
    const url = String(u);
    if (url.includes('/c/250x250')) {
      assert.equal(opts?.proxy, 'http://127.0.0.1:7897', 'i.pximg 的缩略图也要走代理');
      return { url, statusCode: 200, buffer: PNG12 };
    }
    throw new Error(`请求超时：${new URL(url).hostname}`);
  }
} }, '全都拿不到时才用 AI 给的缩略图，并标 rendition=thumb（好让 AI 如实说画质）', async (h) => {
  const r = await h.resolveImageBuffer(SQUARE_THUMB, {});
  assert.equal(r.rendition, 'thumb');
  assert.ok(r.url.includes('/c/250x250'));
});
await testWith({ config: pixivProxyCfg, globals: {
  pixivIllustOriginal: async () => { throw new Error('详情接口挂了'); },
  safeFetch: async () => { throw new Error('原图页挂了'); },
  safeFetchBuffer: async (u) => { throw new Error(`请求超时：${new URL(u).hostname}`); }
} }, '全链失败时说清「不是白名单问题」并列出击过哪些源', async (h) => {
  await assert.rejects(
    () => h.resolveImageBuffer('https://pixiv.re/91401787.png', {}),
    (error) => /不是白名单问题/.test(error.message)
      && /pixiv 详情/.test(error.message) && /bobopic 原图/.test(error.message)
      && /pixiv\.re 原图/.test(error.message) && /缩略图/.test(error.message)
  );
});
// ── 防重复发图：同一张图（按 pixiv 作品 id / URL 身份）在窗口内只发一次 ──
const dedupeCfg = { socialV2: { image: { allowRemoteUrl: true, pixiv: { enabled: true, proxy: 'http://127.0.0.1:7897' } } } };
const pngFetch = { safeFetchBuffer: async (u) => ({ url: String(u), statusCode: 200, buffer: PNG12 }) };

// 线上实例（2026-10-13 群 1050666134）：一条「大肥鱼的七宗罪」发了 7 张图，单次上限 5 张，
// 后两张被跳过，而 AI 没有任何翻页手段，只能在群里说「后两张我被吞了没看着」。
await testWith({ globals: pngFetch }, '一条消息图多时要能翻页：告诉 AI 还剩几张、怎么拿，编号接着上一批', async (h) => {
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    h.setMode('reserved2');
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    const media = Array.from({ length: 7 }, (_, i) => ({ kind: 'image', file: `img${i + 1}.jpg`, url: `https://public.invalid/img${i + 1}.jpg` }));
    h.appendSocialV2Message(key, '米哈游㍿', '[图片]', '[图片]', false, false, 620001, media, '1472298635', [], null, null);
    const base = `/api/images/message?token=fixture-console-token&key=${encodeURIComponent(key)}&messageId=620001`;
    const first = await apiRequest(server, base, { method: 'GET', agentToken: st.agentToken });
    assert.equal(first.status, 200);
    assert.equal(first.body.images.length, 5, '默认一次 5 张');
    assert.equal(first.body.total, 7, '要报总共有几张');
    assert.equal(first.body.hasMore, true);
    assert.match(String(first.body.note ?? ''), /imageOffset=5/, '要告诉 AI 怎么拿剩下的，别让它以为图被吞了');

    const second = await apiRequest(server, `${base}&imageOffset=5`, { method: 'GET', agentToken: st.agentToken });
    assert.equal(second.status, 200);
    assert.equal(second.body.images.length, 2, '第二页拿到剩下 2 张');
    assert.equal(second.body.hasMore, false);
    assert.deepEqual(second.body.images.map((i) => i.index), [6, 7], '编号要接着上一批（第二批是图片6/7）');

    const limited = await apiRequest(server, `${base}&imageLimit=2`, { method: 'GET', agentToken: st.agentToken });
    assert.equal(limited.body.images.length, 2, 'imageLimit 生效');
    assert.equal(limited.body.hasMore, true);
    assert.match(String(limited.body.note ?? ''), /imageOffset=2/);
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
});
await testWith({ config: dedupeCfg, globals: pngFetch }, 'imageIdentityKey：不同镜像/尺寸算同一张', async (h) => {
  assert.equal(h.imageIdentityKey('https://pixiv.re/91401787.png'), 'pixiv:91401787');
  assert.equal(h.imageIdentityKey('https://i.pximg.net/img-original/img/2021/07/21/22/53/00/91401787_p0.png'), 'pixiv:91401787');
  assert.equal(h.imageIdentityKey('https://img.pixivdaily.com/small/91401787.jpg-220'), 'pixiv:91401787');
  assert.ok(h.imageIdentityKey('https://i0.hdslb.com/bfs/new_dyn/x.jpg').startsWith('url:'), '非 pixiv 图按 URL 身份');
  assert.equal(h.imageIdentityKey('a.png', 'a.png'), 'lib:a.png', '本地图库按文件名');
});
await testWith({ config: dedupeCfg, globals: {
  // 每张 URL 给不同的字节，好验证「不同图各存一份」
  safeFetchBuffer: async (u) => ({ url: String(u), statusCode: 200, buffer: Buffer.concat([PNG12, Buffer.from(String(u))]) })
} }, '重复发同一张图被拒，换一张能发', async (h) => {
  const first = 'https://i.pximg.net/img-original/img/2021/07/21/22/53/00/91401787_p0.png';
  await h.sendImageV2('private:123', first, {});
  // 同一个作品、换成 pixiv.re 的地址（不同镜像）也必须算重复
  await assert.rejects(() => h.sendImageV2('private:123', 'https://pixiv.re/91401787.png', {}), /最近发过/);
  await h.sendImageV2('private:123', 'https://pixiv.re/99999999.png', {});
  assert.ok(h.recentSentImageKeys('private:123').has('pixiv:91401787'), '发过的图进了防重发集合');
  // 发出去的网络图要在本机留一份（state/sent-images）：不然「群里发过的那张图」本地再也找不回来
  const sentDir = path.join(h.temp, 'state', 'sent-images');
  const idx = JSON.parse(fs.readFileSync(path.join(sentDir, 'index.json'), 'utf8'));
  assert.equal(idx.items.length, 2, '两张发出去的图都落了盘');
  assert.ok(idx.items.every((it) => fs.existsSync(path.join(sentDir, it.file))), '索引里的文件都在磁盘上');
  assert.equal(idx.items[0].artworkId, '91401787', '记下了 pixiv 作品 id');
  assert.equal(idx.items[0].delivered, true, '发送后把「确实送达」回填进索引');
  assert.match(idx.items[0].origin, /private:123/, '记下是从哪个会话发出去的');
  assert.equal(idx.items.filter((it) => it.artworkId === '91401787').length, 1, '同一张不重复占盘');
});
await testWith({ config: { socialV2: { image: { allowRemoteUrl: true, repeatGuardMs: 0, pixiv: { enabled: true } } } }, globals: pngFetch }, 'repeatGuardMs=0 关闭防重发', async (h) => {
  const url = 'https://pixiv.re/91401787.png';
  await h.sendImageV2('private:123', url, {});
  await h.sendImageV2('private:123', url, {});
  assert.equal(h.recentSentImageKeys('private:123').size, 0, '窗口为 0 时集合为空');
});

await testWith({ config: { socialV2: { image: { allowRemoteUrl: true } } }, globals: {
  safeFetch: async () => { throw new Error('原图页挂了'); },
  safeFetchBuffer: async (u) => { throw new Error(`请求超时：${new URL(u).hostname}`); }
} }, '三个源都失败时报出试过哪些（不再只说一句超时）', async (h) => {
  await assert.rejects(
    () => h.resolveImageBuffer('https://pixiv.re/91401787.png', {}),
    (error) => /bobopic 原图/.test(error.message) && /pixiv\.re 原图/.test(error.message) && /缩略图/.test(error.message)
  );
});
// ── 图片送达确认：网关回 ok ≠ QQ 收下了 ──
// 线上事故（2026-09-24）：一张露骨 pixiv 图被 QQ 图片审核静默吞掉——OneBot 接口回 ok、
// 群里没有，AI 却跟群友说「两张都发出去了」。判据用 get_msg：真送达的消息 message_seq>0、
// 图片段换成 QQ CDN 的 http 地址；被吞掉的停在 message_seq=0 + base64://。
const UNDELIVERED_MSG = () => ({ message_seq: 0, message: [{ type: 'image', data: { url: 'base64:///9j/4AAQSkZJRgABAQAAAQABAAD' } }] });
await testWith({ config: { socialV2: { image: { allowRemoteUrl: true, deliverCheckMs: 60 } } }, globals: pngFetch },
  '图片送达确认：QQ 收下了就只发一次', async (h) => {
    const r = await h.sendImageV2('private:123', 'https://pixiv.re/91401787.png', {});
    assert.equal(r.delivered, true, '确认送达');
    assert.equal(h.calls.ws.filter((c) => c.action === 'send_private_msg').length, 1, '不重发');
  });
await testWith({ config: { socialV2: { image: { allowRemoteUrl: true, deliverCheckMs: 0 } } }, globals: pngFetch },
  'deliverCheckMs=0 时完全跳过送达确认', async (h) => {
    const r = await h.sendImageV2('private:123', 'https://pixiv.re/91401787.png', {});
    assert.equal(r.delivered, true);
    assert.equal(h.calls.ws.filter((c) => c.action === 'get_msg').length, 0, '不查 get_msg');
  });
await testWith({ config: { socialV2: { image: { allowRemoteUrl: true, deliverCheckMs: 60 } } }, globals: pngFetch, getMsg: UNDELIVERED_MSG },
  'QQ 静默丢图：自动重发一次，仍不行就 delivered=false（不再假成功）', async (h) => {
    const r = await h.sendImageV2('private:123', 'https://pixiv.re/91401787.png', {});
    assert.equal(r.delivered, false, '如实报未送达');
    assert.equal(h.calls.ws.filter((c) => c.action === 'send_private_msg').length, 2, '自动重发一次');
    assert.ok(h.calls.ws.filter((c) => c.action === 'get_msg').length >= 2, '两次发送都确认过（每次会按剩余时限轮询）');
  });
await testWith({ config: { socialV2: { image: { allowRemoteUrl: true, deliverCheckMs: 60 } } }, globals: pngFetch, getMsg: ((firstId) => (id) => (Number(id) === firstId ? UNDELIVERED_MSG() : { message_seq: 7, message: [{ type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/download?x=1' } }] }))(1) },
  '第一次没落地、重发落地：算成功', async (h) => {
    const r = await h.sendImageV2('private:123', 'https://pixiv.re/91401787.png', {});
    assert.equal(r.delivered, true);
    assert.equal(h.calls.ws.filter((c) => c.action === 'send_private_msg').length, 2);
  });
await testWith({ config: { socialV2: { image: { allowRemoteUrl: true, deliverCheckMs: 60 } } }, globals: pngFetch, getMsg: UNDELIVERED_MSG },
  '没送达的图不占防重复名额：群友要求补发时还能再试', async (h) => {
    const url = 'https://pixiv.re/91401787.png';
    const first = await h.sendImageV2('private:123', url, {});
    assert.equal(first.delivered, false);
    assert.equal(h.recentSentImageKeys('private:123').has('pixiv:91401787'), false, '未送达不算「发过」');
    const again = await h.sendImageV2('private:123', url, {}); // 不被防重复拒绝
    assert.equal(again.delivered, false);
    assert.equal(h.calls.ws.filter((c) => c.action === 'send_private_msg').length, 4, '两次调用各自动重发一次');
  });
await testWith({ config: { snowluma: { wsTimeoutMs: 40 }, socialV2: { image: { allowRemoteUrl: true, deliverCheckMs: 0 } } }, globals: pngFetch, hangActions: ['send_private_msg'] },
  '写类动作 WS 超时：不回退 HTTP 重发（重复发图的根因），如实报「结果不确定」', async (h) => {
    const stopKeepAlive = h.keepLoopAlive();
    const url = 'https://pixiv.re/91401787.png';
    await assert.rejects(() => h.sendImageV2('private:123', url, {}), (error) => error.uncertain === true && /不确定/.test(error.message));
    // 关键断言：只发出了一次 WS 请求，没有 HTTP 兜底（HTTP 会打到同一个 action 上）。
    assert.equal(h.calls.ws.filter((c) => c.action === 'send_private_msg').length, 1, '没有第二次发送');
    // 结果不确定的图必须被挡住，防止 AI 换个档位再试一张 → 群里两张。
    const identity = h.imageIdentityKey(url);
    assert.ok(h.imageSendUncertainAt('private:123', identity) > 0, '记下「结果不确定」状态');
    await assert.rejects(() => h.sendImageV2('private:123', url, {}), /不能自动重发|不确定/);
    stopKeepAlive();
  });

// 文字消息的「回执超时」以前只能报「不确定」，模型看到工具报错就重发 → 群里两条一样的消息
// （线上 2026-10-09 13:15 群 1050666134 真实发生）。现在超时后去历史里查证：
// 查到就算已送达（报成功，模型不会重发）；查不到才如实报失败（这时重发才对）。
await testWith(
  {
    config: { snowluma: { wsTimeoutMs: 1000 } },
    globals: { scrubFormulaicSpeech, describeScrub },
    hangActions: ['send_group_msg'],
    history: {
      group: {
        456: [{
          message_id: 9001, message_seq: 77,
          sender: { user_id: 2840404638 }, // harness 的 get_login_info 里机器人就是这个号
          message: [{ type: 'text', data: { text: '在的' } }],
        }],
      },
    },
  },
  '文字回执超时但历史里查到了：按已送达处理，绝不重发',
  async (h) => {
    const stopKeepAlive = h.keepLoopAlive();
    const server = h.startConsoleServer();
    try {
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      h.setMode('reserved2');
      const key = 'group:456';
      const st = h.getSocialV2State(key);
      const res = await apiRequest(server, '/api/socialV2/send-message?token=fixture-console-token', {
        body: { key, messages: '在的' }, agentToken: st.agentToken,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.ok, true, '查证已送达就必须报成功，否则模型会重发出一条重复消息');
      assert.equal(res.body.sent, 1);
      assert.equal(h.calls.ws.filter((c) => c.action === 'send_group_msg').length, 1, '只发一次，没有重发');
    } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); stopKeepAlive(); }
  }
);

await testWith(
  { config: { snowluma: { wsTimeoutMs: 1000 } }, globals: { scrubFormulaicSpeech, describeScrub }, hangActions: ['send_group_msg'], history: {} },
  '文字回执超时且历史里查不到：报普通失败（重发安全），不标 uncertain',
  async (h) => {
    const stopKeepAlive = h.keepLoopAlive();
    const server = h.startConsoleServer();
    try {
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      h.setMode('reserved2');
      const key = 'group:456';
      const st = h.getSocialV2State(key);
      const res = await apiRequest(server, '/api/socialV2/send-message?token=fixture-console-token', {
        body: { key, messages: '这条没发出去' }, agentToken: st.agentToken,
      });
      assert.equal(res.status, 500);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.uncertain, undefined, '历史已确认没有 → 不该标不确定，否则模型不敢重发');
      assert.match(String(res.body.error ?? ''), /确认历史里没有|可以安全重发/, '要告诉上层重发是安全的');
      assert.equal(h.calls.ws.filter((c) => c.action === 'send_group_msg').length, 1, '仍然只发一次');
    } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); stopKeepAlive(); }
  }
);

// 2026-10-10 线上事故：WS 把消息送出去了（群里已可见），但连接中途断开、回执没回来。
// 当时这种「非超时」失败会被当成硬失败，而且还会回退 HTTP 再发一次 → 模型也重发 → 两条重复。
await testWith(
  {
    config: { snowluma: { wsTimeoutMs: 1000 } },
    globals: { scrubFormulaicSpeech, describeScrub },
    failActions: { send_group_msg: 'SnowLuma WebSocket closed' },
    history: {
      group: {
        456: [{
          message_id: 9100, message_seq: 91,
          sender: { user_id: 2840404638 },
          message: [{ type: 'text', data: { text: '消息已经发出去了' } }],
        }],
      },
    },
  },
  'WS 连接中途断开但历史里查到了：按已送达处理，不回退 HTTP 重发',
  async (h) => {
    const stopKeepAlive = h.keepLoopAlive();
    const server = h.startConsoleServer();
    try {
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      h.setMode('reserved2');
      const key = 'group:456';
      const st = h.getSocialV2State(key);
      const res = await apiRequest(server, '/api/socialV2/send-message?token=fixture-console-token', {
        body: { key, messages: '消息已经发出去了' }, agentToken: st.agentToken,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.ok, true, '历史里查到就必须报成功，否则模型会重发');
      assert.equal(h.calls.ws.filter((c) => c.action === 'send_group_msg').length, 1, '只尝试一次');
      assert.doesNotMatch(String(res.body.error ?? ''), /fetch is not defined/, '不能回退 HTTP（那会立刻发第二条）');
    } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); stopKeepAlive(); }
  }
);

await testWith(
  {
    config: { snowluma: { wsTimeoutMs: 1000 } },
    globals: { scrubFormulaicSpeech, describeScrub },
    failActions: { send_group_msg: 'SnowLuma WebSocket closed' },
    history: {},
  },
  'WS 连接中途断开且历史里没有：同样报普通失败（重发安全）',
  async (h) => {
    const stopKeepAlive = h.keepLoopAlive();
    const server = h.startConsoleServer();
    try {
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      h.setMode('reserved2');
      const key = 'group:456';
      const st = h.getSocialV2State(key);
      const res = await apiRequest(server, '/api/socialV2/send-message?token=fixture-console-token', {
        body: { key, messages: '确实没发出去' }, agentToken: st.agentToken,
      });
      assert.equal(res.status, 500);
      assert.equal(res.body.uncertain, undefined, '历史已确认没有 → 不该标不确定');
      assert.match(String(res.body.error ?? ''), /确认历史里没有|可以安全重发/);
    } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); stopKeepAlive(); }
  }
);
await testWith({ config: { socialV2: { image: { allowRemoteUrl: true, deliverCheckMs: 0 } } }, globals: pngFetch, hangActions: ['send_group_msg'] },
  '读类动作不受影响：写类超时策略不会误伤普通读', async (h) => {
    assert.ok(h.isOneBotWriteAction('send_group_msg') && h.isOneBotWriteAction('set_group_card'));
    assert.equal(h.isOneBotWriteAction('get_msg'), false, 'get_msg 是读类');
    assert.equal(h.isOneBotWriteAction('get_group_member_info'), false);
    assert.ok(h.isTimeoutError(new Error('WS send_private_msg 超时（15000ms）')));
    assert.equal(h.isTimeoutError(new Error('fetch failed')), false, '连接错误不算超时');
  });
await test('写类动作的 WS 等待上限随 payload 放大（大图不再被固定 15s 误判）', async (h) => {
  const small = h.oneBotWriteTimeoutMs(15000, { message: [{ type: 'text', data: { text: 'hi' } }] });
  const big = h.oneBotWriteTimeoutMs(15000, { message: [{ type: 'image', data: { file: 'base64://' + 'A'.repeat(8 * 1024 * 1024) } }] });
  assert.equal(small, 15000, '小 payload（普通文字）沿用基础时限，不被放大');
  assert.ok(big >= 30000, `8MB payload 要放宽到 30s 以上（实际 ${big}）`);
  assert.ok(big <= 180000, '有上限，不会无限等');
});
await testWith({ config: { socialV2: { image: { allowRemoteUrl: true, deliverCheckMs: 80, deliverCheckFastMs: 20 } } }, globals: pngFetch, failGetMsg: true },
  '送达探针打不通时绝不重发，且回合不等待（delivered=null 而不是 false）', async (h) => {
    const r = await h.sendImageV2('private:123', 'https://pixiv.re/91401787.png', {});
    assert.equal(r.delivered, null, '三态：未知，不是「确定没送达」');
    assert.equal(h.calls.ws.filter((c) => c.action === 'send_private_msg').length, 1, '探针没打通就不重发');
    await h.awaitDeliverChecks();
    assert.equal(h.calls.ws.filter((c) => c.action === 'send_private_msg').length, 1, '后台确认也不会重发');
  });
await testWith({ config: { socialV2: { image: { allowRemoteUrl: true, deliverCheckMs: 80, deliverCheckFastMs: 20 } } }, globals: pngFetch, getMsg: UNDELIVERED_MSG },
  '探针确实查到「没送达」时才重发（可判定 vs 不可判定要分开）', async (h) => {
    const r = await h.sendImageV2('private:123', 'https://pixiv.re/91401787.png', {});
    assert.equal(r.delivered, false);
    assert.equal(h.calls.ws.filter((c) => c.action === 'send_private_msg').length, 2, '可判定没送达 → 重发一次');
  });
await testWith({ config: { socialV2: { image: { allowRemoteUrl: true, deliverCheckMs: 60, deliverCheckFastMs: 20 } } }, globals: {
  safeFetchBuffer: async (u) => ({ url: String(u), statusCode: 200, buffer: Buffer.concat([PNG12, Buffer.from(String(u))]) })
} }, '发送链按会话隔离：一个会话的发送不会堵住另一个会话', async (h) => {
  // A 会话先排一条发送；B 会话的发送必须能独立完成，不用等 A。
  const a = h.sendToQQ('group:456', 'A 的消息');
  const b = h.sendToQQ('private:123', 'B 的消息');
  await Promise.all([h.awaitSendChain('group:456'), h.awaitSendChain('private:123'), a, b]);
  const sentTexts = h.calls.sent.map((s) => s.text);
  assert.ok(sentTexts.includes('A 的消息') && sentTexts.includes('B 的消息'), '两个会话都发出去了');
});
// ── 工作车道：一个会话可以同时跑「聊天」和「长任务」两条 turn ──────────────
// 背景：一个 QQ 会话只对应一个 DSH session，而 DSH 一次只跑一个 turn。
// 慢工具（pixiv 取图链上限 110s）会把整条会话堵住，群里再问什么都得等。
// 工作车道把长任务放进独立会话，聊天会话立刻恢复可应答。
const workCfg = { socialV2: { agentPreset: 'qq-chat-v2', work: { enabled: true, maxSessions: 2 } } };
await testWith({ config: workCfg }, '工作车道：长任务投给独立会话并立即返回，聊天会话不被占用', async (h) => {
  h.setMode('reserved2');
  const chatSession = await h.ensureSession('group:456');
  const result = await h.deliverWorkTask('group:456', '用 pixiv 搜一张初音未来的图并发到本群', { note: '只要 1 张' });
  assert.notEqual(result.sessionId, chatSession, '工作车道是另一个 DSH session');
  assert.equal(result.queued, false, '有空闲车道时不排队');
  assert.ok(h.workSessions.has(result.sessionId), '车道登记在 workSessions');
  assert.equal(h.workReverse.get(result.sessionId), 'group:456', '车道归属会话可反查');
  // 关键：任务文本里必须带 key + 令牌 + 收尾契约，否则独立会话调不动任何 QQ 工具。
  const prompt = h.calls.prompts.at(-1).content[0].text;
  assert.match(prompt, /【工作车道】/);
  assert.match(prompt, /【会话 key】group:456/);
  assert.match(prompt, /【会话令牌】\w+/);
  assert.match(prompt, /不会把你的文本自动转发到 QQ/, '讲清「要发东西得自己调发送工具」');
  assert.match(prompt, /不要调用 qq_set_wake_config/, '工作车道不该做聊天会话的收尾动作');
  assert.equal(h.calls.prompts.at(-1).mode, 'queue');
});
await testWith({ config: workCfg }, '工作车道跑完把结论回投给聊天会话（而不是直接对 QQ 发言）', async (h) => {
  h.setMode('reserved2');
  await h.ensureSession('group:456');
  const { sessionId } = await h.deliverWorkTask('group:456', '找一张图发出去');
  // 模拟 DSH 侧这条车道的回合：turn/start → assistant/message → turn/end
  h.handleWorkLaneFrame({ sessionId, event: { type: 'turn/start', data: { turn: 't1' } } });
  h.handleWorkLaneFrame({ sessionId, event: { type: 'assistant/message', data: { turn: 't1', message: { content: [{ type: 'text', text: '已发出 pixiv 150071668（原图）' }] } } } });
  const before = h.calls.prompts.length;
  h.handleWorkLaneFrame({ sessionId, event: { type: 'turn/end', data: { turn: 't1', reason: { kind: 'completed' } } } });
  await h.awaitPromptQueue('group:456');
  const report = h.calls.prompts.slice(before).map((p) => p.content[0].text).join('\n');
  assert.match(report, /【工作车道回报】/, '结论以内部汇报的形式回投');
  assert.match(report, /已发出 pixiv 150071668/, '带上工作车道的结论原文');
  assert.match(report, /内部汇报，不是群友说的话/, '说清这不是群友消息，避免 AI 误当追问');
  assert.equal(h.workTasks.get(sessionId), undefined, '任务从队列里出清，车道恢复空闲');
});
await testWith({ config: workCfg }, '工作车道异常结束时如实说「没拿到结论」，不许假装完成', async (h) => {
  h.setMode('reserved2');
  await h.ensureSession('group:456');
  const { sessionId } = await h.deliverWorkTask('group:456', '看几个视频总结一下');
  h.handleWorkLaneFrame({ sessionId, event: { type: 'turn/start', data: { turn: 't1' } } });
  const before = h.calls.prompts.length;
  h.handleWorkLaneFrame({ sessionId, event: { type: 'turn/end', data: { turn: 't1', reason: { kind: 'error' } } } });
  await h.awaitPromptQueue('group:456');
  const report = h.calls.prompts.slice(before).map((p) => p.content[0].text).join('\n');
  assert.match(report, /没能拿到结论/);
  assert.match(report, /别把这次的失败说成已经完成/);
});
await testWith({ config: workCfg }, '车道数量受 maxSessions 限制，占满时排队而不是无限开会话', async (h) => {
  h.setMode('reserved2');
  await h.ensureSession('group:456');
  const a = await h.deliverWorkTask('group:456', '任务 A');
  const b = await h.deliverWorkTask('group:456', '任务 B');
  assert.notEqual(a.sessionId, b.sessionId, '两条任务各自占一条车道');
  const c = await h.deliverWorkTask('group:456', '任务 C');
  assert.equal(c.queued, true, '到上限后排队');
  assert.ok(c.position >= 2, `排队位次要如实返回（实际 ${c.position}）`);
  assert.equal(h.workSessions.size, 2, '工作车道的 DSH 会话数不超过 maxSessions');
  assert.equal(h.calls.created.length, 1 + 2, '聊天会话 1 个 + 工作车道 2 个，没有多余创建');
});
await testWith({ config: { socialV2: { agentPreset: 'qq-chat-v2', work: { enabled: false } } } }, 'work.enabled=false 时工作车道完全不生效', async (h) => {
  h.setMode('reserved2');
  await h.ensureSession('group:456');
  assert.equal(h.workLaneEnabled(), false);
  await assert.rejects(() => h.deliverWorkTask('group:456', '任务'), /未启用/);
});
await testWith({ config: workCfg }, '聊天会话退役时工作车道一起退役（避免旧权限的车道继续跑）', async (h) => {
  h.setMode('reserved2');
  await h.ensureSession('group:456');
  const { sessionId } = await h.deliverWorkTask('group:456', '任务 A');
  h.retireWorkLanes('group:456');
  await h.flushAsync();
  assert.equal(h.workSessions.has(sessionId), false, '车道会话已注销');
  assert.equal(h.workReverse.has(sessionId), false);
  assert.ok(h.calls.archived.includes(sessionId), '车道会话被归档，不在 DSH 里泄漏');
  assert.deepEqual(h.state.workSessions['group:456'], undefined, '持久化池里也清掉了');
});

// ── 唤醒不能丢：回合进行中收到新消息必须暂存、回合结束补投 ──────────────────
// 线上事故：dshSessionIdleNow 里声明写成 `sessionIdleCache`、用的却是 `sessionIdCache`，
// 于是这个「DSH 是否空闲」的探针一调用就抛 ReferenceError。它在 sendWakePromptV2 的
// busy 分支里被 await，异常把整个函数打断在 push **之前** —— 结果「回合进行中收到新消息」
// 这条最常见的路径既不暂存也不补投，唤醒被静默丢掉，表现就是 AI 不回话、看起来卡死。
await test('DSH 空闲探针不会抛异常（探针炸了也不能把唤醒弄丢）', async (h) => {
  h.setMode('reserved2');
  const sid = await h.ensureSession('private:123');
  // 探针本身不能抛；认不出来就返回 false（= 不清理忙标记），而不是把调用方打断。
  const idle = await h.dshSessionIdleNow(sid);
  assert.equal(typeof idle, 'boolean', '探针返回布尔值而不是抛异常');
  assert.equal(await h.dshSessionIdleNow(''), false, '空 sessionId 直接 false');
});
await test('回合进行中收到唤醒：暂存进 pendingWakeReasons（而不是丢掉）', async (h) => {
  h.setMode('reserved2');
  const sid = await h.ensureSession('private:123');
  // 造一个「turn 正在跑」的现场：只有 collector/turn 标记，且 turn 起点很新。
  h.v2TurnStartAt.set(sid, Date.now());
  h.socialV2.conversations.set('private:123', {
    ...(h.socialV2.conversations.get('private:123') ?? {}),
    lastUnreadSeq: 7,
    unread: [{ seq: 7, text: '在吗' }]
  });
  await h.sendWakePromptV2('private:123', 'private');
  const st = h.getSocialV2State('private:123');
  assert.ok(Array.isArray(st.pendingWakeReasons) && st.pendingWakeReasons.length === 1, '唤醒被暂存（这一条以前会因为探针抛错而丢失）');
  assert.equal(st.pendingWakeReasons[0].seq, 7, '记下触发它的消息 seq，供回合结束判断是否还需要补投');
  assert.equal(st.pendingWakeReasons[0].reason, 'private');
  // 没有真的投递 prompt：回合在跑，不该并行塞第二个 turn。
  assert.equal(h.calls.prompts.length, 0, '繁忙期间不投递新 prompt');
});
await test('同样情况下若探针异常，也要退化成「暂存」而不是丢掉唤醒', async (h) => {
  h.setMode('reserved2');
  const sid = await h.ensureSession('private:123');
  h.v2TurnStartAt.set(sid, Date.now());
  h.socialV2.conversations.set('private:123', {
    ...(h.socialV2.conversations.get('private:123') ?? {}),
    lastUnreadSeq: 3, unread: [{ seq: 3, text: 'hi' }]
  });
  // 模拟探针内部炸掉（RPC 挂了 / 变量名又写错）：唤醒仍必须进暂存队列。
  const api = h.api;
  const originalList = api.sessions.list;
  api.sessions.list = async () => { throw new Error('session.list 探针挂了'); };
  try {
    await h.sendWakePromptV2('private:123', 'question');
  } finally { api.sessions.list = originalList; }
  const st = h.getSocialV2State('private:123');
  assert.equal(st.pendingWakeReasons?.length, 1, '探针失败不能吞掉唤醒');
});
await test('scheduleWakeV2 繁忙路径同样暂存（正常回合进行中）', async (h) => {
  h.setMode('reserved2');
  const sid = await h.ensureSession('private:123');
  h.v2TurnStartAt.set(sid, Date.now());
  h.scheduleWakeV2('private:123', 'question');
  const st = h.getSocialV2State('private:123');
  assert.equal(st.pendingWakeReasons?.length, 1, 'scheduleWakeV2 繁忙时进暂存队列');
  assert.equal(st.pendingWakeReason, undefined, '没有安排新的合并窗口唤醒');
});
await test('暂存的唤醒原因必须落盘（桥接中途重启不能把意图弄丢）', async (h) => {
  h.setMode('reserved2');
  const sid = await h.ensureSession('private:123');
  h.v2TurnStartAt.set(sid, Date.now());
  h.scheduleWakeV2('private:123', 'private');
  // 落盘 = state/social-v2.json 里能读到这条；不落盘就只活在内存里，重启即失联。
  const raw = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
  const persisted = (raw.conversations ?? raw)['private:123'];
  assert.equal(persisted?.pendingWakeReasons?.length, 1, '暂存队列写进了 social-v2.json');
  assert.equal(persisted.pendingWakeReasons[0].reason, 'private');
});

// ── 机器人自己的资料（昵称/签名/头像）：账号级身份，重点验「谁能改」 ────────
// 改的是全群全私聊可见的身份。默认关；打开后也只认管理员上下文——
// 否则群友一句「把你名字改成广告」就能间接操控账号。
const PNG_B64 = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const profileOn = { socialV2: { profile: { enabled: true, minIntervalMs: 0, maxPerDay: 10 }, tools: { setProfile: true } } };
const profileGlobals = { safeFetchBuffer: async () => ({ url: 'https://q1.qlogo.cn/x', statusCode: 200, buffer: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') }) };

await testWith({ config: { socialV2: { profile: { enabled: true } } } }, '资料：默认关（必须显式打开），且 tools.setProfile 也要开', async (h) => {
  assert.equal(h.profileCfg().enabled, false, 'socialV2.profile.enabled 缺省即关');
  await assert.rejects(() => h.applyProfileChange({ nickname: 'x' }), /未启用/);
});
await testWith({ config: { socialV2: { profile: { enabled: false }, tools: { setProfile: true } } } }, '资料：profile.enabled=false 时即使工具开着也不能改', async (h) => {
  assert.equal(h.profileCfg().enabled, false);
  await assert.rejects(() => h.applyProfileChange({ nickname: 'x' }), /未启用/);
});

await testWith({ config: profileOn }, '资料：管理员上下文判定——管理员私聊永远算，群里要求最近一条是管理员发的', async (h) => {
  h.setMode('reserved2');
  const owner = '123';
  assert.equal(h.isAdminProfileContext(`private:${owner}`), true, '管理员私聊：算');
  assert.equal(h.isAdminProfileContext('group:456'), false, '群里还没人说话：不算');
  // 记录函数本身要能写进状态
  h.noteProfileTriggers('group:456', true);
  assert.ok(h.getSocialV2State('group:456').lastOwnerAt > 0, 'noteProfileTriggers 记下管理员发言时间');
  h.noteProfileTriggers('group:456', false);
  assert.ok(h.getSocialV2State('group:456').lastOtherAt > 0, '也记下群友发言时间');
  // 顺序判定用显式时间戳，避免两次调用落在同一毫秒导致断言不稳
  // 顺序判定用显式时间戳（相对现在），避免两次调用落在同一毫秒导致断言不稳；
  // 注意必须落在 adminWindowMs（默认 10 分钟）之内，否则会被窗口判定挡掉。
  const st = h.getSocialV2State('group:456');
  const now = Date.now();
  st.lastOtherAt = now - 2000; st.lastOwnerAt = now - 1000;
  assert.equal(h.isAdminProfileContext('group:456'), true, '管理员最后发言：算');
  st.lastOtherAt = now - 500;
  assert.equal(h.isAdminProfileContext('group:456'), false, '群友最后发言：不算（不能借道）');
  st.lastOwnerAt = now - 100; st.lastOtherAt = now - 500;
  assert.equal(h.isAdminProfileContext('group:456'), true, '管理员又最后发言：重新算');
  st.lastOwnerAt = now - 100; st.lastOtherAt = now - 100;
  assert.equal(h.isAdminProfileContext('group:456'), false, '打平时保守判「不算」（安全闸门不吃模糊）');
  st.lastOwnerAt = now - 60 * 60 * 1000; st.lastOtherAt = 0;
  assert.equal(h.isAdminProfileContext('group:456'), false, '管理员发言超过窗口：不算');
});

await testWith({ config: profileOn, globals: profileGlobals }, '资料：改昵称/签名成功，写历史、留旧值可回滚', async (h) => {
  h.setMode('reserved2');
  h.noteProfileTriggers('private:123', true);
  const r = await h.applyProfileChange({ nickname: '小鲸鱼', personalNote: '在摸鱼' }, { by: 'ai:private:123' });
  assert.equal(r.current.nickname, '小鲸鱼');
  assert.equal(r.current.personalNote, '在摸鱼');
  const call = h.calls.ws.filter((c) => c.action === 'set_qq_profile').at(-1);
  assert.equal(call.params.nickname, '小鲸鱼');
  assert.equal(call.params.personal_note, '在摸鱼');
  assert.equal(h.selfProfile.history.at(-1).field, 'personalNote');
  assert.equal(h.selfProfile.history.at(-1).by, 'ai:private:123', '记下是谁改的');
  // 回滚昵称：第一次改之前桥接会先从 get_login_info 抓下当前昵称当基线，
  // 所以「第一次改动」也是可以回滚的（以前会因为没有旧值而回滚不了）。
  const back = await h.revertProfile({ field: 'nickname' });
  assert.match(back.changed[0], /已回滚/);
  assert.equal(h.selfProfile.current.nickname, '哦鲸鲸', '回滚到改动前的真实昵称（来自网关基线）');
  assert.equal(h.calls.ws.filter((c) => c.action === 'set_qq_profile').at(-1).params.nickname, '哦鲸鲸', '回滚也真的发了请求');
});

await testWith({ config: profileOn, globals: profileGlobals }, '资料：昵称/签名内容校验（链接、冒充官方、超长、控制字符）', async (h) => {
  h.setMode('reserved2');
  await assert.rejects(() => h.applyProfileChange({ nickname: '看 https://a.com' }), /不允许放链接/);
  await assert.rejects(() => h.applyProfileChange({ nickname: '加群 12345678 领福利' }), /不允许放链接/);
  await assert.rejects(() => h.applyProfileChange({ nickname: '系统' }), /冒充官方/);
  await assert.rejects(() => h.applyProfileChange({ nickname: '啊'.repeat(30) }), /太长/);
  await assert.rejects(() => h.applyProfileChange({ personalNote: 'x'.repeat(80) }), /太长/);
  // 控制字符会被压掉而不是原样写进去
  const r = await h.applyProfileChange({ nickname: '小\n\n鲸鱼\u0000' });
  assert.equal(r.current.nickname, '小 鲸鱼', '换行/控制字符被压成空格');
  // 没变就不发请求
  const before = h.calls.ws.filter((c) => c.action === 'set_qq_profile').length;
  await assert.rejects(() => h.applyProfileChange({ nickname: '小 鲸鱼' }), /没有要改的内容/);
  assert.equal(h.calls.ws.filter((c) => c.action === 'set_qq_profile').length, before, '值没变不发多余请求');
});

await testWith({ config: { socialV2: { profile: { enabled: true, minIntervalMs: 60000, maxPerDay: 10 }, tools: { setProfile: true } } }, globals: profileGlobals },
  '资料：限流（间隔 + 每日上限）', async (h) => {
    h.setMode('reserved2');
    await h.applyProfileChange({ nickname: 'A' });
    await assert.rejects(() => h.applyProfileChange({ nickname: 'B' }), /太频繁/, '间隔没到不能改');
  });
await testWith({ config: { socialV2: { profile: { enabled: true, minIntervalMs: 0, maxPerDay: 1 }, tools: { setProfile: true } } }, globals: profileGlobals },
  '资料：每日上限（账号级身份故意收紧）', async (h) => {
    h.setMode('reserved2');
    await h.applyProfileChange({ nickname: 'A' });
    await assert.rejects(() => h.applyProfileChange({ nickname: 'B' }), /次数用完/);
  });

await testWith({ config: profileOn, globals: profileGlobals }, '资料：换头像走 base64、备份旧头像、可回滚', async (h) => {
  h.setMode('reserved2');
  h.noteProfileTriggers('private:123', true);
  const r = await h.applyProfileChange({ avatar: PNG_B64 }, { by: 'ai:private:123' });
  assert.match(r.changed.join(), /头像已更新/);
  const call = h.calls.ws.filter((c) => c.action === 'set_qq_avatar').at(-1);
  assert.ok(call, '调了 set_qq_avatar');
  assert.match(call.params.file, /^base64:\/\//, '传的是 base64，不是 URL（不让网关去抓）');
  assert.ok(r.avatar.sha256, '记下新头像指纹');
  assert.ok(h.selfProfile.avatar.file, '新头像在本机留了一份');
  assert.ok(h.selfProfile.avatar.previousFile, '旧头像也备份了（回滚要用）');
  const back = await h.revertProfile({ field: 'avatar' });
  assert.match(back.changed.join(), /头像已回滚/);
  assert.ok(h.calls.ws.filter((c) => c.action === 'set_qq_avatar').length >= 2, '回滚真的又发了一次');
});

await testWith({ config: profileOn, globals: profileGlobals }, '资料：端点层面——AI 从「非管理员上下文」调用被 403', async (h) => {
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const token = h.getSocialV2State('group:456').agentToken;
    const post = (key, tk) => new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/socialV2/self-profile?token=fixture-console-token', method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-token': tk } }, (response) => {
        let raw = '';
        response.on('data', (c) => { raw += c; });
        response.on('end', () => { let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: response.statusCode, body: parsed }); });
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('hung')));
      request.end(JSON.stringify({ key, nickname: '广告位招租' }));
    });
    // 群友刚发过话 → 不是管理员上下文
    h.noteProfileTriggers('group:456', false);
    const denied = await post('group:456', token);
    assert.equal(denied.status, 403, '群聊里非管理员上下文被拒');
    assert.match(denied.body.error, /管理员上下文/, '给出可执行的原因');
    // 管理员发言后 → 放行（内容是广告，所以会被内容校验拦下，但已经不是 403 了）
    h.noteProfileTriggers('group:456', true);
    const allowed = await post('group:456', token);
    assert.notEqual(allowed.status, 403, '管理员上下文不再被 403');
    assert.match(allowed.body.error ?? '', /不允许放链接/, '仍然过内容校验');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

// ── 玩梗要接梗，不许科普 ─────────────────────────────────────────────────
// 需求：明显在玩梗的消息，AI 要玩回去，不要给正经回复。
// 风险点很具体：黑话表/知识库刚喂进去一堆梗（探索学来的），模型很容易把「我认识它」
// 变成「我来讲解它」——那样群里抛梗就换来一段释义，比没接住还破坏气氛。
await testWith({ config: { socialV2: { taskTriage: true } } }, '每轮注入「玩梗/闲聊/正经事」三级分流，玩梗明确要求接梗、禁止科普', async (h) => {
  h.setMode('reserved2');
  const prompt = await h.withSlangContext('随便一句话', 'private:123');
  assert.match(prompt, /先分清是玩梗、闲聊还是正经事/, '分流段还在');
  assert.match(prompt, /接梗玩回去/, '玩梗的正确动作');
  assert.match(prompt, /绝对不要做的事：解释这个梗是什么/, '明确禁止解释梗');
  assert.match(prompt, /你这是玩梗吧/, '禁止拆穿对方在玩梗');
  assert.match(prompt, /认识\*\*这个梗 ≠ 你要解释它/, '点破「认识≠要讲」这个最容易犯的错');
  assert.match(prompt, /群里抛梗时，接得上远比讲得对重要/, '给出取舍原则');
  assert.match(prompt, /只有对方\*\*明确在问\*\*「这啥梗/, '留下真提问才解释的出口');
  assert.ok(!/闲聊\/接梗\/斗嘴：1~3 条/.test(prompt), '旧的二分流文案已被替换');
});
await test('注入的黑话表说明「会用不是会讲」', async (h) => {
  const table = h.buildSlangContext([
    { content: '卖狗', meaning: 'MyGO 的谐音叫法', usage: '', example: '', status: 'confirmed', count: 1 }
  ], 8);
  assert.match(table, /【群聊黑话表】/);
  assert.match(table, /是给你「会用」的，不是给你「会讲」的/, '点明用途是使用而不是讲解');
  assert.match(table, /不要把这些释义讲出来/, '抛梗时不要念释义');
});
await test('注入的知识库说明「知道答案不等于要说出来」', async (h) => {
  const table = h.formatKnowledgeTable([
    { question: 'MyGO!!!!! 是什么', answer: '一个乐队企划', kind: 'fact', status: 'confirmed', tags: [], sources: [], hitCount: 0, askers: [] }
  ]);
  assert.match(table, /【群知识库】/);
  assert.match(table, /如果对方是在\*\*玩梗\/抛梗\*\*/, '区分「在问」与「在玩梗」');
  assert.match(table, /知道答案不等于要说出来/, '把结论讲死');
});
await test('人设卡里也有这条规则（qq_get_prompt 读到的版本）', async (h) => {
  const card = fs.readFileSync(path.join(ROOT, 'roles', '小鲸鱼.md'), 'utf8');
  assert.match(card, /别人在玩梗时，你就玩回去/, '人设卡里写了');
  assert.match(card, /不要解释这个梗是什么/, '人设卡里也禁止科普');
  assert.match(card, /是让你\*\*会用\*\*的，不是让你当百科/, '人设卡里点破用途');
});

// ── 主题探索（自主扩展学习）─────────────────────────────────────────────
// 管理员给一个种子关键词，AI 自己把这一圈的梗和关联主题学回来：
//   mygo → 弄清它是什么 + 里面的梗 → 关联的 Ave Mujica / 夢限大みゅーたいぷ 继续挖
//   → 梗进黑话库（自动确认）、主题综述进知识库。
const exploreCfgBase = { slang: { enabled: true, explore: { enabled: true, maxDepth: 2, maxTopics: 6 } } };
/** 研究会话的一轮回答（把主题名回填进结果，模拟研究员）。 */
function topicAnswer({ name, kind, summary, terms = [], related = [] }) {
  return JSON.stringify({ topic: { name, kind, summary }, terms, related });
}

await testWith({ config: exploreCfgBase }, '主题探索：端到端把种子与两层关联学进黑话库 + 知识库', async (h) => {
  h.setMode('reserved2');
  const job = h.startTopicExploration('mygo', { by: 'console' });
  assert.equal(job.status, 'pending');
  assert.equal(job.maxDepth, 2);
  // 第 1 轮：种子本身
  assert.ok(await h.answerLearnerTurn((prompt) => {
    assert.match(prompt, /【本次要摸的主题】mygo/, '第一轮研究的是种子');
    assert.match(prompt, /只输出一个 JSON 对象/, '输出契约在提示词里');
    return topicAnswer({
      name: 'MyGO!!!!!', kind: '乐队企划', summary: 'BanG Dream! 旗下的乐队企划，以「迷子」为主题。',
      terms: [{ content: '为什么要演奏春日影', meaning: '名场面的吐槽说法', usage: '调侃剧情', sources: ['https://zh.moegirl.org.cn/MyGO'], confirmed: true }],
      related: [{ name: 'Ave Mujica', why: '同企划姊妹乐队', priority: 1 }]
    });
  }), '等到第一轮研究会话');
  // 第 2 轮：关联主题自动排进队列
  assert.ok(await h.answerLearnerTurn((prompt) => {
    assert.match(prompt, /【本次要摸的主题】Ave Mujica/, '关联主题成为下一轮');
    assert.match(prompt, /它是怎么被关联进来的】同企划姊妹乐队/, '带上关联理由');
    assert.match(prompt, /第 1 层关联/, '标注层级');
    return topicAnswer({
      name: 'Ave Mujica', kind: '乐队', summary: '假面乐队，与 MyGO!!!!! 互为表里。',
      terms: [{ content: '摘面具', meaning: '动画里的名场面', sources: ['https://example.com/avemujica'], confirmed: true }],
      related: [{ name: '夢限大みゅーたいぷ', why: '同企划另一支乐队', priority: 1 }]
    });
  }), '等到第二轮研究会话');
  // 第 3 轮：第二层
  assert.ok(await h.answerLearnerTurn((prompt) => {
    assert.match(prompt, /【本次要摸的主题】夢限大みゅーたいぷ/);
    return topicAnswer({
      name: '夢限大みゅーたいぷ', kind: '乐队', summary: '企划下的虚拟乐队。',
      terms: [{ content: '梦限大', meaning: '夢限大みゅーたいぷ 的中文简称', sources: ['https://example.com/mugen'], confirmed: true }],
      related: []
    });
  }), '等到第三轮研究会话');
  await h.awaitExploreChain();

  assert.equal(job.status, 'done', `任务应收尾（实际 ${job.status} / ${job.error}）`);
  assert.equal(job.stats.topics, 3, '种子 + 两层关联各 1 个');
  assert.equal(job.stats.terms, 3);
  assert.equal(job.stats.confirmed, 3);
  assert.equal(job.stats.failed, 0);
  // 梗进黑话库且已自动确认（管理员发起＝已授权，学完就能用）
  const terms = h.getSlangEntries().map((e) => e.content);
  for (const t of ['为什么要演奏春日影', '摘面具', '梦限大']) {
    assert.ok(terms.includes(t), `黑话库里有「${t}」`);
    assert.equal(h.getSlangEntries().find((e) => e.content === t).status, 'confirmed', `「${t}」已确认`);
  }
  // 主题综述进知识库，以后问「XX 是什么」能直接命中
  const kbRaw = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'knowledge.json'), 'utf8'));
  const kb = Array.isArray(kbRaw) ? kbRaw : (kbRaw.items ?? kbRaw.entries ?? []);
  const q = kb.find((e) => e && e.question === 'MyGO!!!!! 是什么');
  assert.ok(q, '知识库里有主题综述');
  assert.match(q.answer, /BanG Dream!/);
  assert.equal(q.source, 'explore', '标出是探索学来的');
});

await testWith({ config: { slang: { enabled: true, explore: { enabled: true, maxDepth: 1, maxTopics: 6 } } } },
  '主题探索：maxDepth=1 时第二层关联不再排队', async (h) => {
    h.setMode('reserved2');
    const job = h.startTopicExploration('mygo', { by: 'console' });
    await h.answerLearnerTurn(() => topicAnswer({
      name: 'MyGO!!!!!', summary: 'x',
      terms: [], related: [{ name: 'Ave Mujica', why: '同企划' }]
    }));
    assert.ok(await h.answerLearnerTurn(() => topicAnswer({
      name: 'Ave Mujica', summary: 'x',
      terms: [], related: [{ name: '更深一层', why: '再关联' }]
    })), '第一层仍然会挖');
    await h.awaitExploreChain();
    assert.equal(job.status, 'done');
    assert.equal(job.stats.topics, 2, '只有种子 + 第一层');
    assert.ok(!job.visited.some((v) => v.name === '更深一层'), '第二层没被挖');
  });

await testWith({ config: exploreCfgBase }, '主题探索：模型输出解析不了时记失败、不许编造学习结果', async (h) => {
  h.setMode('reserved2');
  const job = h.startTopicExploration('乱码主题', { by: 'console' });
  await h.answerLearnerTurn('抱歉，我没查到这个东西，也不确定它是不是梗。');
  await h.awaitExploreChain();
  assert.equal(job.stats.failed, 1, '记一次失败');
  assert.equal(job.stats.terms, 0, '没有凭空写入任何词条');
  assert.equal(h.getSlangEntries().length, 0, '黑话库保持干净');
  assert.equal(job.status, 'done', '失败不阻塞收尾');
  assert.ok(job.log.some((l) => /无法解析/.test(l.text)), '日志里如实说明');
});

await testWith({ config: exploreCfgBase }, '主题探索：fenced JSON + 前后夹带人话也能解析', async (h) => {
  h.setMode('reserved2');
  const job = h.startTopicExploration('mygo', { by: 'console' });
  await h.answerLearnerTurn(() => '我查到了：\n```json\n' + topicAnswer({
    name: 'MyGO!!!!!', summary: '乐队企划。', terms: [{ content: '春日影', meaning: '一首歌', sources: ['https://x.example/1'], confirmed: true }], related: []
  }) + '\n```\n还需要我继续吗？');
  await h.awaitExploreChain();
  assert.equal(job.status, 'done');
  assert.equal(job.stats.terms, 1);
  assert.equal(h.getSlangEntries()[0].content, '春日影');
});

await testWith({ config: exploreCfgBase }, '主题探索：停止标记被尊重，不再继续挖', async (h) => {
  h.setMode('reserved2');
  const job = h.startTopicExploration('mygo', { by: 'console' });
  // 第一轮跑完并排入关联后请求停止
  await h.answerLearnerTurn(() => topicAnswer({
    name: 'MyGO!!!!!', summary: 'x', terms: [], related: [{ name: 'Ave Mujica', why: '同企划' }]
  }));
  h.stopTopicExploration(job.id);
  await h.awaitExploreChain();
  assert.equal(job.status, 'stopped');
  assert.ok(!job.visited.some((v) => v.name === 'Ave Mujica'), '停止后不再挖队列里的下一个');
});

await testWith({ config: { slang: { enabled: true, explore: { enabled: true, maxJobsPerHour: 2, maxConcurrent: 1 } } } },
  '主题探索：并发与频率限制（AI 也能发起，必须限流）', async (h) => {
    h.setMode('reserved2');
    const a = h.startTopicExploration('one', { by: 'console' });
    assert.throws(() => h.startTopicExploration('two', { by: 'ai:private:123' }), /已有 1 个探索任务在跑/, '同时只跑一个');
    h.stopTopicExploration(a.id);
    await h.awaitExploreChain();
    h.startTopicExploration('three', { by: 'console' });
    h.stopTopicExploration(h.exploreJobs[0].id);
    await h.awaitExploreChain();
    assert.throws(() => h.startTopicExploration('four', { by: 'console' }), /太频繁/, '每小时上限生效');
  });

await testWith({ config: { slang: { enabled: true, explore: { enabled: false } } } },
  '主题探索：开关关掉后拒绝发起', async (h) => {
    h.setMode('reserved2');
    assert.equal(h.exploreCfg().enabled, false);
    assert.throws(() => h.startTopicExploration('mygo'), /未启用/);
  });

// ── 主动开话题的反重复 ────────────────────────────────────────────────────
// 线上问题：AI 主动冒泡每次都聊同一个圈子（实测是电竞/赛事）。原因是主动开口时模型能抓的
// 抓手只有「人格 + 群里最近聊的事 + 它自己写的【进行中的话题】记忆」，人格没写兴趣、
// 记忆全是那个圈子，于是反复开同一个话题。这里钉住「记住最近开的头 + 要求换方向」。
await testWith({ config: { socialV2: { proactive: { domains: ['科技', '吃饭', '冷知识'], suggestDomains: 2 } } } },
  '主动开话题：提示词里带上最近开的头，并要求换方向', async (h) => {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    st.proactiveOpeners = [
      { text: 'S16 赛程漏出来了，凌晨开打', at: Date.now() - 60000 },
      { text: 'Coinbase 把比特币塞进 LOL 了', at: Date.now() - 30000 }
    ];
    const prompt = h.buildProactiveTopicBlock(h.getSocialV2State('group:456'));
    assert.match(prompt, /你最近主动开的头/, '列出最近主动开的话题');
    assert.match(prompt, /S16 赛程漏出来了/, '原样带上具体文本（模型对抽象指令不敏感，对具体文本敏感）');
    assert.match(prompt, /Coinbase 把比特币塞进 LOL 了/);
    assert.match(prompt, /这次别再聊这些/, '明确要求别重复');
    assert.match(prompt, /【这次换个方向】/, '给出随机方向抓手');
    assert.match(prompt, /同一个人物\/战队\/作品\/圈子的后续也算重复/, '把「同圈子后续也算重复」讲清楚');
  });
await testWith({ config: { socialV2: { proactive: { domains: ['科技', '吃饭'], suggestDomains: 2 } } } },
  '主动开话题（reserved2 实际路径）：buildWakePromptV2 里带上换方向 + 别拿记忆当题材', async (h) => {
    // buildProactivePrompt 是一代（reserved）路径；二代真正发出去的是 buildWakePromptV2
    // 的 proactiveCheck 分支。这条就是为了防止「改错了路径」——线上那次就是栽在这。
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    st.proactiveOpeners = [{ text: 'S16 赛程漏出来了，凌晨开打', at: Date.now() }];
    const prompt = h.buildWakePromptV2('group:456', 'proactiveCheck');
    assert.match(prompt, /【主动机会】group:456/, '是 proactiveCheck 分支');
    assert.match(prompt, /【这次换个方向】/, '带上方向抓手');
    assert.match(prompt, /【别拿记忆和群史当题材】/, '明确记忆只是背景、不是题材来源');
    assert.match(prompt, /不是让你顺着它往下说/, '把这件事讲透');
    assert.match(prompt, /S16 赛程漏出来了/, '带上最近开的头');
    assert.match(prompt, /开一个\*\*新\*\*话题/, '要求开新话题');
    // 旧的诱导必须消失：这两句是造成「只有 LoL」的直接原因
    assert.ok(!/追问上次没聊完的事/.test(prompt), '删掉「追问上次没聊完的事」（把人往旧话题上带）');
    assert.ok(!/结合记忆里的群友兴趣/.test(prompt), '删掉「结合记忆里的群友兴趣」（记忆里只有那个圈子）');
  });
await testWith({ config: { socialV2: { proactive: { domains: ['科技', '吃饭', '冷知识', '摸鱼'], suggestDomains: 2 } } } },
  '主动开话题：方向是随机抽的且数量受限', async (h) => {
    h.setMode('reserved2');
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      const m = /【这次换个方向】从这几个里挑一个你真有话说的：([^。]+)。/.exec(h.buildProactiveTopicBlock(h.getSocialV2State('group:456')));
      assert.ok(m, '方向段存在');
      const picked = m[1].split(' / ');
      assert.equal(picked.length, 2, '按 suggestDomains 抽 2 个');
      assert.equal(new Set(picked).size, picked.length, '不重复抽同一个方向');
      for (const p of picked) assert.ok(['科技', '吃饭', '冷知识', '摸鱼'].includes(p), `方向来自配置池：${p}`);
      seen.add(m[1]);
    }
    assert.ok(seen.size > 1, '多次生成结果不同（确实是随机而不是固定顺序）');
  });
await testWith({ config: { socialV2: { proactive: { domains: [], suggestDomains: 0 } } } },
  '主动开话题：没配方向池时只有「别重复」那段，不会崩也不会硬塞方向', async (h) => {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    st.proactiveOpeners = [{ text: '旧话题', at: Date.now() }];
    const prompt = h.buildProactiveTopicBlock(h.getSocialV2State('group:456'));
    assert.match(prompt, /你最近主动开的头/, '记住的头默认还是要列出来（avoidRepeat 默认开）');
    assert.ok(!/【这次换个方向】/.test(prompt), 'domains 为空时不点方向');
  });
await testWith({ config: { socialV2: { proactive: { avoidRepeat: false, domains: [] } } } },
  '主动开话题：avoidRepeat=false 时连「别重复」那段也不注入', async (h) => {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    st.proactiveOpeners = [{ text: '旧话题', at: Date.now() }];
    const prompt = h.buildProactiveTopicBlock(h.getSocialV2State('group:456'));
    assert.ok(!/你最近主动开的头/.test(prompt), '关掉后不再注入');
  });
await test('主动开话题：默认配置（不填任何新参数）下反重复与方向都要生效', async (h) => {
  // 这条是防「参数没配 → NaN → 整段静默失效」的：线上默认配置就是这种情形。
  // 曾经的写法 `Number(x) ?? 5` 里 Number(undefined)=NaN 不会被 ?? 兜住，
  // 结果 keep=NaN 让记录整段跳过、.slice(0,NaN) 让话题文本变空串，功能看着在、其实全废。
  h.setMode('reserved2');
  const st = h.getSocialV2State('group:456');
  st.lastWakeReason = 'proactiveCheck';
  h.recordSentMessagesV2('group:456', ['默认配置下也要记住这句话']);
  assert.equal(st.proactiveOpeners?.length, 1, '默认 rememberOpeners 生效');
  assert.match(st.proactiveOpeners[0].text, /默认配置下也要记住这句话/, '默认 openerChars 不能把文本切成空串');
  const prompt = h.buildProactiveTopicBlock(h.getSocialV2State('group:456'));
  assert.match(prompt, /默认配置下也要记住这句话/, '下一轮能看到');
  assert.match(prompt, /【这次换个方向】/, '默认 suggestDomains 生效（内置方向池）');
});
await test('主动开话题：连着两条「刷到个说法 + 健康作息」要被点名，并避开对应方向', async (h) => {
  // 线上真实复读（2026-10-12 群 1050666134）：模型不觉得「午睡」和「久坐」是重复，
  // 原提示也只禁「同一人物/作品/圈子」，于是它连着两次用同一句式写了同一类冷知识。
  const st = {
    proactiveOpeners: [
      { text: '刷到个说法，午睡超过半小时，醒来反而更懵 这个点还没冒头的，是不是已经在自己身上验证了', at: 1 },
      { text: '刷到个说法，久坐超过四小时，晚上去健身房也补不回来 那我这种一天坐24小时的，已经没救了', at: 2 },
    ],
    proactiveDomains: [],
  };
  const block = h.buildProactiveTopicBlock(st);
  assert.match(block, /「刷到个/, '要把重复的起头方式点名到具体字眼');
  assert.match(block, /健康 \/ 作息/, '要把重复的题材点名出来（午睡≠久坐，但都是这一类）');
  const dirLine = /【这次换个方向】([^\n]*)/.exec(block)?.[1] ?? '';
  assert.ok(dirLine, '仍然要给方向建议');
  for (const bad of ['睡眠 / 作息', '运动 / 健身', '冷知识 / 科普']) {
    assert.ok(!dirLine.includes(bad), `正在重复的题材对应的方向不该再建议：${bad}（实际：${dirLine}）`);
  }
  assert.equal(st.proactiveDomains.length, 1, '要记下这轮建议过的方向，供下一轮避开');
  assert.ok(st.proactiveDomains[0].names.length >= 1);
});

// 语义查重闸门：线上「耳虫」隔两天又开一次（上下文窗口看不到自己两天前说过）。
// 这里用假 embedder 精确控制相似度：同话题 → 1.0（必拦），不同话题 → 0（放行）。
class FakeRepeatEmbedder {
  constructor() { this.ready = true; this.info = { ready: true, model: 'fake', dim: 2 }; this.stats = { requests: 0, totalMs: 0 }; }
  async start() { return true; }
  async embed(texts) { return texts.map((t) => (/耳虫|单曲循环/.test(String(t)) ? [1, 0] : [0, 1])); }
  async probe() { return { ok: true }; }
  dispose() {}
}

await testWith(
  { globals: { EmbeddingClient: FakeRepeatEmbedder, scrubFormulaicSpeech, describeScrub }, config: { socialV2: { proactive: { repeatSimThreshold: 0.75, repeatWindowHours: 168 } } } },
  '主动开口闸门：和两天前的开盘撞题就不发，打回换题；换过之后能发出去',
  async (h) => {
    const stopKeepAlive = h.keepLoopAlive();
    const server = h.startConsoleServer();
    try {
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      h.setMode('reserved2');
      const key = 'group:456';
      const st = h.getSocialV2State(key);
      st.proactiveOpeners = [{ text: '脑子里单曲循环了一早上，这种甩不掉的歌有个名字叫耳虫', at: Date.now() - 2 * 86400000 }];
      // 装闸门：真实路径是在「主动机会检查」唤醒时装的
      await h.sendWakePromptV2(key, 'proactiveCheck').catch(() => {});
      const first = await apiRequest(server, '/api/socialV2/send-message?token=fixture-console-token', {
        body: { key, messages: '一段旋律在我脑子里单曲循环到现在，这叫耳虫' }, agentToken: st.agentToken,
      });
      assert.equal(first.status, 500);
      assert.equal(first.body.selfRepeat, true, '要被闸门拦下');
      assert.ok(Number(first.body.detail?.sim) >= 0.75, `要带相似度（实际 ${first.body.detail?.sim}）`);
      assert.match(String(first.body.error ?? ''), /几乎一样|换个题/, '要给模型明确的换题指令');
      assert.equal(h.calls.ws.filter((c) => c.action === 'send_group_msg').length, 0, '拦下就不能发出去');

      const second = await apiRequest(server, '/api/socialV2/send-message?token=fixture-console-token', {
        body: { key, messages: '换个话题：今天食堂的排骨居然不柴' }, agentToken: st.agentToken,
      });
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(h.calls.ws.filter((c) => c.action === 'send_group_msg').length, 1, '每回合只拦一次，换过之后照发');
    } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); stopKeepAlive(); }
  }
);

// 线上问题（2026-10-13）：群里消息 AI 几乎都默认当成对自己说的。要给它两样东西：
// ① 读消息时能看出「谁在跟谁说话」（aboutYou / repliesTo / who）；② 唤醒原因要讲清是不是在找它。
await test('读消息时要能看出「谁在跟谁说话」：aboutYou / repliesTo / who', async (h) => {
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    h.setMode('reserved2');
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    h.appendSocialV2Message(key, 'kafka', '在吗', '在吗', false, false, 710001, [], '1374585879', [], null, null, null, false);
    h.appendSocialV2Message(key, '面包屑🍞', '@哦鲸鲸 这个怎么弄', '@哦鲸鲸 这个怎么弄', false, false, 710002, [], '2638514344', [], null, null, null, true);
    h.appendSocialV2Message(key, 'kafka', '[引用 面包屑🍞：色儿不一样] 我也这么觉得', '[引用 面包屑🍞：色儿不一样] 我也这么觉得', false, false, 710003, [], '1374585879', [], '710002', null, null, false);
    h.appendSocialV2Message(key, 'kafka', '[引用 你：我这条是回他这张图的] 哈哈', '[引用 你：我这条是回他这张图的] 哈哈', true, false, 710004, [], '1374585879', [], '710000', null, null, false);

    const res = await apiRequest(server, `/api/socialV2/recent?token=fixture-console-token&key=${encodeURIComponent(key)}&limit=10`, { method: 'GET', agentToken: st.agentToken });
    assert.equal(res.status, 200);
    const byId = new Map((res.body.messages ?? []).map((m) => [String(m.messageId), m]));

    const plain = byId.get('710001');
    assert.equal(plain.who, 'kafka', '要说清是谁在说话');
    assert.equal(plain.aboutYou, undefined, '没针对你的消息不能带 aboutYou');

    const at = byId.get('710002');
    assert.match(String(at.aboutYou ?? ''), /at了你|@/, '@ 了机器人必须标出来');

    const quotedOther = byId.get('710003');
    assert.equal(quotedOther.repliesTo, '面包屑🍞', '要说清这条在回谁');
    assert.equal(quotedOther.aboutYou, undefined, '引用别人≠在跟你说话');

    const quotedSelf = byId.get('710004');
    assert.equal(quotedSelf.repliesTo, '你');
    assert.match(String(quotedSelf.aboutYou ?? ''), /引用/, '引用你的消息要标成针对你');
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
});

// 线上事故（2026-10-14 群 1050666134）：面包屑发了一张 **143 帧**的动画表情，桥接只等间隔抽了 4 帧
// （0/47/95/142），最后那帧是收尾的「抬手遮脸」，AI 就断言「拿我形象做哭图再发回来，你是懂二创的」，
// 群友当场纠正「图里的大肥鱼没有哭，我冤枉啊」。帧是稀疏采样，过渡动作不能被当成结论。
await test('动图抽帧：长动图要多抽几帧，且帧说明里必须点明「稀疏抽样」', async (h) => {
  const long = h.planAnimFrames(143);
  assert.equal(long.shown, 6, '长动图（>40 帧）要抽满 6 帧，而不是 4 帧');
  assert.equal(long.pages[0], 0, '要含第一帧');
  assert.equal(long.pages[long.pages.length - 1], 142, '要含最后一帧');
  assert.deepEqual([...long.pages], [...long.pages].sort((a, b) => a - b), '帧号要有序');

  const short = h.planAnimFrames(8);
  assert.equal(short.shown, 4, '短动图 4 帧够看，不用多花上下文');
  assert.deepEqual([...h.planAnimFrames(1).pages], [0], '单帧图不炸');

  const label = h.animFrameText(3, 6, 143);
  assert.match(label, /第 4\/6 帧/, '要标清第几帧／共抽几帧');
  assert.match(label, /143 帧/, '要给出原图总帧数');
  assert.match(label, /稀疏抽样/, '要说明这是稀疏抽样');
  assert.match(label, /别据此断言情绪/, '要明确别拿单帧表情下情绪结论');
});

await test('各种唤醒原因的提示文本都不能出现字面破折号', async (h) => {
  // 规则文本自己用破折号＝在示范这种句式（项目里已有同类测试，这里覆盖到「原因」那一段，
  // 因为 describeWakeReasonV2 会按原因返回不同文案，之前只在 reason='message' 下被测过）。
  h.setMode('reserved2');
  const key = 'group:456';
  h.getSocialV2State(key);
  for (const reason of ['message', 'atMention', 'nameMention', 'speaker:kafka', 'keyword:大肥鱼', 'proactiveCheck', 'probability', 'replyCheck', 'busyRecovery', 'timeout', 'admin']) {
    const prompt = h.buildWakePromptV2(key, reason);
    assert.equal((prompt.match(/——/g) || []).length, 0, '原因 ' + reason + ' 的提示里有字面破折号');
  }
});

await test('唤醒提示要讲清「是不是在跟你说话」', async (h) => {
  h.setMode('reserved2');
  const key = 'group:456';
  h.getSocialV2State(key);
  const bySpeaker = h.buildWakePromptV2(key, 'speaker:kafka');
  assert.match(bySpeaker, /不是在跟你说话/, '关注的群友发言不是找你，必须说明');
  assert.match(bySpeaker, /谁在跟谁说话/, '要给指向规则');
  assert.match(bySpeaker, /aboutYou/, '要告诉它看 aboutYou 字段判断');
  const byAt = h.buildWakePromptV2(key, 'atMention');
  assert.match(byAt, /这条是对你说的/, '@ 唤醒要明说这条是冲它来的');
  const byKeyword = h.buildWakePromptV2(key, 'keyword:大肥鱼');
  assert.match(byKeyword, /不等于在跟你说话/);
});

// 线上事故（2026-10-13 11:57 群 1050666134）：owner 发的 B 站卡片触发 question 唤醒，撞上频率上限，
// 旧代码直接 return 把唤醒原因丢了 → 那条消息永远没人处理，群里看到的就是「AI 没回我」。
await test('唤醒频率超限不能丢掉：要暂存，额度恢复后自动补投', async (h) => {
  h.setMode('reserved2');
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  st.wakeTimes = [Date.now()]; // maxWakePerMinute 默认 1：这一分钟的额度已用掉
  const before = h.calls.prompts.length;
  await h.sendWakePromptV2(key, 'question');
  assert.equal(h.calls.prompts.length, before, '超限时确实不该投递');
  assert.equal(st.pendingWakeReasons.length, 1, '必须暂存，不能像以前那样直接丢');
  assert.match(JSON.stringify(st.pendingWakeReasons[0]), /question/, '暂存的是这条唤醒原因');

  st.wakeTimes = []; // 额度恢复
  const delivered = await h.retryPendingWakeV2(key);
  assert.equal(delivered, true, '补投要成功');
  assert.equal(st.pendingWakeReasons.length, 0, '补投后出队');
  assert.ok(h.calls.prompts.length > before, '这一次真的把唤醒投给模型了');
});

// owner 反馈「AI 还是会在群里发已经发过的话题」，并问「AI 自己发过的话有加入记忆吗」。
// 查证：旧记忆只记 proactiveCheck 那一轮的「主动开的头」，**回复里讲过的内容完全不在参照池里**。
// 真实案例：电车服务区充电先说在回复里，5 天后又当新话题开了一次（语义相似度 0.764）。
await test('旧状态补种：从已有发言推导出 selfSaid（含回复），并把开盘标的认出来', async (h) => {
  const now = Date.now();
  const derived = h.deriveSelfSaid({
    recentMessages: [
      { sender: '我', isSelf: true, text: '刷到个视频，有电车车主在服务区排队充电，前面排着179辆车', time: now - 5 * 86400000 },
      { sender: 'kafka', isSelf: false, text: '哈哈', time: now - 5 * 86400000 + 1000 },
      { sender: '我', isSelf: true, text: '另外今年多个新变量：高速免费七天', time: now - 4 * 86400000 },
    ],
    proactiveOpeners: [{ text: '另外今年多个新变量：高速免费七天', at: now - 4 * 86400000 }],
  });
  assert.equal(derived.length, 2, '只补种自己发的、有文字的');
  assert.equal(derived[0].kind, 'reply', '对不上开盘记录的按回复处理');
  assert.equal(derived[1].kind, 'opener', '与 proactiveOpeners 对上的标成开盘');
  assert.ok(derived[0].at > 0, '要带上原始时间（提示里要显示「5 天前」）');

  // 已经有 selfSaid 的状态：原样沿用，不重复补种
  const kept = h.deriveSelfSaid({ selfSaid: [{ text: '已有记忆', at: 1, kind: 'reply' }], recentMessages: [{ isSelf: true, text: '别的', time: 2 }] });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].text, '已有记忆');
});

await test('自己说过的话要进记忆：回复里的内容也算（kind=reply），开盘轮算 opener', async (h) => {
  h.setMode('reserved2');
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  st.lastWakeReason = 'speaker:kafka';           // 回复轮
  h.recordSentMessagesV2(key, ['刷到个视频，有电车车主在服务区排队充电，前面排着179辆车']);
  assert.equal(st.selfSaid.length, 1, '回复里说过的话也要记下来');
  assert.equal(st.selfSaid[0].kind, 'reply', '要区分是回复还是主动开盘');
  st.lastWakeReason = 'proactiveCheck';          // 主动开盘轮
  h.recordSentMessagesV2(key, ['另外今年多个新变量：高速免费七天']);
  assert.equal(st.selfSaid.length, 2);
  assert.equal(st.selfSaid[1].kind, 'opener');
  // 落盘/载入要保留（否则重启后又开始复读）
  assert.ok(Array.isArray(st.selfSaid) && typeof st.selfSaid[0].text === 'string');
});

await testWith(
  { globals: { EmbeddingClient: FakeRepeatEmbedder, scrubFormulaicSpeech, describeScrub } },
  '查重闸门要拿「自己说过的话」当参照池：回复里讲过的题，别再当新话题开', async (h) => {
  const stopKeepAlive = h.keepLoopAlive();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    h.setMode('reserved2');
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    // 两天前「回复」里讲过耳虫；主动开盘的记忆里没有它
    st.selfSaid = [{ text: '脑子里单曲循环了一早上，这种甩不掉的歌有个名字叫耳虫', at: Date.now() - 2 * 86400000, kind: 'reply' }];
    st.proactiveOpeners = [];
    await h.sendWakePromptV2(key, 'proactiveCheck').catch(() => {});
    const res = await apiRequest(server, '/api/socialV2/send-message?token=fixture-console-token', {
      body: { key, messages: '一段旋律在我脑子里单曲循环到现在，这叫耳虫' }, agentToken: st.agentToken,
    });
    assert.equal(res.body.selfRepeat, true, '回复里讲过的同话题开盘要被拦');
    assert.equal(h.calls.ws.filter((c) => c.action === 'send_group_msg').length, 0, '拦下就不发');
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); stopKeepAlive(); }
}
);

await test('主动开口提示要摆出「你最近说过的话」（避免换个说法再讲一遍）', async (h) => {
  const block = h.buildProactiveTopicBlock({
    proactiveOpeners: [],
    selfSaid: [{ text: '刷到个视频，有电车车主在服务区排队充电，前面排着179辆车', at: Date.now() - 5 * 86400000, kind: 'reply' }],
    proactiveDomains: [],
  });
  assert.match(block, /你最近在这个群说过的话/, '要把自己说过的话摆出来');
  assert.match(block, /电车车主在服务区排队充电/, '内容要带上');
  assert.match(block, /5 天前/, '要标时间');
});

await test('主动开话题：改成让 AI 自己去翻记忆（不再把旧开盘硬塞进提示词）', async (h) => {
  const st = { proactiveOpeners: [{ text: '耳虫那件事', at: Date.now() - 2 * 86400000 }], proactiveDomains: [] };
  const block = h.buildProactiveTopicBlock(st);
  assert.match(block, /开口前先翻一下记忆/, '要提示它先查记忆（qq_recall / qq_search_history）');
  assert.match(block, /qq_recall/, '要指明用哪个工具查');
  assert.match(block, /qq_search_history/, '也要给归档检索这条兜底');
});
await test('主动开话题：方向池轮换——连续两轮不会建议同一批方向', async (h) => {
  const st = { proactiveOpeners: [], proactiveDomains: [] };
  const pickOf = (text) => /【这次换个方向】([^\n]*)/.exec(text)?.[1] ?? '';
  const first = pickOf(h.buildProactiveTopicBlock(st));
  const second = pickOf(h.buildProactiveTopicBlock(st));
  const ALL = ['科技 / AI 圈的新东西', '生活里的琐事与吐槽', '影视 / 动画 / 番剧', '音乐 / 歌单', '游戏（非电竞赛事）', '社会新闻里的小事', '冷知识 / 科普', '吃吃喝喝', '摸鱼 / 上班上学', '网上的抽象梗', '运动 / 健身', '睡眠 / 作息'];
  const inFirst = ALL.filter((d) => first.includes(d));
  const inSecond = ALL.filter((d) => second.includes(d));
  assert.ok(inFirst.length >= 1 && inSecond.length >= 1, '两轮都要给出方向');
  const overlap = inFirst.filter((d) => inSecond.includes(d));
  assert.equal(overlap.length, 0, `相邻两轮不该重复建议同一方向（重叠：${overlap.join(' / ')}）`);
});

await test('主动开话题：不相干的两条开盘不该被误判成重复', async (h) => {
  const block = h.buildProactiveTopicBlock({
    proactiveOpeners: [
      { text: '刚下了场雨，路上全是蜗牛', at: 1 },
      { text: '食堂今天的排骨居然不柴', at: 2 },
    ],
    proactiveDomains: [],
  });
  assert.doesNotMatch(block, /起头方式本身就在重复/, '没有重复起法就不该乱报');
  assert.doesNotMatch(block, /题材也在重复/, '题材不同就不该乱报');
});

await testWith({ config: { socialV2: { proactive: { avoidKeywords: ['LOL', '英雄联盟'], domains: [] } } } },
  '主动开话题：avoidKeywords 会写进提示词', async (h) => {
    h.setMode('reserved2');
    const prompt = h.buildProactiveTopicBlock(h.getSocialV2State('group:456'));
    assert.match(prompt, /【主动开话题时别碰】LOL \/ 英雄联盟/);
    assert.match(prompt, /除非群里刚有人主动聊起来/, '只在主动开口时约束，群友提起不算');
  });
await testWith({ config: { socialV2: { proactive: { rememberOpeners: 2, openerChars: 20, domains: [] } } } },
  '主动开话题：主动回合发出的消息被记成「开的头」，条数/长度受限', async (h) => {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    st.lastWakeReason = 'proactiveCheck';
    h.recordSentMessagesV2('group:456', ['第一条主动话题内容很长很长很长很长很长很长很长很长']);
    h.recordSentMessagesV2('group:456', ['第二条']);
    h.recordSentMessagesV2('group:456', ['第三条']);
    assert.equal(st.proactiveOpeners.length, 2, '按 rememberOpeners 只留最近 2 条');
    assert.ok(st.proactiveOpeners.every((o) => o.text.length <= 20), '每条按 openerChars 截断');
    assert.equal(st.proactiveOpeners.at(-1).text, '第三条');
    // 普通回复回合不记（只有主动开口才需要反重复）
    st.lastWakeReason = 'private';
    h.recordSentMessagesV2('group:456', ['普通回复']);
    assert.equal(st.proactiveOpeners.length, 2, '非主动回合不记入');
  });
await testWith({ config: { socialV2: { proactive: { rememberOpeners: 3, domains: [] } } } },
  '主动开话题：记下的头会落盘（重启后仍然反重复）', async (h) => {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    st.lastWakeReason = 'proactiveCheck';
    h.recordSentMessagesV2('group:456', ['聊过的老话题']);
    const raw = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'social-v2.json'), 'utf8'));
    const persisted = (raw.conversations ?? raw)['group:456'];
    assert.equal(persisted?.proactiveOpeners?.length, 1, 'proactiveOpeners 写进了 social-v2.json');
    assert.match(persisted.proactiveOpeners[0].text, /聊过的老话题/);
  });

await testWith({ config: { socialV2: { proactive: { enabled: true, probability: 0.2 } } } },
  '主动开话题：config.json 里已有 proactive 段时，内置方向池仍要保留（深度合并）', async (h) => {
    // 外层 spread 会整段替换 proactive：不显式深度合并的话，用户只写了 enabled/probability
    // 就会把 domains 等新默认值悄悄吃掉 —— 反重复只剩「别聊这些」、没有「聊什么」的抓手。
    const p = h.cfg.socialV2.proactive;
    assert.equal(p.probability, 0.2, '用户配置优先');
    assert.ok(Array.isArray(p.domains) && p.domains.length >= 8, `内置方向池仍在（实际 ${p.domains?.length}）`);
    assert.equal(p.suggestDomains, 3, '新默认值补齐');
    assert.equal(p.rememberOpeners, 20, '默认要记够久，免得隔天又来一遍');
    assert.equal(p.avoidRepeat, true);
    assert.equal(p.repeatGuard, true, '语义查重默认开');
    assert.equal(p.repeatSimThreshold, 0.75);
    assert.equal(p.repeatWindowHours, 168);
  });
await testWith({ config: { socialV2: { proactive: { domains: ['只留这个'] } } } },
  '主动开话题：用户显式给的 domains 覆盖内置池（不会被悄悄改回去）', async (h) => {
    // 注意：h.cfg 来自 vm 上下文，其数组原型和宿主不同，deepStrictEqual 会因原型不一致而失败，
    // 这里比较序列化结果。
    assert.equal(JSON.stringify(h.cfg.socialV2.proactive.domains), JSON.stringify(['只留这个']));
  });

// ── 链接分享卡（qq_send_card）：AI 只给字段，卡片体由桥接组装 ────────────────
// 安全边界：不接受任意 json/xml（那能伪造「系统通知/红包/群邀请」），链接必须公网 http(s)
// （否则提示注入能让 AI 发一张指向本机控制台、还带令牌的可点击卡片）。
const cardCfg = { socialV2: { card: { enabled: true, maxTitleChars: 60, maxDescChars: 90 } } };
// 出网校验桩：与真实 validateFetchUrl 的判据保持一致（scheme + 内网/本机），但不做 DNS。
const cardNetStub = { validateFetchUrl: async (u) => {
  const target = new URL(u);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('仅允许 http/https');
  const host = target.hostname;
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
      || /^(10|127|192\.168|169\.254)\./.test(host)) throw new Error('禁止访问内网/本机地址');
  return { url: target, ip: '1.2.3.4' };
} };

await test('真实的出网校验器会拦掉非 http(s) 与本机地址（卡片复用它的判据）', async () => {
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'http://127.0.0.1:3100/', 'http://localhost:3100/']) {
    await assert.rejects(() => realValidateFetchUrl(bad), undefined, `应拒绝 ${bad}`);
  }
  // 带凭据的 URL 也拒绝（防止把 token 塞进 URL）
  await assert.rejects(() => realValidateFetchUrl('https://user:pass@example.com/'));
});

await testWith({ config: cardCfg, globals: cardNetStub }, '卡片：只发一个 json 段，app/view 由桥接写死（AI 给不了 JSON）', async (h) => {
  h.setMode('reserved2');
  const result = await h.sendCardV2('private:123', { url: 'https://example.com/a?b=1', title: '标题', desc: '摘要' });
  const segments = h.calls.ws.filter((c) => c.action === 'send_private_msg').at(-1).params.message;
  assert.equal(segments.length, 1, '只有卡片段（一条消息只能是一张卡）');
  assert.equal(segments[0].type, 'json');
  const card = JSON.parse(segments[0].data.data);
  assert.equal(card.app, 'com.tencent.structmsg', 'app 由桥接写死，AI 无法指定');
  assert.equal(card.view, 'news');
  assert.equal(card.meta.news.jumpUrl, 'https://example.com/a?b=1');
  assert.match(card.prompt, /\[分享\] 标题 https:\/\/example\.com\/a\?b=1/, '兜底文本自带标题 + 完整链接（卡片不渲染时用户也能点）');
  assert.equal(result.delivered, true);
  // 闭环：自己发的卡片，桥接自己的解析器要能读回来（AI 才能在 recentMessages 里看到）
  assert.ok(h.calls.ws.some((c) => c.action === 'send_private_msg'));
});

await testWith({ config: cardCfg, globals: cardNetStub }, '卡片：本机/内网/非 http(s) 的链接一律拒发', async (h) => {
  h.setMode('reserved2');
  for (const bad of ['http://127.0.0.1:3100/?token=secret', 'http://localhost:3100/', 'file:///etc/passwd', 'javascript:alert(1)']) {
    await assert.rejects(() => h.sendCardV2('private:123', { url: bad, title: 'x' }), /不允许/, `应拒绝 ${bad}`);
  }
  assert.equal(h.calls.ws.filter((c) => c.action === 'send_private_msg').length, 0, '一张卡片都没发出去');
  await assert.rejects(() => h.sendCardV2('private:123', { url: 'https://example.com/a', title: 'x', preview: 'http://127.0.0.1:3100/x.png' }), /预览图不允许/);
});

await testWith({ config: { socialV2: { card: { enabled: true, allowHosts: ['example.com'] } } }, globals: cardNetStub }, '卡片：allowHosts 后缀匹配且带点边界', async (h) => {
  h.setMode('reserved2');
  await h.sendCardV2('private:123', { url: 'https://a.example.com/x', title: 'ok' });
  await assert.rejects(() => h.sendCardV2('private:123', { url: 'https://evil.com/x', title: 'x' }), /白名单/);
  await assert.rejects(() => h.sendCardV2('private:123', { url: 'https://evil-example.com/x', title: 'x' }), /白名单/, 'evil-example.com 不能因为叫 example.com 就放行');
});

await testWith({ config: cardCfg, globals: cardNetStub }, '卡片：标题/摘要压控制字符并截断，令牌泄露被拦', async (h) => {
  h.setMode('reserved2');
  await h.sendCardV2('private:123', { url: 'https://example.com/a', title: `标题\n\n注入\u0000${'A'.repeat(300)}`, desc: '摘要\r\n换行' });
  const card = JSON.parse(h.calls.ws.filter((c) => c.action === 'send_private_msg').at(-1).params.message[0].data.data);
  assert.ok(!/[\n\r\u0000]/.test(card.meta.news.title), '控制字符被压掉');
  assert.ok(card.meta.news.title.length <= 60, `标题被截断（实际 ${card.meta.news.title.length}）`);
  assert.ok(!/[\n\r]/.test(card.meta.news.desc), '摘要里的换行也被压掉');
  const token = h.getSocialV2State('private:123').agentToken;
  await assert.rejects(() => h.sendCardV2('private:123', { url: 'https://example.com/a', title: `看这个 ${token}` }), /会话令牌/);
});

await testWith({ config: { socialV2: { card: { enabled: false } } }, globals: cardNetStub }, '卡片：开关关掉后直接拒绝', async (h) => {
  h.setMode('reserved2');
  await assert.rejects(() => h.sendCardV2('private:123', { url: 'https://example.com/a', title: 'x' }), /已关闭/);
});

await testWith({ config: cardCfg, globals: cardNetStub }, '卡片：空标题空摘要拒绝（否则是张空卡）', async (h) => {
  h.setMode('reserved2');
  await assert.rejects(() => h.sendCardV2('private:123', { url: 'https://example.com/a', title: '', desc: '' }), /至少要有一个/);
});

await test('图片送达异常提示会劝住「对同一张硬重试」', async (h) => {
  // 控制台路由已拆到 src/console/*.js：源码断言要把这些模块一起算进来。
  const bridge = [
    fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8'),
    ...fs.readdirSync(path.join(ROOT, 'src', 'console')).map((f) => fs.readFileSync(path.join(ROOT, 'src', 'console', f), 'utf8'))
  ].join('\n');
  assert.ok(/图片没有真正送达/.test(bridge) && /别再对同一张反复重试/.test(bridge), '502 错误文案写明原因与对策');
  assert.ok(/imageMessageDelivered/.test(bridge) && /message_seq/.test(bridge) && /confirmImageDelivered/.test(bridge), '送达判据来自 get_msg 的 message_seq / CDN 地址');
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  // 工具描述必须把 delivered 三态和「null 时不要重发」讲清楚（重复图就是从误判重发来的）。
  assert.ok(/delivered 是三态/.test(mcp) && /不要重发同一张/.test(mcp), 'MCP 工具描述同步说明送达三态');
  const consoleView = fs.readFileSync(path.join(ROOT, 'public', 'console', 'views', 'social2.js'), 'utf8');
  assert.ok(/path: 'deliverCheckMs'/.test(consoleView), '控制台能配送达确认时限');
});
await testWith({ config: { socialV2: { presetRefresh: false } }, globals: stampFixture }, 'presetRefresh=false keeps the stale session on purpose', async (h) => {
  const first = await h.ensureSession('private:123');
  delete h.state.sessionPresetStamps['private:123'];
  assert.equal(await h.ensureSession('private:123'), first);
});
await test('reset during model selection cannot return a detached session', async (h) => {
  h.api.sessions.selectModel = async () => {
    h.resetEpoch();
    return { result: { ok: true, value: { selected: {} } } };
  };
  await assert.rejects(h.ensureSession('private:123'));
  assert.equal(h.state.sessions['private:123'], undefined);
});
await test('malformed HTTP request targets return 400 without hanging', async (h) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: 'http://[', method: 'GET' }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(1500, () => request.destroy(new Error('request hung')));
      request.end();
    });
    assert.equal(status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
{ // 控制台重置路径必须与 retireSession 一样：清掉权限元数据并终止 DSH 侧排队的工作。
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const sessionId = await h.ensureSession('private:123');
    assert.ok(h.state.sessionPolicies['private:123'], 'policy should exist before reset');
    h.calls.cancelled.length = 0;
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/session/reset?token=fixture-console-token', method: 'POST',
        headers: { 'content-type': 'application/json' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('reset request hung')));
      request.end(JSON.stringify({ key: 'private:123' }));
    });
    assert.equal(status, 200);
    assert.equal(h.state.sessions['private:123'], undefined);
    assert.equal(h.state.sessionPolicies['private:123'], undefined, 'policy must not be orphaned by reset');
    assert.ok(h.calls.cancelled.includes(sessionId), 'reset must stop the retired DSH session');
    console.log('PASS console reset drops the session policy and stops the retired DSH session');
  } catch (error) { failures++; console.error('FAIL console reset cleanup:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
// 手动添加黑话必须落成「候选」：已确认的条目会被注入提示词、被 AI 当成事实使用，
// 刚敲进去还没复核的词条不该直接变成已确认（AI 自己提交的词也走候选→确认这条路径）。
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const post = (body) => new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/slang?token=fixture-console-token', method: 'POST',
        headers: { 'content-type': 'application/json' } }, (response) => {
        let raw = '';
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => { let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: response.statusCode, body: parsed }); });
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('slang add request hung')));
      request.end(JSON.stringify(body));
    });

    // ① 控制台表单的原始请求：不带 status（改之前这条会落成 confirmed）
    const plain = await post({ content: '绝绝子', meaning: '很好、很棒' });
    assert.equal(plain.status, 200);
    assert.equal(plain.body.entry.status, 'candidate', '不传 status 时入库为候选（不是 confirmed）');
    assert.equal(plain.body.entry.source, 'manual', '来源标记为 manual');
    assert.equal(plain.body.entry.meaning, '很好、很棒', '含义照常保存');

    // ② 显式传 candidate 也是候选
    const explicit = await post({ content: '班味', meaning: '上班带来的疲惫感', status: 'candidate' });
    assert.equal(explicit.body.entry.status, 'candidate');

    // ③ 只有显式传 confirmed 才直接已确认（例如导入一批已核实的词）
    const confirmed = await post({ content: '内卷', meaning: '过度竞争', status: 'confirmed' });
    assert.equal(confirmed.body.entry.status, 'confirmed');

    // ④ 非法 status 不能绕过复核：一律落候选
    const bogus = await post({ content: '摸鱼', meaning: '偷懒', status: 'published' });
    assert.equal(bogus.body.entry.status, 'candidate', '非法 status 不能变成已确认');

    // ⑤ 候选词确实存在、且能被确认（复核路径没断）
    const candidates = h.slangEntries.filter((e) => e.status === 'candidate').map((e) => e.content);
    assert.ok(candidates.includes('绝绝子') && candidates.includes('班味'), '新词在候选列表里');
    assert.equal(h.slangEntries.filter((e) => e.content === '内卷')[0].status, 'confirmed', '显式 confirmed 的词直接可用');

    // ⑥ 注入契约：候选**不会**进提示词，确认后才进——这正是「默认落候选」的意义所在。
    const ctx = h.buildSlangContext(h.slangEntries, 50);
    assert.ok(!/绝绝子/.test(ctx), '候选词不会被注入提示词');
    assert.ok(/内卷/.test(ctx), '已确认的词会被注入提示词');

    // ⑦ 重复词条仍然拒绝
    const dup = await post({ content: '绝绝子', meaning: '重复' });
    assert.equal(dup.status, 400, '同名词条不能重复入库');

    console.log('PASS 手动添加黑话入库为候选（确认后才进提示词）');
  } catch (error) { failures++; console.error('FAIL 手动添加黑话入库为候选:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
{
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  const h = await bridgeHarness({ globals: {
    safeFetchBuffer: async () => ({ buffer: image }),
    validateFetchUrl: async () => { throw new Error('must fetch validated bytes instead of passing a URL'); },
  } });
  try {
    await h.sendStickerV2('group:456', 'fixture-sticker');
    // 发送走 OneBot WS（bot.request），所以断言 WS 侧收到的 params，而不是注入的 fetch
    const send = h.calls.ws.find((entry) => entry.action === 'send_group_msg');
    assert.ok(send, 'send_group_msg 必须经 OneBot 通道发出');
    assert.equal(send.params.group_id, 456);
    const part = send.params.message.find((p) => p.type === 'image');
    assert.equal(part.data.file, 'base64://' + image.toString('base64'));
    console.log('PASS sticker sending gives OneBot validated bytes, never a URL to refetch');
  } catch (error) { failures++; console.error('FAIL safe sticker sending:', error.message); }
  finally { await h.close(); }
}
// 「AI 没反应」事故的回归：残留的忙标记必须能被识别成卡死并即时清掉。
// 背景：桥接在回合中途重启、或 DSH 侧回合异常结束而 turn/end 丢失时，
// 内存里的 turn/collector 标记会永久残留 → 每次唤醒只回一句「会话繁忙」，
// AI 再也不说话（线上实测发生过：用户消息被连着暂存，要等 8 分钟看门狗才自愈）。
await test('stale turn marker is detected as stuck busy and cleared', async (h) => {
  const key = 'private:123';
  const st = h.socialV2.conversations.get(key) ?? { wakeConfig: {}, recentMessages: [], unread: [], wakeTimes: [], sendTimes: [] };
  h.socialV2.conversations.set(key, st);
  const sid = 'session-stale';
  h.state.sessions[key] = sid;

  // 没有忙标记 → 不忙
  // 注意：harness 跑在 vm 里，跨 realm 的数组过不了 deepStrictEqual，只能比长度/内容。
  assert.equal(h.busyMarkersV2(key, st).length, 0, '初始不应有忙标记');
  assert.equal(h.staleTurnMarkerV2(key, []), '', '无标记时不该判成卡死');

  // 刚开始的 turn → 忙，但不算卡死（可能正在思考/长轮询）
  h.v2TurnStartAt.set(sid, Date.now());
  const fresh = h.busyMarkersV2(key, st);
  assert.ok(fresh.some((m) => m.startsWith('turn(')), '应报告 turn 标记：' + fresh.join('+'));
  assert.equal(h.staleTurnMarkerV2(key, fresh), '', '刚开始的 turn 不能被误判为卡死');

  // 正在 qq_wait_for_messages 长轮询 → 合法的忙，不能打断
  h.activeWaits.add(key);
  h.v2TurnStartAt.set(sid, Date.now() - 60 * 60 * 1000);
  assert.equal(h.staleTurnMarkerV2(key, h.busyMarkersV2(key, st)), '', '长轮询中的会话不能被强制清标记');
  h.activeWaits.delete(key);

  // 超过 busyRecoveryMs 且不在长轮询 → 判定卡死，并能被清空
  const stale = h.busyMarkersV2(key, st);
  assert.ok(h.staleTurnMarkerV2(key, stale), '过期 turn 标记应判为卡死：' + stale.join('+'));
  h.forceClearBusyV2(key, 'audit');
  assert.equal(h.busyMarkersV2(key, st).length, 0, 'forceClearBusyV2 之后不应再有忙标记');
  assert.equal(h.staleTurnMarkerV2(key, []), '', '清空后不再判卡死');
});

// 线上事故：模型看到消息带【管理员】（= ownerQQ 桥接管理员）就把该群友当成 QQ 群主，
// 还把这个错误身份写进 memberImpression，之后每轮唤醒都复读一遍「群主如何如何」。
// 这里钉住三条：① 二代每轮唤醒都讲清术语；② 一代只在这批真有管理员消息时讲，不白占上下文；
// ③ 「活跃成员」接口不再输出会被误读成群主的 isOwner，改成 isBridgeAdmin + 真实 groupRole。
await test('身份术语：二代唤醒提示分清「桥接管理员」与「QQ 群主」', async (h) => {
  h.setMode('reserved2');
  const prompt = h.buildWakePromptV2('group:456', 'message');
  assert.match(prompt, /【「管理员」≠「群主」】/, '每轮钉一次术语');
  assert.match(prompt, /桥接管理员（ownerQQ/, '说明【管理员】= ownerQQ');
  assert.match(prompt, /不是 QQ 群主/, '明确否认「管理员=群主」');
  assert.match(prompt, /qq_get_group_members/, '给出确认真实身份的工具');
  assert.match(prompt, /owner=群主/, '写清 role 取值');
  assert.match(prompt, /不确定就不要用「群主」称呼任何人/, '不确定时不许乱叫');
});
await test('身份术语：一代批次提示只在这批真有管理员消息时才解释', async (h) => {
  const withOwner = h.buildBatchPrompt('group:456', [{ sender: '米哈游㍿', text: 'hi', isOwner: true }], true);
  assert.match(withOwner, /【「管理员」≠「群主」】/, '出现【管理员】时要解释');
  const plain = h.buildBatchPrompt('group:456', [{ sender: '路人', text: 'hi', isOwner: false }], true);
  assert.ok(!/≠「群主」/.test(plain), '没有管理员消息时不注入，避免每轮占上下文');
});
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    st.recentMessages.push({ sender: '米哈游㍿', userId: '123', text: 'hi', isOwner: true, time: Date.now() });
    const result = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port: server.address().port,
        path: `/api/socialV2/active-members?token=fixture-console-token&key=${encodeURIComponent('group:456')}`,
        method: 'GET', headers: { 'x-agent-token': st.agentToken }
      }, (response) => {
        let raw = '';
        response.on('data', (chunk) => { raw += chunk; });
        response.on('end', () => { let parsed = null; try { parsed = JSON.parse(raw); } catch {} resolve({ status: response.statusCode, body: parsed }); });
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('active-members request hung')));
      request.end();
    });
    assert.equal(result.status, 200, '接口应正常返回');
    const member = result.body.members.find((m) => String(m.userId) === '123');
    assert.ok(member, '能看到刚写入的成员');
    assert.equal(member.isBridgeAdmin, true, 'ownerQQ 标成 isBridgeAdmin');
    assert.equal(member.isOwner, undefined, '不再输出会被误读成「群主」的 isOwner');
    assert.match(result.body.note, /不是 QQ 群主/, '回执里点明两者不同');
  } catch (error) { failures++; console.error('FAIL 活跃成员身份字段:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

// 线上事故（2026-10-14 群 1050666134）：**同一张痛车图**，私聊抓到的版本在视觉舒适区内 → 原样投喂，
// 车身上的字看得清（AI 认出「赛马娘 玉藻十字」）；群里抓到 7.5MB 原图 → 走压缩阶梯，而阶梯顶端只有
// 1600px，第一档压出 482KB 就直接采用（4MB 预算只用了 1/8），细节全丢 → AI 只能说「糊成一团认不出来」。
// 阶梯必须**从大往小试**，让预算决定档位。
await test('大图压缩：字节与像素两个上限都要满足，且预算是决定档位的依据', async (h) => {
  const W = 4032, H = 3024;
  const raw = Buffer.alloc(W * H * 3);
  let seed = 7;
  // 2x2 的块状噪点：比 4x4 更难压，才够超过「原样投喂」阈值（8MB），从而真正走到压缩阶梯
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = seed & 0xff;
      for (let dy = 0; dy < 2 && y + dy < H; dy++) {
        for (let dx = 0; dx < 2 && x + dx < W; dx++) {
          const i = ((y + dy) * W + (x + dx)) * 3;
          raw[i] = v; raw[i + 1] = (v * 3) & 0xff; raw[i + 2] = (v * 7) & 0xff;
        }
      }
    }
  }
  const big = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 96 }).toBuffer();
  assert.ok(big.length > h.imagePassthroughBytes(), `测试图要超过原样阈值（实际 ${Math.round(big.length / 1024)}KB）`);
  const fitted = await h.fitMediaBuffer(big, 'https://x/car.jpg');
  assert.ok(fitted, '要能压出来');
  assert.ok(fitted.buffer.length <= h.imagePassthroughBytes(), `压完必须在字节安全区内（${Math.round(fitted.buffer.length / 1024)}KB）`);
  const px = fitted.longSide * fitted.longSide * (Math.min(W, H) / Math.max(W, H));
  assert.ok(px <= h.imageSoftPixels(), `压完必须在像素安全区内（${(px / 1e6).toFixed(2)}MP）`);
  assert.ok(fitted.longSide >= 1280, `安全区允许的前提下别压太狠（实际长边 ${fitted.longSide}）`);

  // 预算小的时候该更小：证明档位是被预算决定的，而不是固定值
  const tiny = await h.shrinkMediaBuffer(big, 300 * 1024);
  assert.ok(tiny && tiny.longSide < fitted.longSide, `预算 300KB 时应该更小（实际 ${tiny?.longSide}）`);
});

// 线上事故：QQ 手机直出照片 4.35MB，超过 4MB 的投喂上限，桥接直接把它丢掉，
// AI 只回「图我这边没取到」，用户连发三张都看不到。上限本身不能无限抬（模型/内存吃不下），
// 正确做法是**抓下来后本地压缩再投喂**。这条钉住：超限图必须能压到上限内，小图不做无谓重编码。
await test('超限图片会本地压缩后投喂，而不是直接判定「看不到」', async (h) => {
  const W = 4000, H = 3000;
  const raw = Buffer.alloc(W * H * 3);
  let seed = 12345;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff; // 噪点：让 JPEG 压不下去，才能造出超限图
    raw[i] = seed & 0xff;
  }
  const big = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
  assert.ok(big.length > h.MAX_MEDIA_BYTES, `测试图本身要超过上限（实际 ${big.length} > ${h.MAX_MEDIA_BYTES}）`);
  assert.ok(big.length < h.MAX_MEDIA_FETCH_BYTES, '测试图要在抓取上限内（否则会先被挡掉）');

  const fitted = await h.fitMediaBuffer(big);
  assert.ok(fitted, '超限图片应压缩成功，而不是返回 null');
  assert.ok(fitted.buffer.length <= h.imagePassthroughBytes(), `压缩后必须在原样阈值内（${fitted.buffer.length}）`);
  assert.equal(fitted.mimeType, 'image/jpeg', '压缩后统一成 JPEG');

  // 未超限的图原样返回（不重编码，避免透明/动图被破坏、也不白费 CPU）
  const smallRaw = raw.subarray(0, 300 * 200 * 3);
  const small = await sharp(smallRaw, { raw: { width: 300, height: 200, channels: 3 } }).jpeg({ quality: 70 }).toBuffer();
  const same = await h.fitMediaBuffer(small);
  assert.equal(same.buffer.length, small.length, '未超限时原样返回');
});

// 线上事故：玄真把同一个 QQ 动画表情发了三次，桥接一律显示成「[图片]」，
// AI 就把表情包当成照片，回了「这张图你今天发第二遍了，P图库是不是存重了」。
// 网关其实给了身份（sub_type=1 + summary="[动画表情]"），是桥接把它丢了。
await test('表情包（QQ 动画表情）不能被当成普通图片显示', async (h) => {
  assert.equal(h.imageSegmentLabel({ sub_type: 1, summary: '[动画表情]' }), '[动画表情]');
  assert.equal(h.imageSegmentLabel({ sub_type: 0, summary: '[图片]' }), '[图片]');
  assert.equal(h.imageSegmentLabel({ subType: 1 }), '[动画表情]', '下划线与驼峰字段都要认');
  assert.equal(h.imageSegmentLabel({}), '[图片]', '字段缺失时按普通图片兜底');
  const stickerText = await h.segmentsToText([{ type: 'image', data: { file: 'x.jpg', sub_type: 1, summary: '[动画表情]' } }]);
  assert.equal(stickerText, '[动画表情]', '消息文本要显示成动画表情');
  const photoText = await h.segmentsToText([{ type: 'image', data: { file: 'y.jpg', sub_type: 0, summary: '[图片]' } }]);
  assert.equal(photoText, '[图片]');
});
await test('表情包提示：告诉 AI 这是表情包、重复发很正常', async (h) => {
  h.setMode('reserved2');
  const hint = h.mediaHintFor('group:456', '123', [{ kind: 'image', file: 'a.jpg', label: '[动画表情]' }]);
  assert.match(hint, /表情包/, '要点明是表情包');
  assert.match(hint, /不要指出「你发过了/, '明确禁止「你发过了/存重了」这类话');
  const photoHint = h.mediaHintFor('group:456', '123', [{ kind: 'image', file: 'a.jpg', label: '[图片]' }]);
  assert.match(photoHint, /图片/);
  assert.ok(!/不要指出/.test(photoHint), '普通图片不该带上表情包那套说明');
});
await test('表情包身份随消息一起进入 AI 上下文（label/subType/summary）', async (h) => {
  h.setMode('reserved2');
  h.appendSocialV2Message('group:456', '玄真', '[动画表情]', '[动画表情]', false, false, 998877,
    [{ kind: 'image', file: 'CC3150002E5FFB86AD5D99A7F9B0C33F.jpg', url: 'https://example.invalid/x', subType: '1', summary: '[动画表情]', label: '[动画表情]' }],
    '2814656262', [], null, null);
  const st = h.getSocialV2State('group:456');
  const msg = st.recentMessages.find((m) => String(m.messageId) === '998877');
  assert.ok(msg, '消息应写进最近消息');
  assert.equal(msg.media[0].label, '[动画表情]', 'AI 必须能看到这是表情包');
  assert.equal(msg.media[0].subType, '1');
  assert.equal(msg.media[0].summary, '[动画表情]');
});
await test('唤醒提示里带上「表情包可以重复」的行为规则', async (h) => {
  h.setMode('reserved2');
  const prompt = h.buildWakePromptV2('group:456', 'message');
  assert.match(prompt, /【表情包可以重复】/);
  assert.match(prompt, /不要\*\*说「你发过了/);
});

// 线上事故：群友发消息后一直「会话繁忙，暂存唤醒原因」，AI 好几个小时不吭声。
// 根因不是 DSH 真在跑回合，而是**恢复机制漏了一条路径**：
// 暂存唤醒有 sendWakePromptV2 与 scheduleWakeV2 两条入口，群友消息走后者，
// 而看门狗只认 pendingSince —— 只有前者会写它。于是这个会话永远不被回收。
await test('真的在跑回合时只暂存，但必须写 pendingSince（看门狗兜底）', async (h) => {
  h.setMode('reserved2');
  const key = 'group:456';
  const st = h.getSocialV2State(key);
  const sid = 'session-running';
  h.state.sessions[key] = sid;
  h.v2TurnStartAt.set(sid, Date.now() - 20 * 60 * 1000);
  h.pendingWakeKeys.add(key); // 让 staleTurnMarkerV2 不判定为卡死（还有别的标记在）
  h.api.sessions.list = async () => ({ result: { ok: true, value: { items: [{ sessionId: sid, running: true }] } } });

  h.scheduleWakeV2(key, 'atMention');
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(Number(st.pendingSince) > 0, '暂存时必须写 pendingSince，否则看门狗永远不会回收这个会话');
  assert.equal(h.calls.prompts.length, 0, 'DST 真的在跑回合时不该强行投递');
});
await test('残留 turn 标记 + DSH 空闲：当场清掉并投递，不让群友等 8 分钟', async (h) => {
  h.setMode('reserved2');
  const key = 'group:456';
  const sid = 'session-stale';
  h.state.sessions[key] = sid;
  h.v2TurnStartAt.set(sid, Date.now() - 6 * 60 * 60 * 1000);
  h.api.sessions.list = async () => ({ result: { ok: true, value: { items: [{ sessionId: sid, running: false }] } } });

  h.scheduleWakeV2(key, 'atMention');
  // 注意：投递时 ensureSession 会新建 fixture 会话，所以只断言「有唤醒真的投出去了」。
  for (let i = 0; i < 100 && h.calls.prompts.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(h.calls.prompts.length > 0, '残留标记应被就地清掉并投递唤醒');
  assert.equal(h.v2TurnStartAt.has(sid), false, '残留 turn 标记应被清掉');
  assert.equal((h.socialV2.conversations.get(key)?.pendingWakeReasons ?? []).length, 0, '即时投递后不该再留重复的暂存意图');
});
await test('忙标记是 pendingWakeKey 残留时，DSH 报空闲也要能自救', async (h) => {
  h.setMode('reserved2');
  const key = 'group:456';
  const sid = 'session-stuck2';
  h.state.sessions[key] = sid;
  // pendingWakeKey 不在 staleTurnMarkerV2 的判定范围里（它是另一类标记），
  // 只能靠「DSH 明确报告空闲」这条兜底救回来——线上卡死的往往就是这种。
  h.pendingWakeKeys.add(key);
  h.api.sessions.list = async () => ({ result: { ok: true, value: { items: [{ sessionId: sid, running: false }] } } });

  h.scheduleWakeV2(key, 'speaker:玄真');
  for (let i = 0; i < 100 && h.calls.prompts.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(h.calls.prompts.length > 0, 'DSH 空闲时应清掉残留 pendingWakeKey 并投递');
  assert.equal(h.pendingWakeKeys.has(key), false, '残留 pendingWakeKey 应被清掉');
});

await test('陈旧暂存意图不该被更新的未读消息「顺带」补投', async (h) => {
  const st = { unread: [{ seq: 385 }, { seq: 384 }] };
  assert.equal(h.pendingWakeStillRelevantV2(st, { reason: 'atMention', seq: 384 }), true, '自己那条还在未读里 → 补投');
  assert.equal(h.pendingWakeStillRelevantV2(st, { reason: 'speaker:玄真', seq: 361 }), false, '老意图不能因为「有更新的未读」就复活');
  assert.equal(h.pendingWakeStillRelevantV2({ unread: [] }, { reason: 'x', seq: 1 }), false);
  assert.equal(h.pendingWakeStillRelevantV2(st, null), false, '旧字符串残留按不补投处理');
});

// 线上事故（2026-09-30）：AI 问「你活动在哪个镇」，玄真答「@哦鲸鲸 玉山镇」。
// 那条 seq452 落在 04:20:32 上一次 wait 返回、与 04:20:41 下一次 wait 开始之间的缝里：
// 不在上一次的 newMessages（那时还没到），也不在下一次的（baseline 取了「当前最新 seq」），
// 却躺在 unread 里——AI 只看 newMessages，收尾再 mark_read，这条就被静默清掉了。
await testWith(
  { config: { socialV2: { wait: { minQuietAfterNewMs: 0, minMs: 50, defaultMs: 100, maxMs: 5000 } } } },
  '两次 wait 之间到达的消息不会掉进缝里（玉山镇那次）',
  async (h) => {
    const server = h.startConsoleServer();
    try {
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      h.setMode('reserved2');
      const key = 'group:456';
      const st = h.getSocialV2State(key);
      // 上一批已经投给 AI（水位 451）；随后 452 在两次 wait 之间到达
      h.appendSocialV2Message(key, '玄真', '@哦鲸鲸 玉山镇', '@哦鲸鲸 玉山镇', false, false, 452000, [], '2814656262');
      const last = st.recentMessages[st.recentMessages.length - 1];
      last.seq = 452;
      st.unread[st.unread.length - 1].seq = 452;
      st.lastUnreadSeq = 452;
      st.deliveredSeq = 451;

      const res = await apiRequest(server, '/api/socialV2/wait?token=fixture-console-token', {
        body: { key, timeoutMs: 800, minNewMessages: 1, quietMs: 0 }, agentToken: st.agentToken
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.newMessages.some((m) => Number(m.seq) === 452), '缝里的那条必须补上，不能只在 unread 里躺着');
    } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
  }
);
await test('mark_read 不该把从没给 AI 看过的消息静默清掉', async (h) => {
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    h.setMode('reserved2');
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    st.wakeConfig.mode = 'active'; // 绕开沉睡前观察闸门，本用例只验证「会不会丢消息」
    h.appendSocialV2Message(key, '玄真', '@哦鲸鲸 玉山镇', '@哦鲸鲸 玉山镇', false, false, 452000, [], '2814656262');
    st.recentMessages[st.recentMessages.length - 1].seq = 452;
    st.unread[st.unread.length - 1].seq = 452;
    st.lastUnreadSeq = 452;
    st.deliveredSeq = 451; // 从没投给 AI

    const r1 = await apiRequest(server, '/api/socialV2/mark-read?token=fixture-console-token', { body: { key }, agentToken: st.agentToken });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.keptUnread, 1, '没看过的消息要保留，不能当作已读');
    assert.equal(st.unread.length, 1, '保留在未读里，下次还能补');
    assert.match(String(r1.body.note ?? ''), /玉山镇/, '回执要点名是哪条，AI 才会去看');

    // 真看过了（水位推进到 452）就正常清掉
    st.deliveredSeq = 452;
    const r2 = await apiRequest(server, '/api/socialV2/mark-read?token=fixture-console-token', { body: { key }, agentToken: st.agentToken });
    assert.equal(r2.body.markedCount, 1);
    assert.equal(st.unread.length, 0);
    assert.equal(r2.body.keptUnread, undefined, '看过的正常清，不该再保留');
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
});

// 控制台「表情包」分区：把 QQ 收藏夹镜像出来并做管理。
// 这里钉住三件事：① 本地备注（只给 AI 看）能写能读、且会进 AI 的列表；
// ② QQ 侧写操作（改名/置顶/删除）确实打到对应的 OneBot 动作，不是只改本地；
// ③ 带 agent token 的 AI 调用碰不到这些管理接口（AI 可以看图和记笔记，但不该能删管理员收藏）。
await test('表情包管理接口：本地备注 / QQ 备注 / 置顶 / 删除 / AI 不得越权', async (h) => {
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const T = 'token=fixture-console-token';
    const key = 'group:456';
    h.setMode('reserved2'); // AI 视角的列表接口只在二代模式允许该会话
    const st = h.getSocialV2State(key);

    // 列表（会先从 QQ 同步一次；FakeBot 的 fetch_custom_face_detail 返回 fixture-sticker）
    const list = await apiRequest(server, `/api/stickers?${T}`, { method: 'GET' });
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1, '同步到 1 个收藏表情');
    const id = list.body.stickers[0].id;
    assert.equal(id, 'fixture-sticker');
    assert.ok('localRemark' in list.body.stickers[0], '列表项带 localRemark 字段');

    // ① 本地备注：只写桥接，不动 QQ；但 AI 的列表要能看到
    const noted = await apiRequest(server, `/api/stickers/note?${T}`, {
      body: { stickerId: id, localRemark: '捂耳朵猫', tags: ['不想听', '无语'], note: '捂着耳朵装没听见', usage: '被念烦时用' }
    });
    assert.equal(noted.status, 200);
    assert.equal(noted.body.sticker.localRemark, '捂耳朵猫');
    assert.ok(!h.calls.ws.some((c) => c.action === 'modify_custom_face'), '改本地备注不该去动 QQ');
    const forAi = await apiRequest(server, `/api/socialV2/sticker-list?${T}&key=${encodeURIComponent(key)}`, { method: 'GET', agentToken: st.agentToken });
    assert.equal(forAi.status, 200);
    assert.ok(forAi.body.stickers.some((s) => s.localRemark === '捂耳朵猫'), 'AI 的列表里能拿到本地备注');

    // ② QQ 官方备注
    h.calls.ws.length = 0;
    const qq = await apiRequest(server, `/api/stickers/remark?${T}`, { body: { stickerId: id, remark: 'QQ备注' } });
    assert.equal(qq.status, 200);
    assert.ok(h.calls.ws.some((c) => c.action === 'modify_custom_face' && c.params?.emoji_id === id), '改 QQ 备注要走 modify_custom_face');
    assert.equal(qq.body.sticker.desc, 'QQ备注');

    // ② 置顶
    h.calls.ws.length = 0;
    const top = await apiRequest(server, `/api/stickers/promote?${T}`, { body: { stickerId: id } });
    assert.equal(top.status, 200);
    assert.ok(h.calls.ws.some((c) => c.action === 'move_custom_face_to_front'), '置顶要走 move_custom_face_to_front');

    // ② 删除：QQ 删成功后本地也要同步移除
    h.calls.ws.length = 0;
    const del = await apiRequest(server, `/api/stickers/delete?${T}`, { body: { stickerId: id } });
    assert.equal(del.status, 200);
    assert.ok(h.calls.ws.some((c) => c.action === 'delete_custom_face'), '删除要走 delete_custom_face');
    assert.equal(del.body.total, 0, '本地库要同步移除，不能留下「本地没了 QQ 还有 / 反过来」的错位');

    // ③ AI 越权：带 agent token 一律 403
    const denied = await apiRequest(server, `/api/stickers/delete?${T}`, { body: { stickerId: id }, agentToken: st.agentToken });
    assert.equal(denied.status, 403, 'AI 不能调用控制台表情管理接口');
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
});

// 线上事故（09-30）：有人发了个 QQ 视频，桥接整段忽略，AI 只能回「视频我这边打不开」。
// 视频段其实带着 file/url/thumb，以前一个都没记。这里钉住：段要认出来、提示要指向抽帧工具、
// 没有 ffmpeg 时要老实降级成封面（而不是假装能看）。
// 入站卡片：B站小程序卡/链接分享卡自带封面（card.preview）。
// 以前预览图只解析不接线，卡片在 AI 眼里就是一行文字，群里聊「封面就吓哭了」时
// 它只能回「封面发来看看」——数据明明就在消息里。
await test('入站卡片的预览图要挂成图片媒体，并在提示里点明是卡片封面', async (h) => {
  h.setMode('reserved2');
  const cardJson = JSON.stringify({
    app: 'com.tencent.structmsg',
    view: 'mini',
    meta: {
      detail_1: {
        title: '2026英雄联盟全球总决赛主题曲《KNOW MY NAME》',
        desc: '以我之名',
        preview: 'https://qq.ugcimg.cn/v1/cover-token/e9vf2tsqr6j29hl2kodb3vahlc',
        qqdocurl: 'https://b23.tv/K16z3SB',
      },
    },
  });
  const key = 'group:456';
  await h.handleIncoming('group', 456, {
    post_type: 'message', message_type: 'group',
    group_id: 456, user_id: 999, self_id: 1,
    message_id: 490001, message_seq: 9001,
    sender: { user_id: 999, card: '米哈游㍿', nickname: '米哈游' },
    message: [
      { type: 'json', data: { data: cardJson } },
      { type: 'text', data: { text: '封面就吓哭了' } },
    ],
  }, h.cfg);
  const msg = (h.getSocialV2State(key).recentMessages || []).at(-1);
  assert.ok(msg, '消息要入库');
  const cover = (msg.media || []).find((m) => m?.label === '[卡片封面]');
  assert.ok(cover, '卡片封面要作为媒体挂在消息上');
  assert.equal(cover.kind, 'image');
  assert.equal(cover.url, 'https://qq.ugcimg.cn/v1/cover-token/e9vf2tsqr6j29hl2kodb3vahlc', '封面 URL 要原样保留');
  const hint = h.mediaHintFor(key, msg.messageId, msg.media);
  assert.match(hint, /卡片封面图/, '提示要说清这是卡片封面，不是群友发的照片');
  assert.match(hint, /qq_get_message_images/, '提示要给出看图工具，否则 AI 不知道能看');
});

await test('视频段要被识别，且提示指向 qq_get_message_video', async (h) => {
  const media = h.extractMediaFromSegments([
    { type: 'text', data: { text: '看这个' } },
    { type: 'video', data: { file: 'abc.mp4', url: 'https://multimedia.nt.qq.com.cn/download?x=1', thumb: 'https://multimedia.nt.qq.com.cn/thumb?x=1' } }
  ]);
  assert.equal(media.length, 1, '要认出视频段');
  assert.equal(media[0].kind, 'video');
  assert.equal(media[0].file, 'abc.mp4');
  assert.ok(media[0].url.includes('multimedia.nt.qq.com.cn'), '要留下视频直链');
  assert.ok(media[0].thumb.includes('thumb'), '要留下封面');

  h.setMode('reserved2');
  const hint = h.mediaHintFor('group:456', '123', media);
  assert.match(hint, /qq_get_message_video/, '提示要直接给出抽帧工具');
  assert.match(hint, /没有语音转写/, '要提前说清听不到声音，免得 AI 编台词');
  const txt = await h.segmentsToText([{ type: 'video', data: { file: 'a.mp4' } }]);
  assert.equal(txt, '[视频]', '文本占位仍是 [视频]');
});
await test('ffmpeg 信息解析：从 -i 的 stderr 抠时长与分辨率', async (h) => {
  const sample = [
    'ffmpeg version 6.1.1 Copyright (c) 2000-2023 the FFmpeg developers',
    '  Duration: 00:01:23.46, start: 0.000000, bitrate: 1180 kb/s',
    '  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 720x1280, 1156 kb/s, 30 fps',
    '  Stream #0:1(und): Audio: aac (LC), 44100 Hz, stereo, fltp, 128 kb/s'
  ].join('\n');
  const info = h.parseVideoInfo(sample);
  assert.equal(Math.round(info.durationSec), 83, '时长解析（83.46s → 83）');
  assert.equal(info.width, 720);
  assert.equal(info.height, 1280);
  // 注意：harness 跑在 vm 里，跨 realm 的对象过不了 deepStrictEqual，只能逐字段比。
  const empty = h.parseVideoInfo('没有可解析内容的输出');
  assert.equal(empty.durationSec, 0, '解析不了要返回 0 而不是崩');
  assert.equal(empty.width, 0);
  assert.equal(empty.height, 0);
});
// 用 ffmpegPath='none' 显式关掉抽帧，这样用例不依赖「宿主机有没有装 ffmpeg」。
await testWith(
  { config: { socialV2: { video: { ffmpegPath: 'none' } } } },
  '本机没 ffmpeg 时视频工具老实降级（不假装能看）',
  async (h) => {
    const server = h.startConsoleServer();
    try {
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      h.setMode('reserved2');
      const key = 'group:456';
      const st = h.getSocialV2State(key);
      h.appendSocialV2Message(key, '米哈游㍿', '[视频]', '[视频]', false, true, 489000,
        [{ kind: 'video', file: 'a.mp4', url: 'https://public.invalid/a.mp4', thumb: 'https://public.invalid/a.jpg', label: '[视频]' }],
        '1472298635', [], null, null);
      const res = await apiRequest(server, `/api/images/message-video?token=fixture-console-token&key=${encodeURIComponent(key)}&messageId=489000`, {
        method: 'GET', agentToken: st.agentToken
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.kind, 'video');
      assert.equal(res.body.hasFfmpeg, false, '关掉抽帧后必须如实报告没有 ffmpeg');
      assert.match(String(res.body.note ?? ''), /ffmpeg/, 'note 要告诉管理员怎么装/怎么开');
      assert.match(String(res.body.note ?? ''), /没有语音转写/, '要重申听不到声音');

      // 没有视频段的消息不能装作有
      const none = await apiRequest(server, `/api/images/message-video?token=fixture-console-token&key=${encodeURIComponent(key)}&messageId=999999`, {
        method: 'GET', agentToken: st.agentToken
      });
      assert.equal(none.status, 200);
      assert.equal(none.body.frames.length, 0);
      assert.match(String(none.body.note ?? ''), /没有视频段|不是视频/, '要明确说这条没有视频段');
    } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
  }
);

// 「大一点的视频看不了」的根因：视频以前整段读进内存，上限写死 32MB。
// 现在必须走 safeFetchToFile（边下边落盘），并把配置里的抓取上限带下去。
const videoDownloadCalls = [];
const videoDownloadFixture = {
  safeFetchToFile: async (url, maxBytes, filePath) => {
    videoDownloadCalls.push({ url, maxBytes, filePath });
    fs.writeFileSync(filePath, Buffer.from('fake-not-a-video'));
    return { url, statusCode: 200, bytes: 18 };
  },
  safeFetchBuffer: async () => ({ url: 'https://public.invalid/b.jpg', statusCode: 200, buffer: PNG12 }),
};
await testWith(
  {
    globals: videoDownloadFixture,
    config: { socialV2: { video: { ffmpegPath: process.execPath, maxBytes: 12345678, fetchTimeoutMs: 120000 } } },
  },
  '聊天视频边下边落盘：按配置的上限下载，抽不出帧也要降级到封面',
  async (h) => {
    const server = h.startConsoleServer();
    try {
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      h.setMode('reserved2');
      const key = 'group:456';
      const st = h.getSocialV2State(key);
      h.appendSocialV2Message(key, '米哈游㍿', '[视频]', '[视频]', false, true, 489100,
        [{ kind: 'video', file: 'b.mp4', url: 'https://public.invalid/b.mp4', thumb: 'https://public.invalid/b.jpg', label: '[视频]' }],
        '1472298635', [], null, null);
      const res = await apiRequest(server, `/api/images/message-video?token=fixture-console-token&key=${encodeURIComponent(key)}&messageId=489100`, {
        method: 'GET', agentToken: st.agentToken
      });
      assert.equal(res.status, 200);
      const call = videoDownloadCalls.at(-1);
      assert.ok(call, '要真的走落盘下载，而不是把整段视频读进内存');
      assert.equal(call.maxBytes, 12345678, '必须用配置里的抓取上限，不能写死');
      assert.match(String(call.filePath), /video-tmp-.*in\.bin$/, '要落到临时目录的文件里');
      assert.ok(Array.isArray(res.body.frames) && res.body.frames.length >= 1, '抽不出帧要降级给封面，而不是整条失败');
    } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
  }
);

// 撞上限时的表现：老实说「下载失败 + 为什么」，并给封面兜底（AI 至少知道发生过什么）。
const videoTooLargeFixture = {
  safeFetchToFile: async () => { throw new Error('图片超过大小限制（12345678 字节）'); },
  safeFetchBuffer: async () => ({ url: 'https://public.invalid/c.jpg', statusCode: 200, buffer: PNG12 }),
};
await testWith(
  { globals: videoTooLargeFixture, config: { socialV2: { video: { ffmpegPath: process.execPath, maxBytes: 12345678 } } } },
  '视频超过抓取上限时如实说明并降级到封面',
  async (h) => {
    const server = h.startConsoleServer();
    try {
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      h.setMode('reserved2');
      const key = 'group:456';
      const st = h.getSocialV2State(key);
      h.appendSocialV2Message(key, '米哈游㍿', '[视频]', '[视频]', false, true, 489101,
        [{ kind: 'video', file: 'c.mp4', url: 'https://public.invalid/c.mp4', thumb: 'https://public.invalid/c.jpg', label: '[视频]' }],
        '1472298635', [], null, null);
      const res = await apiRequest(server, `/api/images/message-video?token=fixture-console-token&key=${encodeURIComponent(key)}&messageId=489101`, {
        method: 'GET', agentToken: st.agentToken
      });
      assert.equal(res.status, 200);
      const note = String(res.body.note ?? '');
      assert.match(note, /下载失败/, '要如实报告下载失败');
      assert.match(note, /大小限制/, '要把原因（超上限）带给管理员');
      assert.match(note, /封面/, '要说明降级成了封面');
      assert.ok(Array.isArray(res.body.frames) && res.body.frames.length >= 1, '拿不到帧也要给封面');
    } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
  }
);

// 被挑衅时可以还嘴：模型默认会往「礼貌 / 讲道理 / 我不跟你计较」上走，那不是这个角色。
// 这条许可以前哪都没有（preset、角色卡、唤醒提示全都不提），所以 AI 挨骂只会忍着或解释。
// 角色卡在二代**不是每轮注入**（只给名字，正文要 qq_get_prompt 才读到），
// 所以每轮唤醒提示里必须自带这一条，否则改了 preset 也得等会话重建才生效。
await test('唤醒提示里给出还嘴口径（默认幽默 + 贴吧老哥风 + 边界）', async (h) => {
  h.setMode('reserved2');
  const prompt = h.buildWakePromptV2('group:456', 'message');
  assert.match(prompt, /默认幽默/, '默认要幽默，别端着');
  assert.match(prompt, /贴吧老哥/, '真要还嘴时按贴吧老哥那一档');
  assert.match(prompt, /不碰家人、地域、性别、外貌、疾病/, '划出不能碰的靶子');
  assert.match(prompt, /对方收手/, '对方收手就停');
});
// 线上反馈：合并转发里明明有几十张图，AI 说「只能看到前五张」。
// 根因是**两层写死的 5**：MCP 工具 images.slice(0,5) + 桥接 fetchMediaData 的 MAX_MEDIA_COUNT=5。
// 光调一处没用。改成窗口式：能翻页、能报总数、单次上限可配（一次塞几十张会炸上下文）。
await test('合并转发图片：分页取、报总数、单次上限可配', async (h) => {
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    h.setMode('reserved2');
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    const T = 'token=fixture-console-token';
    const media = Array.from({ length: 12 }, (_, i) => ({ kind: 'image', file: `f${i}.jpg`, url: `https://public.invalid/${i}.jpg`, label: '[图片]' }));

    // 取第 6~9 张（offset=5, limit=4）
    const r1 = await apiRequest(server, `/api/socialV2/forward-media?${T}`, {
      body: { key, media, offset: 5, limit: 4 }, agentToken: st.agentToken
    });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.total, 12, '要报出总共有几张');
    assert.equal(r1.body.offset, 5);
    assert.equal(r1.body.limit, 4);
    assert.equal(r1.body.hasMore, true, '后面还有 3 张');
    assert.equal(r1.body.images.length, 4, '本次只给 4 张');
    // index 必须是「在整条转发里的序号」，否则 AI 翻页时会错位
    assert.equal(r1.body.images.map((x) => x.index).join(','), '6,7,8,9');

    // 取最后一窗
    const r2 = await apiRequest(server, `/api/socialV2/forward-media?${T}`, {
      body: { key, media, offset: 10, limit: 4 }, agentToken: st.agentToken
    });
    assert.equal(r2.body.images.length, 2, '只剩 2 张');
    assert.equal(r2.body.hasMore, false, '到尾了不能再翻');
    assert.equal(r2.body.images.map((x) => x.index).join(','), '11,12');

    // 单次上限要被压住（默认 maxImageLimit=20），不能一句话把几十张图全塞进上下文
    const many = Array.from({ length: 40 }, (_, i) => ({ kind: 'image', file: `g${i}.jpg`, url: `https://public.invalid/g${i}.jpg`, label: '[图片]' }));
    const r3 = await apiRequest(server, `/api/socialV2/forward-media?${T}`, {
      body: { key, media: many, offset: 0, limit: 999 }, agentToken: st.agentToken
    });
    assert.equal(r3.body.total, 40);
    assert.equal(r3.body.limit, 20, 'AI 传再大也压到 maxImageLimit');
    assert.equal(r3.body.images.length, 20);

    // 没有图片时不能崩
    const r4 = await apiRequest(server, `/api/socialV2/forward-media?${T}`, { body: { key, media: [] }, agentToken: st.agentToken });
    assert.equal(r4.status, 200);
    assert.equal(r4.body.total, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
});

// 批总量预算的旧行为是「一撞上限就整张丢」，于是手机照片一张 ~1MB、4MB 预算到第 5 张就全没了。
// 现在改成：撞上限先把这张压到剩余额度内；实在压不下（剩余 <40KB）才判定超限。
await test('批总量预算：撞上限先压小塞进去，而不是整张丢掉', async (h) => {
  const W = 1600, H = 1200;
  const raw = Buffer.alloc(W * H * 3);
  let seed = 999;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = seed & 0xff;
  }
  const big = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
  assert.ok(big.length > 300 * 1024, `造一张足够大的图（${big.length}）`);

  // 额度充足：原样返回（不做无谓重编码）
  const asIs = await h.fitBatchBudget(big, 0, 40 * 1024 * 1024);
  assert.equal(asIs.length, big.length, '额度充足时原样返回');

  // 额度紧张：应该压小后返回，而不是返回 null（旧行为就是丢）
  const budget = 200 * 1024;
  const shrunk = await h.fitBatchBudget(big, 0, budget);
  assert.ok(shrunk, '撞上限要能压出来，不能直接判超限');
  assert.ok(shrunk.length <= budget, `压到额度内（${shrunk.length} <= ${budget}）`);
  assert.ok(shrunk.length < big.length, '确实是压过的');

  // 剩余额度太小：压了也没法看，直接判超限
  assert.equal(await h.fitBatchBudget(big, 10 * 1024 * 1024, 10 * 1024 * 1024 + 10 * 1024), null, '剩余 <40KB 判超限');
});

// 控制台「表情包」分区的开关：socialV2.sticker.autoLabel。
// 关掉后唤醒提示里连欠账都不提，AI 自然不会再主动补；已经写好的备注不受影响。
// （提示层测，是因为「AI 会不会补」这件事**只由提示驱动**——线上实测它的推理会绕过弱提示。）
// source 用 manual：启动同步会清掉「不在 QQ 收藏列表里的 source=qq 条目」，
// 用 qq 的话这份预置数据一开机就被同步掉了，测不到东西。
const UNLABELED_FIXTURE = [
  { id: 'stk-a', resId: 'stk-a', url: 'https://x/a.jpg', md5: 'AAA', desc: '', localRemark: '', localNote: '', tags: [], source: 'manual' },
  { id: 'stk-b', resId: 'stk-b', url: 'https://x/b.jpg', md5: 'BBB', desc: '', localRemark: '', localNote: '', tags: [], source: 'manual' }
];
await testWith({ stickerState: UNLABELED_FIXTURE }, '自动补备注开关（默认开）：唤醒提示里有欠账与具体 id', async (h) => {
  h.setMode('reserved2');
  const prompt = h.buildWakePromptV2('group:456', 'message');
  assert.match(prompt, /还没有任何备注/, '默认要报出欠账');
  assert.match(prompt, /本次就补这 2 个/, '要给具体 id，别只给抽象指令');
});
await testWith(
  { stickerState: UNLABELED_FIXTURE, config: { socialV2: { sticker: { autoLabel: false } } } },
  '自动补备注开关（关）：唤醒提示里不再催，且不影响其它提示',
  async (h) => {
    h.setMode('reserved2');
    const prompt = h.buildWakePromptV2('group:456', 'message');
    assert.ok(!/还没有任何备注/.test(prompt), '关掉后不该再出现欠账');
    assert.match(prompt, /【可用表情包】/, '常规表情清单照旧');
    assert.match(prompt, /【此刻发表情包】/, '其它表情提示不受影响');
  }
);

// 控制台「让 AI 现在补一批」：手动触发，不用等它在空闲回合自己想起来。
// 它复用后台提醒通道（静默回合），所以这里既验端点行为，也顺手验重构后的
// /api/console/notify-ai 没被改坏——两条路径共用 notifyAiSession()。
await testWith({ stickerState: UNLABELED_FIXTURE }, '手动触发补备注：直接把具体 id 投给 AI，并有冷却', async (h) => {
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    h.setMode('reserved2');
    const T = 'token=fixture-console-token';

    const r1 = await apiRequest(server, `/api/stickers/autolabel-now?${T}`, { body: {} });
    assert.equal(r1.status, 200, r1.body?.error || '');
    // 默认 manualLabelCount=5，但库里只有 3 个欠账（2 个预置 + FakeBot 固定带的那个），所以实际问 3 个。
    assert.equal(r1.body.asked, 3, '默认一次补 5 个，但不会超过欠账数量');
    assert.equal(r1.body.key, 'group:456', '没指定会话时自动挑白名单里的群');
    assert.equal(r1.body.remaining, 0, '欠账一次问完了');
    assert.equal(r1.body.ids.length, 3, '要把具体 id 一并告诉调用方');

    // 真的投递了一条静默提醒，且内容自包含（带 id + 工具 + 不要发到群里）
    const prompt = h.calls.prompts.map((p) => (p.content?.[0]?.text ?? '')).join('\n---\n');
    assert.match(prompt, /后台控制端提醒/, '走的是后台提醒通道');
    assert.match(prompt, /stk-a/, '提醒里要直接给具体 id');
    assert.match(prompt, /qq_get_sticker_image/, '要给出看图的工具');
    assert.match(prompt, /qq_sticker_note/, '要给出写备注的工具');
    assert.match(prompt, /不要\*\*把进度发到群里|不要把进度发到群里/, '补备注是内部动作，别刷群');
    // 真事故：先把几张图看完再一起写 → 把 A 的描述写到 B 上（faker_憋笑 ↔ 柴郡猫猫_点赞）。
    assert.match(prompt, /一张一张来/, '手动提醒里也要要求看完一张立刻写掉');

    // 连点要有冷却（200 之后立刻再来一次应当是 429）
    const r2 = await apiRequest(server, `/api/stickers/autolabel-now?${T}`, { body: {} });
    assert.equal(r2.status, 429, '冷却期内应当拒绝，避免往队列里塞重复任务');

    // 重构后的后台提醒通道本身仍然可用
    const r3 = await apiRequest(server, `/api/console/notify-ai?${T}`, { body: { key: 'group:456', message: '测试后台提醒' } });
    assert.equal(r3.status, 200, r3.body?.error || '');
    assert.ok(r3.body.sessionId, '要回 sessionId');
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
});

// 「一次补几个」必须可调：默认 2 个太慢（线上 40+ 个欠账要跑二十来轮），
// 但也不能让它一次把几十张图塞进上下文，所以既有默认值也有硬上限。
const MANY_UNLABELED_FIXTURE = ['a', 'b', 'c', 'd', 'e'].map((i) => (
  { id: `stk-${i}`, resId: `stk-${i}`, url: `https://x/${i}.jpg`, md5: i.toUpperCase(), desc: '', localRemark: '', localNote: '', tags: [], source: 'manual' }
));
await testWith(
  { stickerState: MANY_UNLABELED_FIXTURE, config: { socialV2: { sticker: { manualLabelCount: 3 } } } },
  '手动触发补备注：一次几个由配置决定',
  async (h) => {
    const server = h.startConsoleServer();
    try {
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      h.setMode('reserved2');
      const r = await apiRequest(server, '/api/stickers/autolabel-now?token=fixture-console-token', { body: {} });
      assert.equal(r.status, 200, r.body?.error || '');
      assert.equal(r.body.asked, 3, 'manualLabelCount=3 时一次问 3 个');
      assert.equal(r.body.ids.length, 3);
      assert.equal(r.body.remaining, 3, '库里 6 个欠账（5 个预置 + FakeBot 那个），问完还剩 3');
    } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
  }
);
await testWith(
  { stickerState: MANY_UNLABELED_FIXTURE },
  '手动触发补备注：显式 count 优先，且不会超过该会话能承受的量',
  async (h) => {
    const server = h.startConsoleServer();
    try {
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      h.setMode('reserved2');
      const one = await apiRequest(server, '/api/stickers/autolabel-now?token=fixture-console-token', { body: { count: 1 } });
      assert.equal(one.body.asked, 1, 'body.count 优先于配置默认值');
    } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
  }
);
await testWith(
  { stickerState: MANY_UNLABELED_FIXTURE },
  '手动触发补备注：count 传很大也只到欠账数量，不会失控',
  async (h) => {
    const server = h.startConsoleServer();
    try {
      if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
      h.setMode('reserved2');
      const r = await apiRequest(server, '/api/stickers/autolabel-now?token=fixture-console-token', { body: { count: 999 } });
      assert.equal(r.body.asked, 6, '最多就是要补的欠账数（6 个），不会凭空要 999 个');
      assert.equal(r.body.remaining, 0);
    } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
  }
);

// 线上反馈：「多层合并转发，AI 只能看到最外面一层」。
// 真实数据：外层 2 条，其中第 1 条本身是一个 18 条的合并转发——而桥接原来只给「3 条 × 120 字」预览。
// 现在按层递归展开（默认 2 层）、每层给足条数，并且能翻页、能按嵌套 id 一层层查下去。
const fwdNode = (name, text, extra = []) => ({
  type: 'node',
  data: { name, uin: '10001', time: 1790000000, content: [{ type: 'text', data: { text } }, ...extra] }
});
const FORWARD_FIXTURES = {
  'f-outer': [
    fwdNode('绯色依琉', '[转发]', [{ type: 'forward', data: { id: 'f-inner' } }]),
    fwdNode('我说天狼星是对的', '骚婊子')
  ],
  // 内层 18 条（原来只看得见 3 条）
  'f-inner': Array.from({ length: 18 }, (_, i) => (
    (i === 0)
      ? fwdNode('路人甲', '里面还套了一层', [{ type: 'forward', data: { id: 'f-deep' } }])
      : fwdNode(`内层${i + 1}`, `内层第 ${i + 1} 条`)
  )),
  'f-deep': Array.from({ length: 5 }, (_, i) => fwdNode(`深层${i + 1}`, `最里层第 ${i + 1} 条`))
};
await testWith({ forwardFixtures: FORWARD_FIXTURES }, '多层合并转发：递归展开 + 能翻页 + 能按嵌套 id 继续查', async (h) => {
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    h.setMode('reserved2');
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    // 让这个 forward id 属于「本会话见过」，否则安全闸门会拒（真实路径也是这样）
    h.appendSocialV2Message(key, '某人', '[转发消息 id=f-outer]', '[转发消息 id=f-outer]', false, false, 500000, [], '10001', ['f-outer'], null, null);
    const T = 'token=fixture-console-token';
    const url = (extra = '') => `/api/socialV2/forward-message?${T}&key=${encodeURIComponent(key)}&id=f-outer${extra}`;

    const r1 = await apiRequest(server, url(), { method: 'GET', agentToken: st.agentToken });
    assert.equal(r1.status, 200, r1.body?.error || '');
    assert.equal(r1.body.total, 2, '本层 2 条');
    // 回归：URL 没传 limit 时曾经被 Number(null)=0 压成「只给 1 条」
    assert.equal(r1.body.messages.length, 2, '没传 limit 时要按配置默认给全（这条以前只给 1 条）');
    assert.equal(r1.body.hasMore, false, '本层 2 条已给完');
    // 关键：内层那 18 条要真的展开，而不是只给 3 条预览
    const inner = (r1.body.nestedPreviews || []).find((x) => x.id === 'f-inner');
    assert.ok(inner, '内层转主要被展开');
    assert.equal(inner.total, 18, '内层总数如实报出');
    assert.ok(inner.messages.length >= 10, `内层要给足条数（实际 ${inner.messages.length}）`);
    assert.ok(inner.messages.some((m) => m.text.includes('内层第 10 条')), '内层要给到第 10 条（原来只给 3 条）');
    assert.equal(inner.hasMore, true, '内层没给完要如实标 hasMore，AI 才知道还能翻');
    // 第三层（再套一层）也要展开到 children
    const deep = (inner.children || []).find((x) => x.id === 'f-deep');
    assert.ok(deep, '内层里再套的那层要出现在 children 里');
    assert.equal(deep.total, 5);
    assert.ok(deep.messages.some((m) => m.text.includes('最里层第 3 条')));
    // 明确告诉 AI 怎么继续
    assert.match(String(r1.body.note || ''), /nestedPreviews/, 'note 要说清嵌套展开在哪');
    assert.match(String(r1.body.note || ''), /把 id 换成嵌套里那个 id/, 'note 要说清怎么查某一层的完整内容');

    // 本层翻页：limit=1 时应给第 1 条 + hasMore
    const r2 = await apiRequest(server, url('&limit=1'), { method: 'GET', agentToken: st.agentToken });
    assert.equal(r2.body.messages.length, 1);
    assert.equal(r2.body.hasMore, true);
    assert.equal(r2.body.messages[0].index, 1, 'index 是绝对序号');
    const r3 = await apiRequest(server, url('&limit=1&offset=1'), { method: 'GET', agentToken: st.agentToken });
    assert.equal(r3.body.messages[0].index, 2, '翻页后 index 不错位');
    assert.equal(r3.body.hasMore, false);

    // 直接用嵌套 id 查它的完整内容（安全闸门要放行——它被 remember 过）
    const r4 = await apiRequest(server, `/api/socialV2/forward-message?${T}&key=${encodeURIComponent(key)}&id=f-inner&limit=100`, { method: 'GET', agentToken: st.agentToken });
    assert.equal(r4.status, 200, r4.body?.error || '');
    assert.equal(r4.body.total, 18);
    assert.equal(r4.body.messages.length, 18, '按嵌套 id 查能拿到全部 18 条');
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
});

// 图片投喂安全区的**反向回归**（2026-10-15）：曾经为了「少压一点、细节更好」把原样投喂阈值放宽到 8MB，
// 结果 owner 那张 7.4MB / 4096x3072 的图被原样投给 DSH，DSH 读图爆栈：
//   [image unavailable: image/jpeg; Maximum call stack size exceeded; …]
// 模型收到「图不可用」，用户看到「读图那步报错了」。所以字节与像素两个维度都必须卡住安全区。
await test('图片投喂安全区：超 1.5MB 或 2.5MP 必须重编码（DSH 读大图会爆栈）', async (h) => {
  const W = 1920, H = 2560;
  const raw = Buffer.alloc(W * H * 3);
  let seed = 4242;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = seed & 0xff;
  }
  // 1920x2560 = 4.9MP / 2.3MB：两个维度都超安全区 → 必须重编码
  const midJpeg = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
  assert.ok(midJpeg.length > h.imagePassthroughBytes(), `测试图要超字节安全区（实际 ${Math.round(midJpeg.length / 1024)}KB）`);
  assert.ok(W * H > h.imageSoftPixels(), '测试图也要超像素安全区');
  const kept = await h.fitMediaBuffer(midJpeg, 'https://x/a.jpg');
  assert.ok(kept, '要能压出来');
  assert.ok(kept.buffer.length <= h.imagePassthroughBytes(), `压到字节安全区内（${Math.round(kept.buffer.length / 1024)}KB）`);
  const keptPixels = kept.longSide * kept.longSide * (Math.min(W, H) / Math.max(W, H));
  assert.ok(keptPixels <= h.imageSoftPixels(), `压到像素安全区内（${(keptPixels / 1e6).toFixed(2)}MP）`);
  assert.ok(kept.longSide < Math.max(W, H), '必须真的降了分辨率');

  // 安全区内的小图原样返回
  const small = await sharp(raw.subarray(0, 320 * 240 * 3), { raw: { width: 320, height: 240, channels: 3 } }).jpeg({ quality: 70 }).toBuffer();
  const same = await h.fitMediaBuffer(small, 'https://x/b.jpg');
  assert.equal(same.buffer.length, small.length, '安全区内原样返回');
});

// 整蛊/钓鱼：模型默认会老实地纠正/自证，那正好是对方要的效果。
// 这条和「被挑衅可以骂回去」是同类策略（给许可 + 划边界），所以都写在每轮唤醒提示里。
await test('唤醒提示里明确允许「被整蛊不用老实答」并划了边界', async (h) => {
  h.setMode('reserved2');
  const prompt = h.buildWakePromptV2('group:456', 'message');
  assert.match(prompt, /【被整蛊不用老实答】/, '要给明确许可');
  assert.match(prompt, /不必按字面回答/, '要说清可以不老实答');
  assert.match(prompt, /顺着演、反手整回去/, '给出具体做法');
  assert.match(prompt, /最忌讳一本正经地纠正/, '点明「认真纠正」正是对方要的效果');
  assert.match(prompt, /真问事（尤其技术\/事实问题）就好好答/, '不能变成偷懒借口');
  assert.match(prompt, /别拿「整蛊」当偷懒借口/, '同上，措辞要够硬');
  assert.match(prompt, /别升级成骂战/, '整回去≠骂战');
  assert.match(prompt, /不配合造谣\/违法\/伤害第三方的坑/, '不配合害人的坑');
  assert.match(prompt, /别把整蛊问题当知识存进群知识库/, '整蛊问题不能被沉淀成知识');
  assert.match(prompt, /已经被耍了\/答错了/, '答错之后也不用老实认错复盘');
  assert.match(prompt, /你上钩了/, '给出嘴硬/反整的具体说法');
});

// 线上统计出来的「AI 味」三个显性特征：破折号 18.7%（群友 0%）、「行，」开场 5.5%（群友 0%）、
// 平均 40 字（群友 9.7 字）。模型自己不会觉得这些有问题，必须每轮点名禁掉。
// 顺带：提示文本本身以前也满是破折号（在示范这种句式），已经一起清干净。
await test('反公式化：唤醒提示点名禁用破折号与发语词，并要求短句', async (h) => {
  h.setMode('reserved2');
  const prompt = h.buildWakePromptV2('group:456', 'message');
  assert.match(prompt, /【别用这些公式化句式】/);
  assert.match(prompt, /不要用破折号/, '破折号要明确禁掉（写法上不能用字面破折号，否则等于在示范）');
  assert.match(prompt, /「行，」「好的，」「所以」「其实，」/, '点名具体发语词');
  assert.match(prompt, /不是……而是……/, '对偶腔也要禁');
  assert.match(prompt, /群友平均 10 个字/, '要用「群友平均 10 字」这种可感的事实说短句');
  assert.match(prompt, /看\*\*群里真人怎么打字\*\*|群里真人怎么打字/, '要求参考群友语感');
  // 规则文本自己不能出现字面破折号：一边禁一边示范，模型只会学样（真实踩过）。
  assert.equal((prompt.match(/——/g) || []).length, 0, '唤醒提示里不能有字面破折号');
});

// 群里聊得热闹但没自己的事时：发一张贴气氛的表情包冒泡，比硬接一句或直接消失都自然。
await test('没人理时可以发表情包冒泡（提示里要有这个出口）', async (h) => {
  h.setMode('reserved2');
  const prompt = h.buildWakePromptV2('group:456', 'message');
  assert.match(prompt, /没人理你时用表情包冒泡|没人理你时可以发张表情包冒泡|发一张\*\*对得上当下气氛\*\*的表情包/, '要给「用表情包冒泡」这个出口');
  assert.match(prompt, /别把情绪配反|别配反情绪/, '选图要贴气氛');
});

// 有些消息 @ 某个人比引用更合适（答他的问题、cue 他、把话抛给他）。
await test('回复某个人时可以用 atUserId 点名', async (h) => {
  h.setMode('reserved2');
  const prompt = h.buildWakePromptV2('group:456', 'message');
  assert.match(prompt, /atUserId/, '要提到点名工具');
  assert.match(prompt, /要回的是某个人/, '说清什么场景该点名');
  assert.match(prompt, /别每条都 @/, '别滥用');
});

// 复读是群聊常见玩法：不该惊讶/质疑，合适时自己也可以跟着复。
await test('复读是正常玩法：不许惊讶质疑，允许跟着复', async (h) => {
  h.setMode('reserved2');
  const prompt = h.buildWakePromptV2('group:456', 'message');
  assert.match(prompt, /【复读是正常玩法】/);
  assert.match(prompt, /不要惊讶也不要问/, '先禁掉「你们怎么都在复读」这种扫兴反应');
  assert.match(prompt, /也可以跟着复读一句/, '要给「自己也能复读」的许可');
  assert.match(prompt, /别硬凑|看着就行/, '别逢复读就凑');
});

// 梗图 / 转发消息的内容常是反串玩梗，不是有人在陈述事实。
await test('梗图/转发消息要按反串玩梗甄别，别当成待核实事实', async (h) => {
  h.setMode('reserved2');
  const prompt = h.buildWakePromptV2('group:456', 'message');
  assert.match(prompt, /【梗图\/转发消息多为反串玩梗】/);
  assert.match(prompt, /不是有人在跟你陈述事实/, '说清误判点');
  assert.match(prompt, /不要当成待核实的信息/, '别去求证/纠正');
  assert.match(prompt, /只有对方明确在跟你求证事实时才认真答/, '真求证还是要答');
  assert.match(prompt, /别把梗图\/转发里的说法当成事实写进轻量记忆或群知识库/, '不许把梗图内容当知识沉淀');
});

// 线上事故：群友发的挥拳贴纸是透明底 PNG，压成 JPEG 后透明区变成纯黑，
// 深色手臂在黑底上消失，只剩一颗白球，AI 回「拳头糊成一颗球了」。
await test('透明图片压缩后不能变成黑底', async (h) => {
  // 左半透明、右半不透明黑色——透明区若被压成黑色，整张图就糊成一团黑。
  const transparent = await sharp({
    create: { width: 120, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
  }).composite([{
    input: await sharp({ create: { width: 60, height: 120, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } } }).png().toBuffer(),
    left: 60, top: 0
  }]).png().toBuffer();
  const shrunk = await h.shrinkMediaBuffer(transparent, 200 * 1024);
  assert.ok(shrunk, '透明图应该压得出来');
  assert.notEqual(shrunk.mimeType, 'image/jpeg', '有透明通道的图不能压成 JPEG（透明区会变纯黑）');
  const meta = await sharp(shrunk.buffer).metadata();
  assert.ok(meta.hasAlpha, '压缩后应当仍然带 alpha');
  const { data, info } = await sharp(shrunk.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const corner = [data[0], data[1], data[2], data[3]];
  assert.equal(corner[3], 0, `左上角原本是全透明，压缩后不该变成不透明（实际 rgba=${corner.join(',')}）`);
  // 兜底路径（保不住透明时）必须压白底，不能是默认黑底。
  const flattened = await sharp(transparent).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
  const fm = await sharp(flattened).raw().toBuffer({ resolveWithObject: true });
  assert.ok(fm.data[0] > 240 && fm.data[1] > 240 && fm.data[2] > 240, '白底兜底应当是白，不是黑');
});

// 线上事故：27 帧的「兔耳蹲着」动图只取第一帧，AI 把静止蹲姿当整张表情描述。
await test('动图抽多帧投喂，不再只给第一帧', async (h) => {
  // 2 帧动图（红→蓝）的固定字节：sharp 0.33 不能合成动图，ffmpeg 不是测试依赖，
  // 所以直接内嵌一份最小 GIF，保证这条回归离线也能跑。
  const ANIM_GIF_B64 = 'R0lGODlhMAAwAPf/MQAA/wCAAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAAD/ACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFBAADACwAAAAAMAAwAIEAAP8AgAD/AAAA/wAITwAFCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh2qMSAAIfkEBQQA/wAsAAAAADAAMAAACE8AAQgcSLCgwYMIEypcyLChw4cQI0qcSLGixYsYM2rcyLGjx48gQ4ocSbKkyZMoU6pcybKly5cwY8qcSbOmzZs4c+rcybOnz59AgwodqjEgADs=';
  const gif = Buffer.from(ANIM_GIF_B64, 'base64');
  const meta = await h.probeImageMeta(gif);
  assert.equal(meta.frames, 2, '测试用动图应当被识别为 2 帧');
  const parts = await h.normalizeImageForVision(gif);
  assert.equal(parts.length, 2, `动图要抽成多帧（实际 ${parts.length}）`);
  for (const [i, part] of parts.entries()) {
    assert.match(part.frameText, new RegExp(`第 ${i + 1}/2 帧`), '每帧要标明是第几帧');
    assert.ok(part.buffer?.length, '帧内容不能为空');
  }
  // 抽出来的帧要真的是不同画面，否则等于只喂了第一帧。
  const first = await sharp(parts[0].buffer).raw().toBuffer();
  const last = await sharp(parts[1].buffer).raw().toBuffer();
  assert.notDeepEqual([...first], [...last], '抽出来的首末帧必须不同，否则说明抽的还是同一帧');
  // 静态图仍然是 1 张，不能被误判成动图。
  const still = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
  assert.equal((await h.normalizeImageForVision(still)).length, 1, '静态图不该被抽成多帧');
});

// 动图在提示里要写明「工具会返回多帧」，否则 AI 只看第一帧就下结论。
await test('媒体提示要提醒可能是动图', async (h) => {
  h.setMode('reserved2');
  const hint = h.mediaHintFor('group:1', '42', [{ kind: 'image', label: '[动画表情]', file: 'x.gif' }]);
  assert.match(hint, /动图/, '要提到动图');
  assert.match(hint, /别只看第一帧/, '要明确别只看第一帧');
});

// 多帧是同一个表情的不同瞬间，不是「你发了好几张图」。
await test('唤醒提示要说清多帧是同一个表情', async (h) => {
  h.setMode('reserved2');
  const prompt = h.buildWakePromptV2('group:456', 'message');
  assert.match(prompt, /动图会一次给你好几帧/, '要预告多帧');
  assert.match(prompt, /同一个表情/, '要说清多帧属于同一个表情');
  assert.match(prompt, /别只看第一帧就下结论/, '禁止只看第一帧');
});

// 掉线补拉的回归测试（用假网关历史，不走网络）。
// 背景：OneBot 是推送模型，断线期间群里发的消息网关不会重发。实测 2026-10-05
// 23:20–23:26 一次 WS 抖动丢了 5 条，AI 完全不知道它们存在过。
const BF_BOT = 2840404638;
function histMsg(seq, text, { userId = 2814656262, id = null } = {}) {
  return {
    time: Math.floor(Date.now() / 1000) - 60,
    message_type: 'group',
    message_id: id ?? (1000000 + seq),
    message_seq: seq,
    group_id: 456,
    user_id: userId,
    sender: { user_id: userId, nickname: '玄真', card: '' },
    message: [{ type: 'text', data: { text } }],
    raw_message: text
  };
}

await testWith({
  config: { socialV2: { backfill: { enabled: true, maxMessages: 100, wakeMaxMessages: 15, wakeMaxAgeMs: 600000 } } },
  history: { group: { 456: [histMsg(101, '断线期间第一条'), histMsg(102, '断线期间第二条'), histMsg(103, '断线期间第三条')] } }
}, '掉线补拉：断线期间漏掉的消息能补回来', async (h) => {
  h.setMode('reserved2');
  const st = h.getSocialV2State('group:456');
  st.lastGwSeq = 100;
  st.recentMessages = [{ seq: 1, gwSeq: 100, messageId: '999', sender: '玄真', text: '断线前最后一条', time: Date.now() - 300000 }];
  st.unread = [];
  st.lastUnreadSeq = 1;
  const r = await h.backfillMissedMessages('test');
  assert.equal(r.added, 3, `应该补回 3 条（实际 ${r.added}）`);
  const texts = st.recentMessages.map((m) => m.text);
  assert.ok(texts.includes('断线期间第一条') && texts.includes('断线期间第三条'), '三条都要进上下文');
  assert.ok(texts.includes('断线前最后一条'), '原有消息不能丢');
  assert.equal(st.lastGwSeq, 103, 'lastGwSeq 要推进到最新');
  assert.ok(st.recentMessages.every((m) => m.backfilled !== true || m.gwSeq), '补回的消息要带 gwSeq');
  // 归位：补回的消息时间更早，必须排在「断线后新收到的那条」前面
  const order = st.recentMessages.map((m) => m.text);
  assert.ok(order.indexOf('断线前最后一条') < order.indexOf('断线期间第一条'), '按时间归位，不能直接 append');
});

// 线上事故（2026-10-15 14:46 私聊）：会话重建（DSH 重启）时桥接轮换了 agent token 并立刻撤销旧的，
// 但**已经在跑的那个回合手里还是旧令牌** → 它所有工具调用被拒（"agent token 无效"），连发消息都失败，
// 用户看到的就是「机器人哑了」。旧令牌本来就属于同一会话，给 30 分钟宽限期。
await test('会话重建后旧令牌要有宽限期（否则在跑的那个回合会全废）', async (h) => {
  h.setMode('reserved2');
  const key = 'group:456';  // 用白名单内的群（private:456 不在装置白名单里，唤醒会被跳过）
  const st = h.getSocialV2State(key);
  // 先真建一个会话（retireSession 只对「有会话」的会话做事）
  await h.sendWakePromptV2(key, 'admin').catch(() => {});
  const oldToken = String(st.agentToken);
  assert.equal(h.agentTokenOk(key, oldToken), true, '当前令牌当然可用');

  h.retireSession(key); // 不带 keepIdentity → 轮换令牌
  assert.notEqual(String(st.agentToken), oldToken, '令牌要换新');
  assert.equal(h.agentTokenOk(key, String(st.agentToken)), true, '新令牌可用');
  assert.equal(h.agentTokenOk(key, oldToken), true, '旧令牌在宽限期内仍然可用（在跑的回合靠它）');
  assert.equal(h.agentTokenOk(key, 'deadbeef'.repeat(4)), false, '陌生令牌依然拒绝');

  // 宽限期过后旧令牌失效
  st.prevAgentTokens = [{ token: oldToken, until: Date.now() - 1000 }];
  assert.equal(h.agentTokenOk(key, oldToken), false, '宽限期过后必须失效');
});

// 线上事故（2026-10-15 13:23）：owner 在故障窗口发了「hi」，网关恢复后桥接补拉却报「没有缺口」。
// 查证：这个网关的 message_seq **不是按会话单调递增**的（私聊里 10/11 的文件是 59884，今天的 hi 才 35758），
// 而旧逻辑用「见过的最大 seq」当水位 → 比它小的新消息被永久过滤掉。
// 而且 get_*_msg_history 对 message_seq 参数无效（传什么都返回最近 N 条）。所以必须按 message_id + 时间判。
await testWith({
  config: { socialV2: { backfill: { enabled: true, wakeMaxMessages: 15, wakeMaxAgeMs: 600000 } } },
  history: {
    private: {
      123: [{
        time: Math.floor(Date.now() / 1000) - 30,
        message_type: 'private',
        message_id: 'hi-35758',
        message_seq: 35758,           // 比水位 59884 小——旧代码就是在这里把它丢掉的
        user_id: 999,
        sender: { user_id: 999, nickname: 'owner' },
        message: [{ type: 'text', data: { text: 'hi' } }],
        raw_message: 'hi',
      }],
    },
  },
}, '掉线补拉：message_seq 不单调时也要能补到（不能拿最大 seq 当水位）', async (h) => {
  h.setMode('reserved2');
  const st = h.getSocialV2State('private:123');
  st.lastGwSeq = 59884; // 被一条更早、seq 更大的消息顶上去的水位
  st.recentMessages = [{ seq: 70, gwSeq: 51993, messageId: 'old-1', sender: 'owner', text: '这个是什么角色', time: Date.now() - 6 * 3600 * 1000 }];
  st.unread = [];
  st.lastUnreadSeq = 70;
  const r = await h.backfillMissedMessages('test');
  assert.equal(r.added, 1, `比水位小的新消息也要补回来（实际 added=${r.added}）`);
  assert.ok(st.recentMessages.some((m) => m.text === 'hi'), '补回的内容要进上下文');
  assert.ok(r.woken.includes('private:123'), '少且新 → 要唤醒 AI 去看');
  // 再跑一次不能重复补
  assert.equal((await h.backfillMissedMessages('test2')).added, 0, '第二次应去重');
});

// 线上事故（2026-10-15）：owner 13:23 发的「hi」落在网关故障窗口里，13:54 恢复后补进了上下文，
// 但因为超过 10 分钟闸门「只入库不唤醒」→ AI 从没被叫起来看它，用户看到的就是「没响应」。
// 私聊是有人直接找它，闸门要放宽（群里刷屏的旧账仍然只入库）。
await testWith({
  config: { socialV2: { backfill: { enabled: true, wakeMaxMessages: 15, wakeMaxAgeMs: 600000 } } },
  history: {
    private: {
      123: [{
        time: Math.floor(Date.now() / 1000) - 40 * 60,   // 40 分钟前：超过群里那套 10 分钟闸门
        message_type: 'private',
        message_id: 'old-private-1',
        message_seq: 900,
        user_id: 999,
        sender: { user_id: 999, nickname: 'owner' },
        message: [{ type: 'text', data: { text: 'hi' } }],
        raw_message: 'hi',
      }],
    },
  },
}, '掉线补拉：私聊漏掉的消息即使过了 10 分钟也要唤醒（群里仍然只入库）', async (h) => {
  h.setMode('reserved2');
  const st = h.getSocialV2State('private:123');
  st.lastGwSeq = 0;
  st.recentMessages = [];
  st.unread = [];
  const r = await h.backfillMissedMessages('test');
  assert.equal(r.added, 1, '要补回来');
  assert.ok(r.woken.includes('private:123'), '私聊要唤醒 AI 去看（否则就是「没响应」）');
  assert.ok((st.unread ?? []).some((m) => m.text === 'hi'), '要进未读，AI 起来才看得到');
});

// 线上事故（2026-10-15 群 1050666134）：故障窗口里漏了 6 条**比本地最新一条更早**的消息
// （11:20~13:21），而本地最新一条是 14:03。用「本地最新一条」当时间锚点会永远补不到这种中间缺口。
await testWith({
  config: { socialV2: { backfill: { enabled: true, maxAgeMs: 6 * 3600 * 1000 } } },
  history: {
    group: {
      456: [
        { ...histMsg(201, '你崩了是什么原因'), time: Math.floor(Date.now() / 1000) - 2 * 3600 },
        { ...histMsg(202, '看来确实崩了'), time: Math.floor(Date.now() / 1000) - 2 * 3600 + 60 },
      ],
    },
  },
}, '掉线补拉：中间缺口（比本地最新一条更早）也要补上', async (h) => {
  h.setMode('reserved2');
  const st = h.getSocialV2State('group:456');
  st.lastGwSeq = 9999;
  // 本地已有更新的一条（5 分钟前），缺口在它之前
  st.recentMessages = [{ seq: 1, gwSeq: 9999, messageId: 'newer-1', sender: '玄真', text: '睡醒了没', time: Date.now() - 5 * 60 * 1000 }];
  st.unread = [];
  const r = await h.backfillMissedMessages('test');
  assert.equal(r.added, 2, `中间缺口也要补（实际 ${r.added}）`);
  const texts = st.recentMessages.map((m) => m.text);
  assert.ok(texts.includes('你崩了是什么原因') && texts.includes('看来确实崩了'), '两条都要进上下文');
  // 超过群里的 10 分钟唤醒闸门 → 只入库，不叫醒（别对两小时前的旧账刷屏）
  assert.ok(!r.woken.includes('group:456'), '两小时前的旧账不该唤醒');
});

await testWith({
  config: { socialV2: { backfill: { enabled: true } } },
  history: { group: { 456: [histMsg(101, 'A'), histMsg(102, 'B')] } }
}, '掉线补拉：重复调用不会补第二次', async (h) => {
  h.setMode('reserved2');
  const st = h.getSocialV2State('group:456');
  st.lastGwSeq = 100;
  st.recentMessages = []; st.unread = []; st.lastUnreadSeq = 0;
  assert.equal((await h.backfillMissedMessages('t1')).added, 2, '第一次应补 2 条');
  assert.equal((await h.backfillMissedMessages('t2')).added, 0, '第二次应补 0 条（已去重）');
  const n = st.recentMessages.filter((m) => m.text === 'A' || m.text === 'B').length;
  assert.equal(n, 2, '不能补出重复消息');
});

await testWith({
  config: { socialV2: { backfill: { enabled: true } } },
  history: { group: { 456: [histMsg(101, '别人发的'), histMsg(102, '机器人自己发的', { userId: BF_BOT })] } }
}, '掉线补拉：过滤掉机器人自己发的消息', async (h) => {
  h.setMode('reserved2');
  const st = h.getSocialV2State('group:456');
  st.lastGwSeq = 100; st.recentMessages = []; st.unread = []; st.lastUnreadSeq = 0;
  const r = await h.backfillMissedMessages('test');
  assert.equal(r.added, 1, `只该补别人那条（实际 ${r.added}）`);
  assert.equal(st.recentMessages.filter((m) => m.text === '机器人自己发的').length, 0, '自己发的不该进上下文');
});

await testWith({
  config: { socialV2: { backfill: { enabled: true, wakeMaxMessages: 15, wakeMaxAgeMs: 600000 } } },
  history: { group: { 456: [histMsg(101, '刚漏的一条')] } }
}, '掉线补拉：少且新 → 唤醒 AI', async (h) => {
  h.setMode('reserved2');
  const st = h.getSocialV2State('group:456');
  st.lastGwSeq = 100; st.recentMessages = []; st.unread = []; st.lastUnreadSeq = 0;
  const r = await h.backfillMissedMessages('test');
  assert.equal(r.added, 1);
  assert.equal(r.woken.length, 1, '1 条且很新，应当唤醒');
  assert.equal(String(r.woken[0]), 'group:456', '唤醒的应当是 group:456');
});

await testWith({
  config: { socialV2: { backfill: { enabled: true, wakeMaxMessages: 2, wakeMaxAgeMs: 600000 } } },
  history: { group: { 456: [histMsg(101, 'a'), histMsg(102, 'b'), histMsg(103, 'c'), histMsg(104, 'd')] } }
}, '掉线补拉：补回太多 → 只入库不唤醒（别对旧账刷屏）', async (h) => {
  h.setMode('reserved2');
  const st = h.getSocialV2State('group:456');
  st.lastGwSeq = 100; st.recentMessages = []; st.unread = []; st.lastUnreadSeq = 0;
  const r = await h.backfillMissedMessages('test');
  assert.equal(r.added, 4, '仍然要入库拿上下文');
  assert.equal(r.woken.length, 0, '超过唤醒闸门就不该唤醒');
});

await testWith({
  config: { socialV2: { backfill: { enabled: true, wakeMaxMessages: 15, wakeMaxAgeMs: 60000 } } },
  history: { group: { 456: [
    { ...histMsg(101, '很久以前漏的'), time: Math.floor(Date.now() / 1000) - 7200 }
  ] } }
}, '掉线补拉：够旧 → 只入库不唤醒', async (h) => {
  h.setMode('reserved2');
  const st = h.getSocialV2State('group:456');
  st.lastGwSeq = 100; st.recentMessages = []; st.unread = []; st.lastUnreadSeq = 0;
  const r = await h.backfillMissedMessages('test');
  assert.equal(r.added, 1, '旧消息也要入库');
  assert.equal(r.woken.length, 0, '两小时前的消息不该唤醒 AI');
});

await testWith({
  config: { socialV2: { backfill: { enabled: true } } },
  history: { group: { 456: [histMsg(101, 'A', { id: 'known-1' }), histMsg(102, 'B'), histMsg(103, 'C')] } }
}, '掉线补拉：基线播种（重启后也能补）', async (h) => {
  h.setMode('reserved2');
  const st = h.getSocialV2State('group:456');
  // 没有 lastGwSeq，但历史里有一条我们已认识的 messageId → 拿它当基线
  st.lastGwSeq = undefined;
  st.recentMessages = [{ seq: 5, messageId: 'known-1', sender: '玄真', text: 'A', time: Date.now() - 60000 }];
  st.unread = []; st.lastUnreadSeq = 5;
  const r = await h.backfillMissedMessages('restart');
  assert.equal(st.lastGwSeq, 103, '基线播种后应推进到最新');
  assert.equal(r.added, 2, `基线之后的两条要补回来（实际 ${r.added}）`);
});

await testWith({
  config: { socialV2: { backfill: { enabled: false } } },
  history: { group: { 456: [histMsg(101, 'A')] } }
}, '掉线补拉：开关关闭时什么都不做', async (h) => {
  h.setMode('reserved2');
  const st = h.getSocialV2State('group:456');
  st.lastGwSeq = 100; st.recentMessages = []; st.unread = []; st.lastUnreadSeq = 0;
  const r = await h.backfillMissedMessages('test');
  assert.equal(r.added, 0, '关掉就该一条都不补');
  assert.equal(st.recentMessages.length, 0);
});


// 唤醒提示里的禁则必须写成「一个都不要用」，不能是「别老用」——
// 线上实测「别老用」被模型读成「偶尔用没关系」，规则挂了一轮「行，」照样一天出现两次。
await test('反公式化：发语词与总结标签要绝对禁，不能写成「别老用」', async (h) => {
  h.setMode('reserved2');
  const prompt = h.buildWakePromptV2('group:456', 'message');
  assert.match(prompt, /下列写法一个都不要用/, '要写成绝对禁止');
  assert.ok(!/开场别老用/.test(prompt), '不能再留「别老用」这种软措辞');
  assert.match(prompt, /「行，」「好的，」「所以」/, '点名具体发语词');
  assert.match(prompt, /总结标签/, '总结标签要单列');
  assert.match(prompt, /「总结：」「结论：」「综上」/, '点名具体总结标签');
});

// 发送收口必须真的会削——提示词压不住的确定性字符串，靠这层兜底。
await testWith({ globals: { scrubFormulaicSpeech, describeScrub } }, '发送收口会削掉「行，」「总结：」（提示词兜底）', async (h) => {
  h.setMode('reserved2');
  // sendMessagesV2 返回的就是「实际发出去的那几条」，直接断言它。
  const texts = await h.sendMessagesV2('group:456', ['行，我先按S31那个价位看，谢了', '总结：加钱才有那一档体验', '普通一句话'], []);
  assert.ok(texts.includes('我先按S31那个价位看，谢了'), `「行，」没被削：${JSON.stringify(texts)}`);
  assert.ok(texts.includes('加钱才有那一档体验'), `「总结：」没被削：${JSON.stringify(texts)}`);
  assert.ok(texts.includes('普通一句话'), '正常消息必须原样发出');
});

// 开关关掉时不能再削（有人就想要原样）
await testWith({ config: { socialV2: { style: { scrubFormulaic: false } } }, globals: { scrubFormulaicSpeech, describeScrub } }, '口播清洗可以关掉', async (h) => {
  h.setMode('reserved2');
  const texts = await h.sendMessagesV2('group:456', ['行，我先按S31那个价位看'], []);
  assert.ok(texts.includes('行，我先按S31那个价位看'), `关掉后不该削：${JSON.stringify(texts)}`);
});

// ── 聊天文件消息（群友发 PDF 问「这里面讲了什么」）───────────────────────────
// 线上真实需求：群里有人发了 6.3MB 的 PDF 并 @ 机器人问内容；旧版本只把它渲染成
// `[文件 xxx.pdf]`，media 是空的，AI 完全不知道有这个文件。
await test('文件消息：入库要带文件名/大小，提示要告诉 AI 用哪个工具读', async (h) => {
  h.setMode('reserved2');
  const key = 'group:456';
  h.appendSocialV2Message(key, '米哈游㍿', '[文件指南.pdf]', '[文件指南.pdf]', false, false, 700001,
    [{ kind: 'file', file: 'f.pdf', fileId: 'fid-1', url: 'https://x/a.pdf', name: '指南.pdf', size: 6 * 1024 * 1024 }], '1472298635');
  const st = h.getSocialV2State(key);
  const msg = (st.recentMessages ?? []).find((m) => String(m.messageId) === '700001');
  assert.ok(msg, '消息要入库');
  assert.ok((msg.media ?? []).some((m) => m.kind === 'file' && m.name === '指南.pdf'), '文件段要进 media');
  const hint = h.mediaHintFor(key, '700001', msg.media);
  assert.match(hint, /【文件】/, '提示里要标出这是文件');
  assert.match(hint, /指南\.pdf/, '要带文件名');
  assert.match(hint, /qq_get_message_file/, '要告诉 AI 用哪个工具读');
  assert.match(hint, /6\.0MB/, '带体积，好让 AI 判断值不值得读');
});

let capturedFetch = null;
let capturedAsr = null;
await testWith({
  globals: {
    safeFetchToFile: async (u, maxBytes, filePath) => {
      capturedFetch = { url: String(u), maxBytes };
      fs.writeFileSync(filePath, '%PDF-1.4 fake');
      return { bytes: 12 };
    },
    extractFileContent: async () => ({
      kind: 'pdf',
      text: '正文一二三',
      pages: 7,
      truncated: true,
      notes: ['PDF 标题：测试文档'],
      images: [{ page: 1, buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: 'image/jpeg' }]
    })
  }
}, '文件端点：按 50MB 上限下载，把正文与渲染页面交给 AI', async (h) => {
  const stopKeepAlive = h.keepLoopAlive();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    h.setMode('reserved2');
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    h.appendSocialV2Message(key, '米哈游㿿', '[文件指南.pdf]', '[文件指南.pdf]', false, false, 700002,
      [{ kind: 'file', file: 'f.pdf', fileId: 'fid-2', url: 'https://gzc-download.ftn.qq.com/x/a.pdf', name: '指南.pdf', size: 6 * 1024 * 1024 }], '1472298635');
    const res = await apiRequest(server, `/api/files/message?token=fixture-console-token&key=${encodeURIComponent(key)}&messageId=700002`, { method: 'GET', agentToken: st.agentToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.name, '指南.pdf');
    assert.equal(res.body.kind, 'pdf');
    assert.equal(res.body.pages, 7);
    assert.match(String(res.body.text), /正文一二三/, 'PDF 正文要返回给 AI');
    assert.equal(res.body.truncated, true, '截断要如实说明');
    assert.ok((res.body.notes ?? []).some((n) => /标题/.test(n)), 'PDF 元信息要带出来');
    assert.equal((res.body.images ?? []).length, 1, '扫描件/页面图要一起返回');
    assert.equal(capturedFetch?.maxBytes, 50 * 1024 * 1024, '默认下载上限必须是 50MB');
    assert.equal(res.body.totalChars, 5, '要报出正文总字数');
    assert.equal(res.body.hasMore, false, '短文档一次给完');

    // **不设字数限制**：不带参数就要拿全文；分页只在显式传 maxChars 时生效
    const page1 = await apiRequest(server, `/api/files/message?token=fixture-console-token&key=${encodeURIComponent(key)}&messageId=700002&offset=0&maxChars=3`, { method: 'GET', agentToken: st.agentToken });
    assert.equal(page1.body.text, '正文一', '按 maxChars 分页');
    assert.equal(page1.body.hasMore, true, '还有剩下的要说明');
    assert.match(String(page1.body.note ?? ''), /offset=3/, '要告诉下一段从哪读');
    const page2 = await apiRequest(server, `/api/files/message?token=fixture-console-token&key=${encodeURIComponent(key)}&messageId=700002&offset=3&maxChars=3`, { method: 'GET', agentToken: st.agentToken });
    assert.equal(page2.body.text, '二三', '第二段接得上');
    assert.equal(page2.body.hasMore, false, '读完了');
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); stopKeepAlive(); }
});

// 线上机器人自己发现的问题：它被要求在**私聊会话**里读**群里**的那份 PDF，手里只有私聊令牌，
// 用群 key 调就「令牌无效」，只好拿私聊 key 配群消息 id 绕过去。读操作（看图/读文件）应允许
// 任一有效会话令牌；写操作仍然严格按会话。
await test('跨会话读文件：任一有效会话令牌都该放行（写操作不放开）', async (h) => {
  h.setMode('reserved2');
  const a = h.getSocialV2State('group:456');
  const b = h.getSocialV2State('private:1472298635');
  const tokenA = String(a.agentToken);
  const tokenB = String(b.agentToken);
  assert.notEqual(tokenA, tokenB, '两个会话令牌不同');
  assert.equal(h.anyAgentTokenOk(tokenA), true);
  assert.equal(h.anyAgentTokenOk(tokenB), true, '别的会话的有效令牌也算有效（读操作要用）');
  assert.equal(h.anyAgentTokenOk('nope'.repeat(6)), false, '陌生令牌仍然拒绝');
  assert.equal(h.anyAgentTokenOk(''), false, '空令牌拒绝');
  // 会话自己的校验依然严格（写操作靠它）
  assert.equal(h.agentTokenOk('group:456', tokenA), true);
  assert.equal(h.agentTokenOk('group:456', tokenB), false, '写操作不能被别的会话令牌放行');
  // 宽限期内的旧令牌同样算有效
  const old = String(b.agentToken);
  await h.sendWakePromptV2('private:1472298635', 'admin').catch(() => {});
  h.retireSession('private:1472298635');
  assert.equal(h.anyAgentTokenOk(old), true, '宽限期内的旧令牌也放行读操作');
});

// 视频语音转写（ASR）：桥接负责用本机 ffmpeg 抽 16k 单声道音轨，POST 给外部服务。
// 本机（2 核/460MB）跑不动模型，服务实际跑在另一台机器上，所以这里 stub 掉网络。
await testWith({
  config: { socialV2: { video: { asr: { enabled: true, url: 'http://asr.test/transcribe', token: 'tok-123', maxSeconds: 30, timeoutMs: 5000 } } } },
  globals: {
    // 假 ffmpeg：往 stdout 吐一段「wav」（内容不重要，只要非空）
    spawn: () => {
      // 极简子进程假件：只实现 bridge 用到的 stdout.on / stderr.on / on('close')
      const handlers = {};
      const on = (key) => (ev, fn) => { (handlers[key + ev] ||= []).push(fn); };
      const child = { stdout: { on: on('out:') }, stderr: { on: on('err:') }, on: on('') };
      setTimeout(() => {
        for (const fn of handlers['out:data'] || []) fn(Buffer.alloc(4096, 1));
        for (const fn of handlers.close || []) fn(0);
      }, 0);
      return child;
    },
    fetch: async (url, init) => {
      capturedAsr = { url: String(url), headers: init?.headers, bodyBytes: init?.body?.length ?? 0 };
      return { ok: true, json: async () => ({ ok: true, text: '这段在讲火箭发动机', tookMs: 42, duration: 7.5, model: 'small' }) };
    }
  }
}, '视频转写：抽音轨 → 带令牌 POST → 解析文字', async (h) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-test-'));
  // 造一段 1 秒静音 wav（合法容器，ffmpeg 能解）
  const wav = path.join(tmp, 'a.wav');
  const rate = 16000, secs = 1, bytes = rate * secs * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + bytes, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(bytes, 40);
  fs.writeFileSync(wav, Buffer.concat([header, Buffer.alloc(bytes)]));
  const r = await h.transcribeMediaAudio(wav);
  assert.ok(r, '要返回结果');
  assert.equal(r.text, '这段在讲火箭发动机');
  assert.equal(capturedAsr.url, 'http://asr.test/transcribe');
  assert.equal(capturedAsr.headers['x-asr-token'], 'tok-123', '必须带令牌');
  assert.ok(capturedAsr.bodyBytes > 1000, `音轨要有内容（实际 ${capturedAsr.bodyBytes} 字节）`);
  // 未配置 url 时必须静默跳过（不报错、不影响只给画面）
  const off = await h.transcribeMediaAudio(wav, { enabled: true, url: '' });
  assert.equal(off, null, '没配置就跳过');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// 发语音条：文本 → TTS 服务 → QQ record 段。本机不跑 TTS/RVC（在 tzd 上），用 stub。
let capturedTts = null;
await testWith({
  config: { socialV2: { tts: { enabled: true, url: 'http://tts.test/tts', token: 'tts-tok', maxChars: 10, cooldownMs: 60000, model: 'aiyi' } } },
  globals: {
    fetch: async (url, init) => {
      capturedTts = { url: String(url), headers: init?.headers, body: JSON.parse(init?.body ?? '{}') };
      return {
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]).buffer
      };
    }
  }
}, '发语音：合成→record；长度只截断不拦、冷却仅在显式配置时生效', async (h) => {
  const stopKeepAlive = h.keepLoopAlive();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    h.setMode('reserved2');
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    const base = `/api/socialV2/send-voice?token=fixture-console-token`;
    const ok = await apiRequest(server, base, { method: 'POST', agentToken: st.agentToken, body: { key, text: '你好呀' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(capturedTts.url, 'http://tts.test/tts', '要调到 TTS 服务');
    assert.equal(capturedTts.headers['x-tts-token'], 'tts-tok', '要带令牌');
    assert.equal(capturedTts.body.model, 'aiyi', '默认用 aiyi 音色');
    const rec = h.calls.ws.find((c) => c.action === 'send_group_msg' && Array.isArray(c.params?.message) && c.params.message[0]?.type === 'record');
    assert.ok(rec, '要真的发出 record 段');
    assert.match(String(rec.params.message[0].data.file), /^base64:\/\//, '语音走 base64 文件');
    // 超长 → 不拒绝，截断后照发（owner 要求不要硬门限）
    st.lastVoiceAt = 0; // 先清掉上一条留下的冷却，单独验"长度不拦"
    const tooLong = await apiRequest(server, base, { method: 'POST', agentToken: st.agentToken, body: { key, text: 'x'.repeat(20) } });
    assert.equal(tooLong.status, 200, JSON.stringify(tooLong.body));
    assert.equal(tooLong.body.truncated, true, '要标记截断');
    // 冷却（显式配置了才生效）→ 429
    st.lastVoiceAt = Date.now();
    const again = await apiRequest(server, base, { method: 'POST', agentToken: st.agentToken, body: { key, text: '再说一句' } });
    assert.equal(again.status, 429, '冷却期内要拒');
  } finally { await new Promise((resolve) => server.close(resolve)); await h.close(); stopKeepAlive(); }
});

// 线上事故（2026-10-18 15:19）：WS 掉线丢了 send_group_msg 的回执，桥接按「不确定」上报
// 并明确让模型别原样重发，模型 24 秒后照发 → 群里两条「一天念那么多字，电费你出啊」
// （seq 38378 / 38379）。提示词劝不住，所以必须在发送侧硬拦。
await testWith({ globals: { scrubFormulaicSpeech, describeScrub } }, '原样重发闸门：回执不确定的那条不许原样再发', async (h) => {
  h.setMode('reserved2');
  h.recordAiTextSend('group:456', '一天念那么多字，电费你出啊', 'uncertain');
  const dup = h.checkTextDupGuard('group:456', ['一天念那么多字，电费你出啊']);
  assert.ok(dup, '应当判为重复');
  assert.equal(dup.status, 'uncertain');
  assert.match(dup.reason, /可能已经发到群里/, dup.reason);
  // 真发一次：必须被拦下，而且一条都没发出去
  const err = await h.sendMessagesV2('group:456', ['一天念那么多字，电费你出啊'], []).then(() => null, (e) => e);
  assert.ok(err && err.duplicateGuard === true, `应当被闸门拦下，实际：${err?.message}`);
});

await testWith({ globals: { scrubFormulaicSpeech, describeScrub } }, '原样重发闸门：确认送达的只挡极短窗口', async (h) => {
  h.setMode('reserved2');
  // 刚发过（0 秒前，status=sent）→ 拦
  h.recordAiTextSend('group:456', '笑死', 'sent');
  assert.ok(h.checkTextDupGuard('group:456', ['笑死']), '刚发过的原文应当拦');
  // 5 秒前的 sent → 放行（正常人也会重复一句口头禅）
  const st = h.getSocialV2State('group:456');
  st.recentAiTextSends = [{ text: '笑死', at: Date.now() - 6000, status: 'sent' }];
  assert.equal(h.checkTextDupGuard('group:456', ['笑死']), null, '过了短窗口就该放行');
});

await testWith({ globals: { scrubFormulaicSpeech, describeScrub } }, '原样重发闸门：复读别人的话不受影响', async (h) => {
  h.setMode('reserved2');
  // 我们只发过 A；现在要发 B（群友刚说的话，AI 跟着复读）
  h.recordAiTextSend('group:456', '我发的原话', 'sent');
  assert.equal(h.checkTextDupGuard('group:456', ['群友刚才说的那句']), null, '复读别人的话不能被拦');
  assert.equal(h.checkTextDupGuard('group:456', ['我发的另一句']), null, '不同文本不拦');
  // 但自己刚发过的原文在短窗口内仍然要拦（这是闸门本来的职责）
  assert.ok(h.checkTextDupGuard('group:456', ['我发的原话']), '自己刚发过的原文仍要拦');
});

await testWith({ globals: { scrubFormulaicSpeech, describeScrub } }, '原样重发闸门：空白差异算同一条（归一化）', async (h) => {
  h.setMode('reserved2');
  h.recordAiTextSend('group:456', '一天念那么多字，电费你出啊', 'uncertain');
  assert.ok(h.checkTextDupGuard('group:456', ['  一天念那么多字，电费你出啊  ']), '前后空格不该绕过闸门');
  assert.ok(h.checkTextDupGuard('group:456', ['一天念那么多字， 电费你出啊'.replace('， ', '，')]), '归一化后仍应命中');
});

await testWith({ config: { socialV2: { send: { dupGuard: { enabled: false } } } }, globals: { scrubFormulaicSpeech, describeScrub } }, '原样重发闸门可以关掉', async (h) => {
  h.setMode('reserved2');
  h.recordAiTextSend('group:456', '同一句', 'uncertain');
  assert.equal(h.checkTextDupGuard('group:456', ['同一句']), null, '关掉后不拦');
});

if (failures) process.exitCode = 1;
