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
import * as fileExtract from '../src/file-extract.js';
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
// 主题探索的纯逻辑模块：bridge.js 的 import 会被剥掉，必须像其它模块一样注入成全局。
import * as topicExplore from '../src/topic-explore.js';
import * as selfProfile from '../src/self-profile.js';
import * as imageAllow from '../src/image-allow.js';
import * as cardParse from '../src/card-parse.js';
// bridge.js 的 loadConfig / 搜图接线会调用这些模块：漏掉任意一个，审计会在
// 「DEFAULT_MILD_TAGS is not defined」这类 ReferenceError 上直接崩，跑不到用例。
import * as imageRating from '../src/image-rating.js';
import * as pixivSearch from '../src/pixiv-search.js';
import * as presetStamp from '../src/preset-stamp.js';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';
// 图片压缩兜底（超限图片本地缩放后再投喂）：bridge.js 直接 import sharp，
// 这里也要注入，否则 VM 里是 ReferenceError，压缩路径测不到。
import sharp from 'sharp';

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
export async function bridgeHarness({ config = {}, savedState, stickerState, forwardFixtures, history, globals = {}, getMsg, hangActions, failActions, failGetMsg } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 预置本地表情库：唤醒提示里的「没备注的表情」欠账段依赖它，否则测试里库是空的、测不到开关。
  if (stickerState) fs.writeFileSync(path.join(temp, 'state', 'stickers.json'), JSON.stringify(stickerState));
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
      // 忙标记自愈会拿 sessions.list 判断「DSH 那边是不是真的空闲」；默认全部 running=false。
      list: async () => success({ items: [] }),
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
    // SDK 的 raw(action) 返回的是 OneBot 的 data 字段（不是整个响应体）。
    // 合并转发走的是 bot.raw，所以假机器人也得提供，否则那条路径在审计里直接 TypeError。
    async raw(action, params) {
      const resp = await this.request(action, params);
      return resp?.data;
    }
    async request(action, params) {
      calls.ws.push({ action, params });
      const hangSet = hangActions instanceof Set ? hangActions : new Set(hangActions ?? []);
      if (hangSet.has(action)) {
        // 永不 settle：模拟「WS 请求发出去了、但回执没在预算内回来」。
        return new Promise(() => {});
      }
      // failActions：让指定动作直接抛错，用来模拟「连接中途断开」这类**非超时**失败
      // （真事：WS 把消息送出去了、回执没回来，桥接当时当成硬失败 → 模型重发 → 重复）。
      const failMap = failActions ?? {};
      if (Object.hasOwn(failMap, action)) throw new Error(String(failMap[action]));
      // 真网关会返回 user_id / nickname；改资料的「旧值基线」和头像备份都靠它。
      if (action === 'get_login_info') {
        return { status: 'ok', retcode: 0, data: { user_id: 2840404638, nickname: '哦鲸鲸' } };
      }
      // 合并转发：按 id 返回预置的多层结构（forwardFixtures: { id: data }），
      // 没预置就返回空列表——真网关对未知 id 也是这个语义。
      if (action === 'get_forward_msg') {
        const fix = (forwardFixtures ?? {})[String(params?.id)];
        return { status: 'ok', retcode: 0, data: fix ?? [] };
      }
      // 掉线补拉用的历史查询。语义照真网关实测：
      //   count 生效；message_seq + count = 从该 seq 往后取；只给 count 不给 seq = 最新 count 条。
      if (action === 'get_group_msg_history' || action === 'get_friend_msg_history') {
        const kind = action === 'get_group_msg_history' ? 'group' : 'private';
        const id = String(kind === 'group' ? params?.group_id : params?.user_id);
        const all = (((history ?? {})[kind] ?? {})[id] ?? []);
        let list = all.slice();
        const from = Number(params?.message_seq);
        if (Number.isFinite(from) && from > 0) list = list.filter((m) => Number(m?.message_seq) >= from);
        const count = Number(params?.count);
        if (Number.isFinite(count) && count > 0) list = list.slice(0, count);
        else list = list.slice(-20);
        return { status: 'ok', retcode: 0, data: { messages: list } };
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
    // 唤醒链路：回合进行中收到新消息必须「暂存待补投」，不能把唤醒丢掉（AI 不回话那类事故）。
    sendWakePromptV2, scheduleWakeV2, dshSessionIdleNow, pendingWakeKeys,
    getSocialV2State, takeBootstrapV2, resolveImageBuffer, sendImageV2, imageIdentityKey, recentSentImageKeys,
    // 每轮注入的上下文（含「玩梗/闲聊/正经事」三级分流）：用来钉住「玩梗要接梗、不许科普」这条。
    withSlangContext,
    // 主题探索（自主扩展学习）：编排在桥接里，纯逻辑在 src/topic-explore.js。
    startTopicExploration, stopTopicExploration, exploreCfg, persistTopicFindings,
    // 机器人资料：账号级身份，重点验证「谁能改」的闸门。
    profileCfg, isAdminProfileContext, applyProfileChange, revertProfile, noteProfileTriggers,
    get selfProfile() { return selfProfile; },
    validateProfileField, looksLikeAd, previousValueFor, normalizeProfileState,
    get exploreJobs() { return exploreJobs; },
    async awaitExploreChain() { await exploreChain; },
    /** 学习会话当前有没有在等回合结束的任务。 */
    learnerWaiting() { return [...learnerWaiters.values()].some((a) => a && a.length > 0); },
    // 主动开话题的反重复：记住最近主动开的头，下次要求换方向。
    // 注意 buildProactivePrompt 只是**一代（reserved）**路径；reserved2 真正生效的是
    // buildWakePromptV2 + 共用的 buildProactiveTopicBlock，两个都要能测。
    buildProactivePrompt, buildWakePromptV2, buildProactiveTopicBlock, recordSentMessagesV2, retryPendingWakeV2, agentMessageView, planAnimFrames, animFrameText, deriveSelfSaid,
    // 一代批次提示：用来钉住「【管理员】≠群主」的术语只在真的出现管理员消息时注入。
    buildBatchPrompt,
    // 链接分享卡：只发桥接组装的固定形状，链接必须过 validateFetchUrl。
    sendCardV2, resolveCardConfig, buildNewsCard, confirmMessageLanded,
    // 黑话库：手动添加要落成候选（用例直接查内存表验证状态，而不是只看接口回执）。
    get slangEntries() { return slangEntries; },
    getSlangEntries() { return slangEntries; },
    buildSlangContext, formatKnowledgeTable, buildKnowledgeContext,
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
    /**
     * 取出一个正在等待回合结束的学习会话 waiter（审计用）。
     * 只负责出队+清定时器；「用哪段文本结束它」由 harness 侧决定（那边才拿得到 calls.prompts）。
     */
    takeLearnerWaiter() {
      for (const [sid, arr] of learnerWaiters) {
        if (!Array.isArray(arr) || !arr.length) continue;
        const waiter = arr.shift();
        if (!arr.length) learnerWaiters.delete(sid);
        clearTimeout(waiter.timer);
        return { sessionId: sid, resolve: waiter.resolve, reject: waiter.reject };
      }
      return null;
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
    // 图片压缩兜底：超限图片必须本地缩放后再投喂，而不是直接丢掉（线上 4.35MB 月饼图取不到）。
    fitMediaBuffer, shrinkMediaBuffer, MAX_MEDIA_BYTES, MAX_MEDIA_FETCH_BYTES, imagePassthroughBytes, imageSoftPixels,
    // 表情包 vs 图片：网关用 sub_type=1 / summary=[动画表情] 标 QQ 动画表情，
    // 桥接必须把这个身份带给 AI（否则 AI 会把表情包当成照片，见线上那次「发第二遍了」）。
    imageSegmentLabel, segmentsToText, mediaHintFor, appendSocialV2Message,
    // 掉线补拉：断线期间的消息网关不重发，靠这条逻辑补回来（含唤醒闸门）。
    backfillMissedMessages, retireSession, agentTokenOk, anyAgentTokenOk,
    // 出站口播清洗：AI 文本发送的唯一收口就是 sendMessagesV2，这里验证它真的会削。
    sendMessagesV2,
    // 假 QQ 的调用记录（发出去的消息文本在 calls.sent 里）。
    calls: __auditCalls,
    // 暂存唤醒意图的补发判据（必须精确匹配自己那条 seq，否则陈旧意图会反复补投）。
    pendingWakeStillRelevantV2,
    // 聊天视频：段解析、ffmpeg 信息解析、抽帧入口（抽帧本体要真 ffmpeg，测试只钉解析与降级）。
    extractMediaFromSegments, parseVideoInfo, extractVideoFrames, resolveFfmpegPath,
    // 批总量预算：撞上限时先把这张压小塞进去，而不是整张丢掉（合并转发只看到前几张的根因之一）。
    fitBatchBudget,
    // 动图与透明通道：透明图压成 JPEG 会变黑底（线上「拳头糊成一颗球」），
    // 动图只喂第一帧等于静图（线上 27 帧的蹲姿动图被当成照片描述）。
    normalizeImageForVision, probeImageMeta, VISION_ANIM_FRAMES, VISION_ANIM_LONGSIDE,
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
    SnowLumaWebSocketClient: FakeBot, text: (s) => s, sharp,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker, ...slangIndex, ...stickerPicker, ...memberRemarks, ...fileExtract, ...knowledgeStore, ...imageAllow, ...cardParse, ...imageRating, ...pixivSearch, ...presetStamp, ...memoryAdmin, ...imageAdmin, ...sentImages, ...contentFilter, ...topicExplore, ...selfProfile,
    // 假 QQ 的调用记录：用例要断言「实际发出去的文本」（口播清洗发生在发送收口里）。
    __auditCalls: calls,
    ...globals,
  });
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  /**
   * 在审计里完整跑一遍「研究会话 → 落库」：把等待中的那次 turn 用 buildText(prompt) 的
   * 返回值结束掉。放在 harness 侧是因为它要用 calls.prompts 拿到刚投出去的提示词。
   */
  bridge.answerLearnerTurn = async (buildText, { timeoutMs = 5000 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const taken = bridge.takeLearnerWaiter();
      if (taken) {
        const prompt = [...calls.prompts].reverse().find((p) => p.sessionId === taken.sessionId)?.content?.[0]?.text ?? '';
        taken.resolve(typeof buildText === 'function' ? buildText(prompt) : String(buildText));
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };
  return { ...bridge, calls, temp, keepLoopAlive, async close() {
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
