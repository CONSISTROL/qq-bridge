import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
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
await test('closed-agent session is not reused after switching to chat', async (h) => {
  h.setMode('closed-agent');
  const privileged = await h.ensureSession('private:123');
  h.setMode('chat');
  const restricted = await h.ensureSession('private:123');
  assert.notEqual(restricted, privileged);
  assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat');
  assert.ok(h.calls.cancelled.includes(privileged));
});
await test('unavailable preset catalogue fails closed for QQ and learner sessions', async (h) => {
  h.setPresets([]);
  assert.equal(h.resolvePresetName('missing', { strict: true }), '');
  await assert.rejects(h.ensureSession('group:456'));
  await assert.rejects(h.ensureSlangLearnerSession());
  assert.equal(h.calls.created.length, 0);
});
await test('session creation crossing a mode change never accepts stale permissions', async (h) => {
  h.setMode('closed-agent');
  let release;
  const original = h.api.sessions.create;
  h.api.sessions.create = async (params) => {
    const result = await original(params);
    await new Promise((resolve) => { release = resolve; });
    return result;
  };
  const pending = h.ensureSession('private:123');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  h.setMode('chat');
  release();
  await assert.rejects(pending);
  assert.equal(h.state.sessions['private:123'], undefined);
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

await test('图片送达异常提示会劝住「对同一张硬重试」', async (h) => {
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
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

if (failures) process.exitCode = 1;
