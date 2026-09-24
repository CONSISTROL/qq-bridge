// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import * as slangIndex from '../src/slang-index.js';
import * as stickerPicker from '../src/sticker-picker.js';
import * as memberRemarks from '../src/member-remarks.js';
import * as knowledgeStore from '../src/knowledge-store.js';
// AI 记忆管理（bridge.js 的 /api/memory* 接线要用）：同样是「漏掉就在启动阶段
// ReferenceError 崩掉、跑不到用例」的模块。
import * as memoryAdmin from '../src/memory-admin.js';
// AI 图片管理（bridge.js 的 /api/ai-images* 接线要用）：真实模块即可——
// 审计里 ROOT/STATE_DIR 都在临时目录，它只会去扫那些不存在的目录，不会碰真实图库。
import * as imageAdmin from '../src/image-admin.js';
// AI 发出去的网络图落盘（bridge.js 启动时就 createSentImageStore）。
import * as sentImages from '../src/sent-images.js';
// 入站内容策略（bridge.js 启动时就 createContentGate）。
import * as contentFilter from '../src/content-filter.js';
import * as imageAllow from '../src/image-allow.js';
import * as cardParse from '../src/card-parse.js';
// bridge.js 的 loadConfig / 搜图接线会调用这些模块：漏掉任意一个，审计会在
// 「DEFAULT_MILD_TAGS is not defined」这类 ReferenceError 上直接崩，跑不到用例。
import * as imageRating from '../src/image-rating.js';
import * as pixivSearch from '../src/pixiv-search.js';
import * as presetStamp from '../src/preset-stamp.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
/**
 * @param {{config?:object, savedState?:object, globals?:object, getMsg?:Function,
 *          hangActions?:string[]|Set<string>, failGetMsg?:boolean}} [options]
 *   `getMsg`：假的 `get_msg` 返回值（图片送达确认用）。默认返回「已送达」形态
 *   （message_seq>0 + 图片已换成 http CDN 地址）；传 `() => ({...})` 可模拟
 *   「网关回 ok、QQ 静默丢图」那条路径（message_seq=0 + url 仍是 base64://）。
 *   `hangActions`：这些 OneBot 动作在 WS 上永不返回（模拟「WS 超时」），
 *   用来验证写类动作超时后**不会**回退 HTTP 重发（那正是重复发图的根因）。
 *   `failGetMsg`：`get_msg` 探针本身打不通（模拟 WS 被大图 base64 占满）——
 *   用来验证「探针没打通 ≠ 没送达」，此时不能重发。
 */
