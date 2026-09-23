import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import http from 'node:http';

let failures = 0;
async function test(name, run) {
  const h = await bridgeHarness();
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