export async function bridgeHarness({ config = {}, savedState, globals = {}, getMsg, hangActions, failGetMsg } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], ws: [] };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    // 现在所有 OneBot 调用都优先走 WS（base64 图片太大时 SnowLuma 的 HTTP 端会断连），
    // 所以假机器人要按 action 分流：被收藏表情要返回列表，发送类调用返回 message_id，
    // 否则表情发送测试会拿不到回执（calls.ws 里能看到实际发出的 params）。
    async request(action, params) {
      calls.ws.push({ action, params });
      const hangSet = hangActions instanceof Set ? hangActions : new Set(hangActions ?? []);
      if (hangSet.has(action)) {
        // 永不 settle：模拟「WS 请求发出去了、但回执没在预算内回来」。
        return new Promise(() => {});
      }
      if (action === 'fetch_custom_face_detail') {
        return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] };
      }
      // 图片送达确认：真网关里「已送达」的消息 message_seq>0、图片段换成 QQ CDN 的 http 地址；
      // 被 QQ 静默丢掉的则停在 message_seq=0 + base64://。默认给前者。
      if (action === 'get_msg') {
        // 探针本身打不通（大图把 WS 占满时线上就是这样）：不代表没送达，不能据此重发。
        if (failGetMsg) throw new Error('WS get_msg 超时（5000ms）');
        const data = typeof getMsg === 'function'
          ? getMsg(Number(params?.message_id))
          : { message_seq: 100, message: [{ type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/download?fixture=1' } }] };
        return { status: 'ok', retcode: 0, data };
      }
      // 发送类调用返回递增的 message_id：送达确认用例要靠它区分「第几次发送」。
      calls.sentMessageId = (calls.sentMessageId || 0) + 1;
      return { status: 'ok', retcode: 0, data: { message_id: calls.sentMessageId } };
    }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  source = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    // 「会话繁忙」判定：给审计用例用，验证残留忙标记能被识别成卡死（AI 无响应的那类事故）。
    busyMarkersV2, staleTurnMarkerV2, forceClearBusyV2, v2TurnStartAt, activeWaits, socialV2,
    getSocialV2State, takeBootstrapV2, resolveImageBuffer, sendImageV2, imageIdentityKey, recentSentImageKeys,
    // 重复发图回归：写类动作超时后绝不能回退 HTTP 重发（那正是线上重复图的根因）。
    postOneBot, isOneBotWriteAction, oneBotWriteTimeoutMs, isTimeoutError,
    imageSendUncertainAt, markImageSendUncertain,
    // 送达确认改成三态 {delivered, conclusive}：探针没打通时不许重发。
    confirmImageDelivered, imageMessageDelivered, deliverCheckTasks,
    /** 等后台送达确认跑完（回合已经返回，测试要断言最终状态）。 */
    async awaitDeliverChecks() { await Promise.allSettled([...deliverCheckTasks]); },
    /** 让该会话的发送链全部结算（验证按会话排队/隔离）。 */
    async awaitSendChain(key) { await chainFor(key); },
    /** 等该会话的 prompt 队列排空（工作车道回投结论是异步的，断言前要等到位）。 */
    async awaitPromptQueue(key) {
      for (let i = 0; i < 200; i++) {
        const entry = promptQueues.get(key);
        if (!entry || (!entry.running && entry.queue.length === 0)) return;
        await sleep(10);
      }
    },
    /** 等异步归档/停止动作落地（retire 系列的清理是 fire-and-forget）。 */
    async flushAsync() { for (let i = 0; i < 10; i++) await Promise.resolve(); await sleep(5); },
    // 工作车道：长任务丢给独立会话跑，聊天会话不被堵住。
    deliverWorkTask, handleWorkLaneFrame, retireWorkLanes, workLaneEnabled, workLaneMaxSessions,
    pickWorkLane, workSessions, workReverse, workTasks, workCollectors, buildWorkLanePrompt,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  // 保护「等一个 unref 定时器」的用例：postOneBot 的 WS 超时计时器是 unref 的
  // （生产里桥接本来就有别的事撑着事件循环，测试里没有），没有这个 keep-alive
  // Node 会在定时器触发前判定「unsettled top-level await」直接退出。
  let keepAliveTimer = null;
  function keepLoopAlive() {
    if (!keepAliveTimer) keepAliveTimer = setInterval(() => {}, 1000);
    return () => {
      if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    };
  }
  const context = vm.createContext({
    fs, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    // env 必须是空对象而不是传真实的 process.env：bridge.js 支持 QQ_BRIDGE_CONFIG /
    // QQ_BRIDGE_STATE_DIR 做隔离测试，泄漏真实环境变量会让审计读到生产配置/状态目录。
    process: {
      pid: process.pid,
      platform: process.platform,
      kill: process.kill,
      exit: (code) => { throw new Error('unexpected exit ' + code); },
      env: {}
    },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    // RAG 的 embedder 客户端在审计里必须是「永远不可用」的桩：真实实现会在 start() 里
    // spawn 一个子进程和加载本地模型，审计套件要求完全离线、不碰真实进程与模型文件。
    // 桩让 ragReady() 恒为 false，向量检索自动降级为按频次选词，其余逻辑照常跑。
    EmbeddingClient: class {
      constructor() {
        this.ready = false;
        this.info = { ready: false, model: null, dim: null, mem: null };
        this.stats = { requests: 0, totalMs: 0 };
      }
      async start() { return false; }
      async embed() { return []; }
      async probe() { return { ok: false, error: 'audit stub' }; }
      dispose() {}
    },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker, ...slangIndex, ...stickerPicker, ...memberRemarks, ...knowledgeStore, ...imageAllow, ...cardParse, ...imageRating, ...pixivSearch, ...presetStamp, ...memoryAdmin, ...imageAdmin, ...sentImages, ...contentFilter,
    ...globals,
  });
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, keepLoopAlive, async close() {
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
