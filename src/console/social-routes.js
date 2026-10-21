// 聊天模式（chat）相关路由：配置、唤醒、发送、资料、主题探索、工作车道。
//
// 从 bridge.js 抽出的控制台路由。依赖由工厂函数注入：
// 稳定的函数/常量按值传入；会被重新赋值的绑定用 getter/setter（模块内以 deps.xxx 访问）。

export function createSocialRoutes(deps) {
  const {
    KNOWN_AGENT_TOKENS,
    OPT_IN_CAPS,
    PLUGINS,
    ROOT,
    SENSITIVE_RE,
    SOCIAL_V2_FILE,
    activeWaits,
    agentMessageView,
    agentTokenOk,
    appendActivity,
    applyProfileChange,
    atomicWriteJson,
    backfillMissedMessages,
    bot,
    buildSlangContext,
    buildStickerContext,
    buildStickerMomentLineV2,
    buildStickerStrategyHint,
    cancelReplyCheckV2,
    cfg,
    clearAllPendingWakeLeases,
    clearAllSocialV2Timers,
    collectors,
    computeGapsV2,
    computeWakeSafetyV2,
    confirmedSlangListV2,
    currentRoleHint,
    currentRoleHintV2,
    deliverWorkTask,
    drainAllPromptQueues,
    ensureWakeableV2,
    enterActive,
    evaluateMoment,
    exploreCfg,
    findCjkSpaceWarning,
    findSplitBoundaryWarning,
    flushSummaries,
    formatJobProgress,
    formatMemoryV2,
    formatParticipationV2,
    formatProfileState,
    formatStickerList,
    fs,
    getBotSelfId,
    getSocialV2State,
    groupAvatarUrl,
    isActiveStatus,
    isAdminProfileContext,
    isSleepingConfigV2,
    knowledgeEnabled,
    knowledgeRemindMinAskers,
    knowledgeRemindThreshold,
    lastIncomingTextV2,
    leaveActive,
    listKnowledgeConflicts,
    log,
    looksLikeImageBuffer,
    looksLikeUnfinished,
    markDeliveredV2,
    markReadCalledKeys,
    memberAvatarUrl,
    migrateLegacyTools,
    mimeFromBuffer,
    modeAllowed,
    normalizeImageRating,
    normalizeRatingWords,
    normalizeSpeakerIdsV2,
    notifyAiSession,
    path,
    pendingSendToolCalls,
    pendingWakeKeys,
    pickContextTextV2,
    pluginCatalog,
    postOneBot,
    preSleepWaitBlockedV2,
    previousValueFor,
    profileCfg,
    readJsonSafe,
    readPickConfig,
    readRoleState,
    recordSentMessagesV2,
    refreshAllDefaultWakeConfigsV2,
    resolveCardConfig,
    resolveImageConfig,
    resolveReplyTargetV2,
    reverse,
    revertProfile,
    safeFetchBuffer,
    saveSocialV2State,
    scheduleProactiveCheckV2,
    scheduleReplyCheckV2,
    scheduleWakeV2,
    seenForwardIds,
    sendCardV2,
    sendMessagesV2,
    sendToolSucceededSessions,
    sendWakePromptV2,
    sessionPromises,
    setupSleepTimerV2,
    shouldBlockSilentReply,
    shouldRemindRepeat,
    sleep,
    social,
    socialV2,
    startTopicExploration,
    stickerEnabled,
    stickerLibraryItems,
    stopTopicExploration,
    suggestQuietMsV2,
    syncStickerLibrary,
    toolCallNames,
    v2TurnStartAt,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
    workLaneEnabled,
  } = deps;

  async function handleSocialLegacyRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody } = routeCtx;
    if (req.method === 'POST' && url.pathname === '/api/social/state') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      const phase = body.phase;
      if (phase === 'active') {
        // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
        enterActive(key);
        log(`控制台：手动将 ${key} 设为活跃`);
        sendJson({ ok: true, key, phase: 'active' });
      } else if (phase === 'idle') {
        leaveActive(key);
        log(`控制台：手动将 ${key} 设为观望`);
        sendJson({ ok: true, key, phase: 'idle' });
      } else {
        sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
      }
      return;
    }
    // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/social') {
      const stats = {};
      for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
      const states = {};
      const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
      for (const k of keys) {
        const st = social.states.get(k);
        states[k] = { phase: st?.phase ?? 'idle' };
      }
      sendJson({ config: cfg.social, pendingSummaries: stats, states });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/social') {
      const body = await readBody();
      const configFile = path.join(ROOT, 'config.json');
      // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
      const file = readJsonSafe(configFile, null, true);
      const merged = { ...(file.social ?? {}), ...body };
      // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
      for (const k of [
        'burstProbability',
        'burstMaxMessages',
        'followUpEnabled',
        'followUpProbability',
        'followUpDelayMinMs',
        'followUpDelayMaxMs',
        'followUpCooldownMs',
      ]) {
        delete merged[k];
      }
      for (const k of [
        'triggerProbability',
        'activeCheckMinMs',
        'activeCheckMaxMs',
        'activeReplyDelayMinMs',
        'activeReplyDelayMaxMs',
        'activeDurationMinMs',
        'activeDurationMaxMs',
        'idleWindowMs',
        'idleRetryProbability',
        'idleRetryWaitMs',
        'proactiveIdleThresholdMs',
        'proactiveCheckMinMs',
        'proactiveCheckMaxMs',
        'proactiveProbability',
        'maxReplyChars',
        'contextWindow',
        'burstIntervalMinMs',
        'burstIntervalMaxMs',
        'longGapMinMs',
        'longGapMaxMs',
      ]) {
        if (merged[k] !== undefined) {
          const n = Number(merged[k]);
          if (Number.isFinite(n) && n >= 0) merged[k] = n;
        }
      }
      // 分条间隔 clamp 到非负
      for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
        if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
      }
      // 概率字段 clamp 到 0~1
      for (const k of [
        'triggerProbability',
        'idleRetryProbability',
        'proactiveProbability',
        'skipProbability',
        'surrenderProbability',
        'longGapProbability',
      ]) {
        if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
      }
      // contextWindow 限制 1~100
      if (merged.contextWindow !== undefined) {
        merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
      }
      // 布尔字段
      for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
        if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
      }
      // 范围字段保证 min <= max
      for (const [minK, maxK] of [
        ['activeCheckMinMs', 'activeCheckMaxMs'],
        ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'],
        ['activeDurationMinMs', 'activeDurationMaxMs'],
        ['proactiveCheckMinMs', 'proactiveCheckMaxMs'],
        ['burstIntervalMinMs', 'burstIntervalMaxMs'],
        ['longGapMinMs', 'longGapMaxMs'],
      ]) {
        if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
          [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
        }
      }
      if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
      file.social = merged;
      atomicWriteJson(configFile, file);
      cfg.social = { ...cfg.social, ...merged };
      log('控制台：社交配置已更新');
      sendJson({ ok: true, config: cfg.social });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/social/flush') {
      const body = await readBody();
      await flushSummaries(body.key || null);
      sendJson({ ok: true });
      return;
    }
    // 后台控制端引导：向指定会话的 DSH agent 投递提醒。
    // 真正的投递逻辑抽在 notifyAiSession() 里，因为「表情包 → 立刻补一批」也走同一条路
    // （同一套校验、同样的静默回合语义），两处各写一遍必然会漂移。
    if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const message = String(body.message ?? '').trim();
      if (!key || !message) {
        sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
        return;
      }
      try {
        const { sessionId } = await notifyAiSession(key, message);
        log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
        appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
        sendJson({ ok: true, key, sessionId });
      } catch (error) {
        sendJson({ ok: false, error: error?.message ?? String(error) }, error?.statusCode || 500);
      }
      return;
    }
  }
  async function handleSocialV2ConfigRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
      // knowledge 一并返回：social2 的工具开关面板里带了它的齿轮配置弹窗，
      // 那里的 CFG_SCHEMA 读 state.config[section]，少了这一段会渲染成空面板。
      sendJson({ ok: true, config: { ...(cfg.socialV2 ?? {}), knowledge: cfg.knowledge ?? {} } });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
      const body = await readBody();
      const configFile = path.join(ROOT, 'config.json');
      const file = readJsonSafe(configFile, null, true);
      const current = file.socialV2 ?? {};
      const merged = { ...current, ...body };
      // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
      for (const sub of [
        'tools',
        'wake',
        'send',
        'wait',
        'proactive',
        'sticker',
        'video',
        'forward',
        'feedback',
        'context',
        'image',
        'backfill',
      ]) {
        if (
          body[sub] !== undefined &&
          (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))
        ) {
          merged[sub] = current[sub] ?? {};
        }
      }
      // backfill：掉线补拉的条数/唤醒闸门必须是合法数值，别让前端传字符串把闸门敞开放大
      if (body.backfill && typeof body.backfill === 'object') {
        const curBf = current.backfill ?? {};
        const clampInt = (v, lo, hi, fallback) => {
          const n = Number(v);
          return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
        };
        merged.backfill = { ...curBf, ...body.backfill };
        merged.backfill.enabled = merged.backfill.enabled !== false;
        merged.backfill.maxMessages = clampInt(merged.backfill.maxMessages, 1, 500, Number(curBf.maxMessages) || 100);
        merged.backfill.wakeMaxMessages = clampInt(
          merged.backfill.wakeMaxMessages,
          0,
          500,
          Number(curBf.wakeMaxMessages) || 15,
        );
        merged.backfill.wakeMaxAgeMs = clampInt(
          merged.backfill.wakeMaxAgeMs,
          0,
          24 * 3600 * 1000,
          Number(curBf.wakeMaxAgeMs) || 600000,
        );
      }
      if (merged.autoReplyCheckMs !== undefined) {
        const n = Number(merged.autoReplyCheckMs);
        merged.autoReplyCheckMs = Number.isFinite(n)
          ? Math.max(1000, Math.round(n))
          : (current.autoReplyCheckMs ?? 30000);
      }
      // tools：只接受布尔开关
      const toolFlags = [
        'getPrompt',
        'getUnread',
        'getRecent',
        'socialState',
        'sendGroup',
        'sendPrivate',
        'reply',
        'sendBurst',
        'sendMessage',
        'waitMessages',
        'feedback',
        'getMyRecent',
        'getMessageDetail',
        'getActiveMembers',
        'setWakeConfig',
        'markRead',
        'memory',
        'slangQuery',
        'slangSubmit',
        'getImages',
        'getForwardMsg',
        'sendPoke',
        'listStickers',
        'getStickerImage',
        'sendSticker',
        'setStickerRemark',
        'stickerNote',
        'collectSticker',
        'saveSticker',
        'sendImage',
        'listImageLibrary',
        'searchImages',
        'getSelfImage',
        'pickSticker',
        'memberRemark',
        'video',
        'videoFrames',
        'getMessageVideo',
        'runTask',
        'sendCard',
        'exploreTopic',
        'setProfile',
      ];
      // 默认关闭的高危工具（真·QQ 写操作）：非布尔一律按「当前值 === true」兜底，不能用 !== false。
      const optInToolFlags = ['setMemberCard', 'setProfile'];
      if (body.tools && typeof body.tools === 'object') {
        merged.tools = { ...(current.tools ?? {}), ...body.tools };
        for (const k of toolFlags) {
          if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
        }
        for (const k of optInToolFlags) {
          if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] === true;
        }
      }
      // image：从外部保存表情的能力参数（体积/频率/是否允许远程 URL）
      if (body.image && typeof body.image === 'object') {
        const cur = current.image ?? {};
        merged.image = { ...cur, ...body.image };
        for (const k of [
          'maxBytes',
          'passthroughBytes',
          'softPixels',
          'maxPerMinute',
          'maxPerHour',
          'repeatGuardMs',
          'deliverCheckMs',
          'deliverCheckFastMs',
        ]) {
          if (merged.image[k] !== undefined) {
            const n = Number(merged.image[k]);
            merged.image[k] = Number.isFinite(n) && n >= 0 ? Math.round(n) : (cur[k] ?? 0);
          }
        }
        if (merged.image.enabled !== undefined) merged.image.enabled = merged.image.enabled !== false;
        if (merged.image.allowRemoteUrl !== undefined)
          merged.image.allowRemoteUrl = merged.image.allowRemoteUrl === true;
        if (merged.image.imageReferer !== undefined)
          merged.image.imageReferer = String(merged.image.imageReferer || 'https://www.bilibili.com').slice(0, 300);
        // pixiv：代理地址与登录 cookie。cookie 是凭据，只存本机 config.json（已 gitignore），
        // 控制台按密码框渲染；这里限制长度并拒绝换行，避免 header 注入。
        if (merged.image.pixiv !== undefined) {
          const curPixiv = cur.pixiv && typeof cur.pixiv === 'object' ? cur.pixiv : {};
          const incoming = merged.image.pixiv && typeof merged.image.pixiv === 'object' ? merged.image.pixiv : {};
          const cleanStr = (v, fallback, max) => {
            if (v === undefined) return fallback;
            return String(v ?? '')
              .replace(/[\r\n]/g, '')
              .trim()
              .slice(0, max);
          };
          merged.image.pixiv = {
            enabled: incoming.enabled === undefined ? curPixiv.enabled === true : incoming.enabled === true,
            proxy: cleanStr(incoming.proxy, String(curPixiv.proxy ?? ''), 200),
            cookie: cleanStr(incoming.cookie, String(curPixiv.cookie ?? ''), 2000),
          };
        }
        if (merged.image.libraryDir !== undefined)
          merged.image.libraryDir = String(merged.image.libraryDir || 'assets/stickers').slice(0, 200);
        if (merged.image.refererAllow !== undefined) {
          merged.image.refererAllow = Array.isArray(merged.image.refererAllow)
            ? merged.image.refererAllow
                .map((v) => String(v ?? '').trim())
                .filter((v) => /^https?:\/\//i.test(v))
                .slice(0, 20)
            : (cur.refererAllow ?? []);
        }
        // 年龄分级只有 safe/mild 两档，写别的值一律收紧回 safe（normalizeImageRating 兜底）。
        if (merged.image.rating !== undefined) merged.image.rating = normalizeImageRating(merged.image.rating);
        // 分级词表：数组才认；非数组的键沿用旧值（不会因为漏传某个键就把词表清空）。
        // explicitExtra 是 explicit 的唯一来源（内置标签表与标题兜底都已清空），且不受 mild/tolerated 影响。
        if (merged.image.ratingWords !== undefined) {
          merged.image.ratingWords = normalizeRatingWords(
            merged.image.ratingWords && typeof merged.image.ratingWords === 'object'
              ? merged.image.ratingWords
              : (cur.ratingWords ?? {}),
          );
        }
      }
      // wake：数值与字符串数组归一化
      if (body.wake && typeof body.wake === 'object') {
        merged.wake = { ...(current.wake ?? {}), ...body.wake };
        for (const k of [
          'sleepMinMs',
          'sleepMaxMs',
          'recommendedSleepMinMs',
          'recommendedSleepMaxMs',
          'recommendedProbability',
          'batchWindowMs',
          'maxWakePerMinute',
          'maxWakePerHour',
          'noActionLimit',
          'maxWakeConfigReminders',
          'preSleepWaitMs',
        ]) {
          if (merged.wake[k] !== undefined) {
            const n = Number(merged.wake[k]);
            merged.wake[k] = Number.isFinite(n) ? n : (current.wake?.[k] ?? 0);
            // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
            if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
          }
        }
        if (merged.wake.recommendedProbability !== undefined)
          merged.wake.recommendedProbability = Math.min(
            1,
            Math.max(0, Number(merged.wake.recommendedProbability) || 0),
          );
        if (merged.wake.preSleepWaitEnabled !== undefined)
          merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
        if (merged.wake.recommendedDefaultInfinite !== undefined)
          merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
        if (merged.wake.recommendedPoke !== undefined)
          merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
        if (merged.wake.recommendedKeywords !== undefined) {
          merged.wake.recommendedKeywords = (
            Array.isArray(merged.wake.recommendedKeywords)
              ? merged.wake.recommendedKeywords
              : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)
          )
            .map(String)
            .filter(Boolean);
        }
        if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
        if (merged.wake.recommendedHint !== undefined)
          merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
      }
      // work：工作车道（把长任务丢给独立会话跑，聊天会话不被慢工具堵住）
      if (body.work && typeof body.work === 'object') {
        const curWork = current.work ?? {};
        merged.work = { ...curWork, ...body.work };
        if (merged.work.enabled !== undefined) merged.work.enabled = merged.work.enabled !== false;
        const n = Number(merged.work.maxSessions);
        merged.work.maxSessions =
          Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : Number(curWork.maxSessions) || 2;
      }
      // card：链接分享卡（长度/频率/主机白名单）
      if (body.card && typeof body.card === 'object') {
        const curCard = current.card ?? {};
        merged.card = { ...curCard, ...body.card };
        if (merged.card.enabled !== undefined) merged.card.enabled = merged.card.enabled !== false;
        for (const k of ['maxTitleChars', 'maxDescChars', 'maxPerMinute', 'maxPerHour']) {
          if (merged.card[k] !== undefined) {
            const n = Number(merged.card[k]);
            merged.card[k] = Number.isFinite(n) && n >= 0 ? Math.round(n) : Number(curCard[k]) || 0;
          }
        }
        if (merged.card.allowHosts !== undefined) {
          const raw = Array.isArray(merged.card.allowHosts)
            ? merged.card.allowHosts
            : String(merged.card.allowHosts).split(/[,\s]+/);
          merged.card.allowHosts = [...new Set(raw.map((h) => String(h).trim().toLowerCase()).filter(Boolean))].slice(
            0,
            200,
          );
        }
      }
      // send：数值归一化
      if (body.send && typeof body.send === 'object') {
        merged.send = { ...(current.send ?? {}), ...body.send };
        for (const k of [
          'burstMaxMessages',
          'burstIntervalMinMs',
          'burstIntervalMaxMs',
          'longGapProbability',
          'longGapMinMs',
          'longGapMaxMs',
          'maxSendPerMinute',
          'maxSendPerHour',
          'maxMessageChars',
          'maxGapMs',
          'gapBaseMs',
          'gapPerCharMs',
        ]) {
          if (merged.send[k] !== undefined) {
            const n = Number(merged.send[k]);
            merged.send[k] = Number.isFinite(n) ? n : (current.send?.[k] ?? 0);
            // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
            if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
          }
        }
        if (merged.send.longGapProbability !== undefined)
          merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
        if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
        if (merged.send.recommendedHint !== undefined)
          merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
      }
      // wait：数值归一化
      if (body.wait && typeof body.wait === 'object') {
        merged.wait = { ...(current.wait ?? {}), ...body.wait };
        for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
          if (merged.wait[k] !== undefined) {
            const n = Number(merged.wait[k]);
            merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : (current.wait?.[k] ?? 5000);
          }
        }
      }
      // proactive：主动机会参数
      if (body.proactive && typeof body.proactive === 'object') {
        merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
        for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
          if (merged.proactive[k] !== undefined) {
            const n = Number(merged.proactive[k]);
            merged.proactive[k] = Number.isFinite(n) ? n : (current.proactive?.[k] ?? 0);
            // 毫秒类字段统一非负取整；概率字段单独 clamp。
            if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
          }
        }
        if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
        if (merged.proactive.probability !== undefined)
          merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
        // 反重复参数：避免主动开口每次都聊同一个圈子。
        for (const k of [
          'rememberOpeners',
          'rememberSelfSaid',
          'suggestDomains',
          'domainCooldown',
          'openerChars',
          'repeatWindowHours',
        ]) {
          if (merged.proactive[k] !== undefined) {
            const n = Number(merged.proactive[k]);
            merged.proactive[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : Number(current.proactive?.[k]) || 0;
          }
        }
        if (merged.proactive.avoidRepeat !== undefined)
          merged.proactive.avoidRepeat = merged.proactive.avoidRepeat !== false;
        // 语义查重闸门：阈值是小数（0.5~0.99），不能走上面那条整型钳制（会被 round 成 1）。
        if (merged.proactive.repeatSimThreshold !== undefined) {
          const v = Number(merged.proactive.repeatSimThreshold);
          merged.proactive.repeatSimThreshold = Number.isFinite(v)
            ? Math.min(0.99, Math.max(0.5, v))
            : Number(current.proactive?.repeatSimThreshold) || 0.75;
        }
        if (merged.proactive.repeatGuard !== undefined)
          merged.proactive.repeatGuard = merged.proactive.repeatGuard !== false;
        for (const k of ['domains', 'avoidKeywords']) {
          if (merged.proactive[k] === undefined) continue;
          const raw = Array.isArray(merged.proactive[k])
            ? merged.proactive[k]
            : String(merged.proactive[k]).split(/[,，\n]+/);
          merged.proactive[k] = [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))].slice(0, 60);
        }
      }
      // sticker：表情包体系参数归一化
      if (body.sticker && typeof body.sticker === 'object') {
        // 保留未随请求提交的子段（例如控制台只改 collect 时不能顺手抹掉 pick）
        const keepPick = merged.sticker?.pick ?? current.sticker?.pick;
        merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
        if (keepPick && merged.sticker.pick === undefined) merged.sticker.pick = keepPick;
        if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
        for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
          if (merged.sticker[k] !== undefined) {
            const n = Number(merged.sticker[k]);
            merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : (current.sticker?.[k] ?? 0);
          }
        }
        if (merged.sticker.maxListCount !== undefined)
          merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
        if (merged.sticker.promptMaxStickers !== undefined)
          merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
        if (merged.sticker.includeInPrompt !== undefined)
          merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
        if (merged.sticker.autoLabel !== undefined) merged.sticker.autoLabel = merged.sticker.autoLabel === true;
        for (const [k, min, max] of [
          ['autoLabelPerTurn', 1, 6],
          ['manualLabelCount', 1, 10],
        ]) {
          if (merged.sticker[k] !== undefined) {
            const n = Number(merged.sticker[k]);
            merged.sticker[k] = Number.isFinite(n)
              ? Math.min(max, Math.max(min, Math.round(n)))
              : Number(current.sticker?.[k]) || min;
          }
        }
        if (body.sticker.collect && typeof body.sticker.collect === 'object') {
          merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
          if (merged.sticker.collect.enabled !== undefined)
            merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
          for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
            if (merged.sticker.collect[k] !== undefined) {
              const n = Number(merged.sticker.collect[k]);
              merged.sticker.collect[k] = Number.isFinite(n)
                ? Math.max(0, Math.round(n))
                : (current.sticker?.collect?.[k] ?? 0);
            }
          }
        }
        // pick：时机判断 + 选图参数（可单独提交，也可跟着 sticker 一起提交）
        const pickPatch =
          body.sticker.pick && typeof body.sticker.pick === 'object' && !Array.isArray(body.sticker.pick)
            ? body.sticker.pick
            : body.stickerPick && typeof body.stickerPick === 'object' && !Array.isArray(body.stickerPick)
              ? body.stickerPick
              : null;
        if (pickPatch) {
          merged.sticker.pick = { ...(current.sticker?.pick ?? {}), ...pickPatch };
          for (const k of [
            'minIntervalMs',
            'maxPerTurn',
            'minScore',
            'defaultLimit',
            'onlineCount',
            'libraryMaxSide',
            'libraryMaxRatio',
            'libraryMaxBytes',
          ]) {
            if (merged.sticker.pick[k] !== undefined) {
              const n = Number(merged.sticker.pick[k]);
              merged.sticker.pick[k] = Number.isFinite(n)
                ? Math.max(0, Math.round(n))
                : (current.sticker?.pick?.[k] ?? 0);
            }
          }
          if (merged.sticker.pick.minScore !== undefined)
            merged.sticker.pick.minScore = Math.min(100, merged.sticker.pick.minScore);
          if (merged.sticker.pick.libraryMaxRatio !== undefined)
            merged.sticker.pick.libraryMaxRatio = Number(merged.sticker.pick.libraryMaxRatio) || 0;
          if (merged.sticker.pick.librarySources !== undefined) {
            const list = Array.isArray(merged.sticker.pick.librarySources)
              ? merged.sticker.pick.librarySources
              : String(merged.sticker.pick.librarySources ?? '').split(/[,，\s]+/);
            merged.sticker.pick.librarySources = list
              .map(String)
              .map((x) => x.trim().toLowerCase())
              .filter(Boolean)
              .slice(0, 12);
          }
          if (merged.sticker.pick.defaultLimit !== undefined)
            merged.sticker.pick.defaultLimit = Math.min(20, Math.max(1, merged.sticker.pick.defaultLimit));
          if (merged.sticker.pick.onlineCount !== undefined)
            merged.sticker.pick.onlineCount = Math.min(12, Math.max(1, merged.sticker.pick.onlineCount));
          if (merged.sticker.pick.maxPerTurn !== undefined)
            merged.sticker.pick.maxPerTurn = Math.min(5, Math.max(1, merged.sticker.pick.maxPerTurn));
          for (const k of [
            'enabled',
            'hintInPrompt',
            'autoUseOnGoodMoment',
            'includeLibrary',
            'onlineFallback',
            'seedHome',
          ]) {
            if (merged.sticker.pick[k] !== undefined) merged.sticker.pick[k] = merged.sticker.pick[k] === true;
          }
          if (merged.sticker.pick.styleKeywords !== undefined) {
            const list = Array.isArray(merged.sticker.pick.styleKeywords)
              ? merged.sticker.pick.styleKeywords
              : String(merged.sticker.pick.styleKeywords ?? '').split(/[,，\s]+/);
            merged.sticker.pick.styleKeywords = list
              .map(String)
              .map((s) => s.trim())
              .filter(Boolean)
              .slice(0, 12);
          }
        }
      }
      // feedback：数值/布尔归一化
      if (body.feedback && typeof body.feedback === 'object') {
        merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
        if (merged.feedback.maxLength !== undefined) {
          const n = Number(merged.feedback.maxLength);
          merged.feedback.maxLength = Number.isFinite(n)
            ? Math.max(1, Math.round(n))
            : (current.feedback?.maxLength ?? 500);
        }
        if (merged.feedback.notifyOwnerOnError !== undefined)
          merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
      }
      // context：数值归一化
      if (body.context && typeof body.context === 'object') {
        merged.context = { ...(current.context ?? {}), ...body.context };
        for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
          if (merged.context[k] !== undefined) {
            const n = Number(merged.context[k]);
            merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : (current.context?.[k] ?? 20);
          }
        }
      }
      if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
      if (merged.provideRecommendations !== undefined)
        merged.provideRecommendations = merged.provideRecommendations === true;
      if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
      file.socialV2 = merged;
      atomicWriteJson(configFile, file);
      cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
      // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
      // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
      const WAKE_DEFAULT_KEYS = [
        'defaultMode',
        'recommendedDefaultInfinite',
        'recommendedSleepMinMs',
        'recommendedSleepMaxMs',
        'recommendedProbability',
        'recommendedKeywords',
        'recommendedAtMention',
        'recommendedNameMention',
        'recommendedQuestion',
        'recommendedPoke',
        'sleepMinMs',
        'sleepMaxMs',
        'batchWindowMs',
      ];
      const wakeDefaultChanged =
        body.wake &&
        typeof body.wake === 'object' &&
        WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
      if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
      log('控制台：聊天模式配置已更新');
      sendJson({ ok: true, config: cfg.socialV2 });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
      sendJson({ ok: true, paused: socialV2.paused });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
      const body = await readBody();
      const paused = body.paused === true;
      socialV2.paused = paused;
      if (paused) {
        clearAllSocialV2Timers();
        log('控制台：AI 已暂停（唤醒/等待任务已停止）');
      } else {
        log('控制台：AI 已恢复');
        for (const key of socialV2.conversations.keys()) {
          setupSleepTimerV2(key);
          scheduleProactiveCheckV2(key);
        }
      }
      saveSocialV2State();
      sendJson({ ok: true, paused: socialV2.paused });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
      deps.sessionEpoch++;
      sessionPromises.clear();
      clearAllSocialV2Timers();
      drainAllPromptQueues('状态已重置');
      for (const key of [...socialV2.conversations.keys()]) {
        const sid = deps.state.sessions[key];
        if (sid) {
          delete deps.state.sessions[key];
          reverse.delete(sid);
          collectors.delete(sid);
          v2TurnStartAt.delete(sid);
          toolCallNames.delete(sid);
          pendingSendToolCalls.delete(sid);
          sendToolSucceededSessions.delete(sid);
        }
        const removedV2 = socialV2.conversations.get(key);
        if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
        socialV2.conversations.delete(key);
        seenForwardIds.delete(key);
      }
      pendingWakeKeys.clear();
      clearAllPendingWakeLeases();
      wakeConfigUpdatedKeys.clear();
      markReadCalledKeys.clear();
      wakeConfigMissCount.clear();
      socialV2.paused = false;
      try {
        atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} });
      } catch (error) {
        log('重置状态：写空状态文件失败:', error?.message ?? error);
      }
      log('控制台：AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
      sendJson({ ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('socialState')) {
        sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403);
        return;
      }
      const st = getSocialV2State(key);
      // 首次访问会**铸造 agentToken**，必须立刻落盘：否则进程在后续任何一次
      // saveSocialV2State 之前重启，这个 token 就随内存一起消失，而 AI 侧还拿着旧的。
      saveSocialV2State();
      sendJson({
        ok: true,
        key,
        wakeConfig: st.wakeConfig,
        wakeSafety: computeWakeSafetyV2(st.wakeConfig),
        unreadCount: st.unread.length,
        recentCount: st.recentMessages.length,
        lastWakeReason: st.lastWakeReason,
        lastAiReplyAt: st.lastAiReplyAt,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403);
        return;
      }
      const st = getSocialV2State(key);
      // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
      if (cfg.socialV2?.sticker?.enabled !== false) {
        try {
          await syncStickerLibrary(false);
        } catch {}
      }
      const roleState = readRoleState();
      const toolMap = {
        getPrompt: 'qq_get_prompt',
        getUnread: 'qq_get_unread_messages',
        getRecent: 'qq_get_recent_messages',
        socialState: 'qq_social_state',
        sendGroup: 'qq_send_group_message',
        sendPrivate: 'qq_send_private_message',
        reply: 'qq_reply',
        sendBurst: 'qq_send_burst',
        sendMessage: 'qq_send_message',
        waitMessages: 'qq_wait_for_messages',
        feedback: 'qq_report_feedback',
        getMyRecent: 'qq_get_my_recent_messages',
        getMessageDetail: 'qq_get_message_detail',
        getActiveMembers: 'qq_get_active_members',
        setWakeConfig: 'qq_set_wake_config',
        markRead: 'qq_mark_read',
        memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
        slangQuery: 'qq_slang_query',
        slangSubmit: 'qq_slang_submit',
        knowledge: 'qq_knowledge_query / qq_knowledge_submit',
        getImages: 'qq_get_message_images',
        getForwardMsg: 'qq_get_forward_msg',
        sendPoke: 'qq_send_poke',
        sendVoice: 'qq_send_voice',
        listStickers: 'qq_list_stickers',
        getStickerImage: 'qq_get_sticker_image',
        sendSticker: 'qq_send_sticker',
        setStickerRemark: 'qq_set_sticker_remark',
        stickerNote: 'qq_sticker_note',
        collectSticker: 'qq_collect_sticker',
        saveSticker: 'qq_save_sticker',
        sendImage: 'qq_send_image',
        listImageLibrary: 'qq_list_image_library',
        searchImages: 'qq_search_images',
        // 工作车道（慢活外包）：把整条长任务投给独立会话，立即返回。
        runTask: 'qq_run_task',
        // 链接分享卡：只发桥接组装的固定形状卡片（不接受任意 json/xml）。
        sendCard: 'qq_send_card',
        // 主题探索：给种子关键词，后台把这一圈的梗和关联主题学回来。
        exploreTopic: 'qq_explore_topic',
        // 机器人自己的资料：昵称 / 个性签名 / 头像（默认关，且只认管理员上下文）。
        setProfile: 'qq_get_self_profile / qq_set_profile / qq_set_avatar',
        pickSticker: 'qq_pick_sticker',
        getSelfImage: 'qq_get_self_image',
        memberRemark: 'qq_get_member_remarks / qq_set_member_remark / qq_remove_member_remark',
        setMemberCard: 'qq_set_member_card',
      };
      const tools = cfg.socialV2?.tools ?? {};
      const stickerToolFlags = new Set([
        'listStickers',
        'getStickerImage',
        'sendSticker',
        'setStickerRemark',
        'stickerNote',
        'collectSticker',
        'saveSticker',
        'pickSticker',
      ]);
      // 默认关闭的工具：必须显式 true 才出现在可用工具表里（真·QQ 写操作）。
      const optInToolFlags = new Set(['setMemberCard', 'setProfile']);
      const enabledTools = [];
      for (const [flag, name] of Object.entries(toolMap)) {
        const on = optInToolFlags.has(flag) ? tools[flag] === true : tools[flag] !== false;
        if (on && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
      }
      sendJson({
        ok: true,
        key,
        time: new Date().toISOString(),
        role: {
          name: roleState.role ?? null,
          hint: deps.currentMode === 'chat' ? currentRoleHintV2() : currentRoleHint(),
        },
        recommended:
          cfg.socialV2?.provideRecommendations === false
            ? null
            : {
                wake: cfg.socialV2?.wake ?? {},
                send: cfg.socialV2?.send ?? {},
                wait: cfg.socialV2?.wait ?? {},
                proactive: cfg.socialV2?.proactive ?? {},
              },
        enabledTools,
        unreadCount: st.unread.length,
        recentCount: st.recentMessages.length,
        currentWakeConfig: st.wakeConfig,
        wakeSafety: computeWakeSafetyV2(st.wakeConfig),
        memory: formatMemoryV2(st),
        knowledge: {
          enabled: knowledgeEnabled(),
          total: deps.knowledgeEntries.filter((e) => isActiveStatus(e.status) && e.question && e.answer).length,
          injectMax: cfg.knowledge?.injectMax ?? 6,
          autoWrite: cfg.knowledge?.autoWrite !== false,
          remindHitCount: knowledgeRemindThreshold(),
          repeats: deps.knowledgeEntries
            .filter(
              (e) =>
                isActiveStatus(e.status) &&
                shouldRemindRepeat(e, knowledgeRemindThreshold(), knowledgeRemindMinAskers()),
            )
            .sort((a, b) => (Number(b.hitCount) || 0) - (Number(a.hitCount) || 0))
            .slice(0, 10)
            .map((e) => ({
              id: e.id,
              question: e.question,
              hitCount: Number(e.hitCount) || 0,
              askerCount: (e.askers || []).length,
            })),
          conflicts: listKnowledgeConflicts().slice(0, 10),
        },
        participation: formatParticipationV2(st),
        slang: {
          enabled: cfg.slang?.enabled !== false,
          entries: confirmedSlangListV2(),
          block: buildSlangContext(deps.slangEntries, cfg.slang?.injectMax ?? 8),
        },
        stickers: {
          enabled: cfg.socialV2?.sticker?.enabled !== false,
          total: deps.stickerEntries.length,
          context:
            cfg.socialV2?.sticker?.includeInPrompt !== false
              ? buildStickerContext(deps.stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8, {
                  autoLabel: cfg.socialV2?.sticker?.autoLabel !== false,
                  labelPerTurn: cfg.socialV2?.sticker?.autoLabelPerTurn ?? 2,
                })
              : '',
          strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : '',
          moment: buildStickerMomentLineV2(key, st),
          library: {
            enabled: readPickConfig().includeLibrary,
            total: readPickConfig().includeLibrary ? stickerLibraryItems().length : 0,
          },
        },
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getUnread')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403);
        return;
      }
      const st = getSocialV2State(key);
      const messages = st.unread.slice(-limit).map(agentMessageView);
      // 这些消息已经真正给过 AI 了，推进投递水位（让 wait 不再重复投递）。
      markDeliveredV2(st, messages);
      sendJson({ ok: true, key, unreadCount: st.unread.length, messages });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403);
        return;
      }
      const st = getSocialV2State(key);
      const start = Math.max(0, st.recentMessages.length - offset - limit);
      const end = Math.max(0, st.recentMessages.length - offset);
      const messages = st.recentMessages.slice(start, end).map(agentMessageView);
      markDeliveredV2(st, messages);
      sendJson({ ok: true, key, messages });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('markRead')) {
        sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403);
        return;
      }
      const st = getSocialV2State(key);
      // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
      // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
      if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st)) {
        const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
        const remaining = Math.max(0, preSleepMs - (st.lastIncomingAt || 0 ? Date.now() - st.lastIncomingAt : 0));
        const remainMin = Math.ceil(remaining / 60000);
        sendJson(
          {
            ok: false,
            error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
            preSleepWaitMs: preSleepMs,
            preSleepWaitRemainingMs: remaining,
          },
          400,
        );
        return;
      }
      const totalUnread = st.unread.length;
      // 只清「已经真正给过 AI」的那些（seq <= 投递水位）。
      // 剩下的说明 AI 从没看见过它（典型来源：两次 wait 之间到达的消息），
      // 直接清掉等于永久丢消息，保留在未读里，下次唤醒 / 下一次 wait 还能补上。
      const deliveredSeq = Number(st.deliveredSeq) || 0;
      const unseen = st.unread.filter((m) => m && (Number(m.seq) || 0) > deliveredSeq);
      st.unread = unseen;
      const markedCount = totalUnread - unseen.length;
      st.lastActionAt = Date.now();
      st.wakeConfig.noActionCount = 0;
      // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
      if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
        st.wakeConfig.infinite = true;
      }
      ensureWakeableV2(st, { key });
      st.wakeConfig.confirmedAt = Date.now();
      st.wakeConfig.confirmedBy = 'mark_read';
      markReadCalledKeys.add(key);
      saveSocialV2State();
      log(
        `[chat] 控制台/工具标记 ${key} 未读已读：${markedCount} 条${unseen.length ? `，保留 ${unseen.length} 条没看过的` : ''}，已确认下一次唤醒配置`,
      );
      sendJson({
        ok: true,
        key,
        markedCount,
        // 给 AI 一个明确信号：还有没看过的消息，别当收尾就完事。
        ...(unseen.length
          ? {
              keptUnread: unseen.length,
              note: `有 ${unseen.length} 条消息你还没看过（例如 ${String(unseen[0]?.sender ?? '')}：${String(unseen[0]?.text ?? '').slice(0, 40)}），已保留在未读里；请先 qq_get_unread_messages 看一遍再决定要不回复，不要当作没发生。`,
            }
          : {}),
        wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed,
        wakeSafety: computeWakeSafetyV2(st.wakeConfig),
        wakeConfig: st.wakeConfig,
      });
      // 有没看过的消息时，主动补一次唤醒，别让它们只有等下一条消息才有机会被看到。
      // 10 分钟护栏：万一 AI 反复 mark_read 却不看，也不会变成唤醒风暴。
      if (unseen.length && (!st.unseenNudgeAt || Date.now() - st.unseenNudgeAt > 10 * 60 * 1000)) {
        st.unseenNudgeAt = Date.now();
        scheduleWakeV2(key, 'unseenBacklog');
      }
      return;
    }
  }
  async function handleSocialV2ProfileRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled, persistConfig } = routeCtx;
    if (url.pathname === '/api/socialV2/user-profile') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const userId = String(url.searchParams.get('userId') ?? '').replace(/\D/g, '');
      if (!userId) {
        sendJson({ ok: false, error: 'userId 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('memberProfile')) {
        sendJson({ ok: false, error: '工具未启用：读用户资料' }, 403);
        return;
      }
      try {
        const stranger = await postOneBot(
          'get_stranger_info',
          { user_id: Number(userId) },
          { timeoutMs: 10000, retries: 1 },
        ).catch(() => null);
        const gm = /^group:(\d+)$/.exec(key)
          ? await postOneBot(
              'get_group_member_info',
              { group_id: Number(key.split(':')[1]), user_id: Number(userId) },
              { timeoutMs: 10000, retries: 1 },
            ).catch(() => null)
          : null;
        const fmt = (t) =>
          Number(t) ? new Date(Number(t) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '';
        sendJson({
          ok: true,
          userId,
          nickname: String(stranger?.nickname ?? gm?.nickname ?? ''),
          signature: String(stranger?.long_nick ?? ''),
          sex: String(stranger?.sex ?? ''),
          age: Number(stranger?.age) || 0,
          qqLevel: Number(stranger?.qq_level ?? stranger?.level) || 0,
          avatar: memberAvatarUrl(userId, 640),
          group: gm
            ? {
                card: String(gm.card ?? ''),
                role: String(gm.role ?? ''),
                level: String(gm.level ?? ''),
                title: String(gm.title ?? ''),
                joinTime: fmt(gm.join_time),
                lastSentTime: fmt(gm.last_sent_time),
              }
            : null,
          spaceUrl: `https://user.qzone.qq.com/${userId}`,
          spaceNote: '空间需要登录态，桥接读不了；只能给链接（对方设了权限也可能打不开）',
        });
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return;
    }
    // 插件→能力：控制台的「聊天模式 → 插件」用它渲染与开关
    if (url.pathname === '/api/socialV2/plugins') {
      if (!cfg.socialV2) cfg.socialV2 = {};
      if (!cfg.socialV2.plugins || typeof cfg.socialV2.plugins !== 'object') {
        cfg.socialV2.plugins = migrateLegacyTools(cfg.socialV2.tools || {});
        cfg.socialV2.pluginsVersion = 2;
        persistConfig();
      }
      if (req.method === 'GET') {
        sendJson({ ok: true, plugins: pluginCatalog(cfg.socialV2.plugins), raw: cfg.socialV2.plugins });
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody();
        const pid = String(body.plugin ?? '').trim();
        const cid = String(body.capability ?? '').trim();
        const on = body.enabled !== false;
        if (String(body.bulk ?? '') === 'all') {
          // 批量：全部插件开/关；开启时跳过需要人工确认的高危能力（能力表里 default 即"默认关"的那些）
          for (const pl of PLUGINS) {
            const cur0 = cfg.socialV2.plugins[pl.id] || {};
            cur0.capabilities = cur0.capabilities && typeof cur0.capabilities === 'object' ? cur0.capabilities : {};
            for (const c of pl.capabilities) {
              // 「全部开启」跳过 opt-in（高危）能力：改账号、改群名片、手机操作/命令
              cur0.capabilities[c.id] = on ? !OPT_IN_CAPS.has(`${pl.id}:${c.id}`) : false;
            }
            cur0.enabled = on;
            cfg.socialV2.plugins[pl.id] = cur0;
          }
          persistConfig();
          sendJson({ ok: true, plugins: pluginCatalog(cfg.socialV2.plugins) });
          return;
        }
        const cur = cfg.socialV2.plugins[pid];
        if (!cur || typeof cur !== 'object') {
          sendJson({ ok: false, error: '没有这个插件' }, 404);
          return;
        }
        if (cid) {
          if (!cur.capabilities || typeof cur.capabilities !== 'object') cur.capabilities = {};
          cur.capabilities[cid] = on;
          // 单独开某个能力时，把插件本身也打开（否则开了也没用）
          if (on) cur.enabled = true;
        } else {
          cur.enabled = on;
        }
        persistConfig();
        log(`[plugin] ${pid}${cid ? '/' + cid : ''} → ${on ? '开' : '关'}`);
        sendJson({ ok: true, plugins: pluginCatalog(cfg.socialV2.plugins) });
        return;
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) {
        sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403);
        return;
      }
      const st = getSocialV2State(key);
      const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
      const current = st.wakeConfig;
      const inputTriggers =
        input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
      const normalizeTriggerBool = (name, fallback) => {
        if (name in inputTriggers) return inputTriggers[name] === true;
        return fallback;
      };
      const rawKeywords = inputTriggers.keywords;
      const nextKeywords =
        rawKeywords !== undefined
          ? Array.isArray(rawKeywords)
            ? rawKeywords
                .map((k) => String(k ?? '').trim())
                .filter(Boolean)
                .slice(0, 50)
                .map((k) => k.slice(0, 100))
            : []
          : Array.isArray(current.triggers.keywords)
            ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100))
            : [];
      const next = {
        ...current,
        mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
        infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
        sleepUntil: current.sleepUntil,
        triggers: {
          ...current.triggers,
          ...inputTriggers,
          atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
          nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
          question: normalizeTriggerBool('question', current.triggers.question === true),
          anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
          poke: normalizeTriggerBool('poke', current.triggers.poke === true),
          keywords: nextKeywords,
        },
        batchWindowMs:
          Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
            ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
            : current.batchWindowMs,
      };
      // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
      if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
        next.triggers.anyMessage = false;
      }
      if (next.mode === 'active') {
        next.infinite = true;
        next.sleepUntil = null;
        next.triggers.anyMessage = true;
      }
      if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
      if (next.infinite) {
        next.sleepUntil = null;
      } else if (input.sleepUntil) {
        const d = new Date(String(input.sleepUntil));
        if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
      } else if (Number.isFinite(Number(input.sleepMs))) {
        let ms = Math.max(0, Math.round(Number(input.sleepMs)));
        const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
        const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
        if (ms < minMs) ms = minMs;
        if (maxMs > 0 && ms > maxMs) ms = maxMs;
        next.sleepUntil = new Date(Date.now() + ms).toISOString();
      } else if (!next.sleepUntil && !next.infinite) {
        // 既没有无限也没有时间：使用推荐默认有限时长
        const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
        const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
        const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
        next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
      }
      // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
      if (!next.infinite && next.sleepUntil) {
        const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
        const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
        let until = Date.parse(next.sleepUntil);
        if (Number.isFinite(until)) {
          if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
          if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
          next.sleepUntil = new Date(until).toISOString();
        }
      }
      // 归一化概率
      if (next.triggers.probability !== undefined) {
        next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
      }
      // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
      if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
        next.triggers.poke = input.triggers.poke === true;
      }
      // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
      // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
      next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
      // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
      if (key.startsWith('private:')) {
        next.triggers.speakerIds = [];
      }
      // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
      if (next.infinite) {
        const tr = next.triggers ?? {};
        const hasTrigger =
          tr.atMention ||
          tr.nameMention ||
          tr.poke ||
          (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
          tr.question ||
          tr.anyMessage ||
          Number(tr.probability) > 0 ||
          (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
        if (!hasTrigger) {
          sendJson(
            {
              ok: false,
              error:
                '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠',
            },
            400,
          );
          return;
        }
      }
      // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
      if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st)) {
        const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
        const remaining = Math.max(0, preSleepMs - (st.lastIncomingAt || 0 ? Date.now() - st.lastIncomingAt : 0));
        const remainMin = Math.ceil(remaining / 60000);
        sendJson(
          {
            ok: false,
            error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
            preSleepWaitMs: preSleepMs,
            preSleepWaitRemainingMs: remaining,
          },
          400,
        );
        return;
      }
      // 常驻活跃：这些群不允许它自己潜水（否则一条消息都唤不醒，线上反复出现）
      const forceActive = Array.isArray(cfg.socialV2?.wake?.forceActive) ? cfg.socialV2.wake.forceActive : [];
      if (forceActive.includes(key)) {
        next.mode = 'active';
        next.infinite = true;
        next.sleepUntil = null;
        next.triggers = { ...(next.triggers || {}), anyMessage: true };
      }

      st.wakeConfig = next;
      st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
      st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
      st.wakeConfig.noActionCount = 0;
      st.wakeConfig.confirmedAt = Date.now();
      st.wakeConfig.confirmedBy = 'set_wake_config';
      st.lastActionAt = Date.now();
      // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
      st.preSleepWaitSatisfiedAt = 0;
      st.preSleepWaitObservedAt = 0;
      st.preSleepWaitAccumMs = 0;
      saveSocialV2State();
      wakeConfigUpdatedKeys.add(key);
      wakeConfigMissCount.delete(key);
      if (st.pendingWakeTimer) {
        clearTimeout(st.pendingWakeTimer);
        st.pendingWakeTimer = null;
      }
      cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
      setupSleepTimerV2(key);
      log(
        `[chat] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`,
      );
      sendJson({ ok: true, key, wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
      const list = [];
      const pickCfg = readPickConfig();
      const libItems = pickCfg.enabled !== false && pickCfg.includeLibrary ? stickerLibraryItems() : [];
      for (const [key, st] of socialV2.conversations) {
        const moment =
          pickCfg.enabled === false
            ? null
            : evaluateMoment(st, {
                cfg: pickCfg,
                context: pickContextTextV2(st),
                lastIncomingText: lastIncomingTextV2(st),
              });
        list.push({
          key,
          wakeConfig: st.wakeConfig,
          unreadCount: st.unread.length,
          recentCount: st.recentMessages.length,
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          noActionCount: st.wakeConfig.noActionCount || 0,
          sticker: moment
            ? {
                allowed: moment.allowed,
                level: moment.level,
                reason: moment.reason,
                lastStickerMinAgo: moment.lastStickerMinAgo,
                cooldownLeftMs: moment.cooldownLeftMs,
                thisTurn: moment.stickersThisTurn,
                pool: deps.stickerEntries.length + libItems.length,
              }
            : null,
        });
      }
      sendJson({
        ok: true,
        conversations: list,
        pick: {
          enabled: pickCfg.enabled,
          minScore: pickCfg.minScore,
          onlineFallback: pickCfg.onlineFallback,
          minIntervalMs: pickCfg.minIntervalMs,
          library: libItems.length,
        },
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const reason = String(body.reason ?? 'admin').trim() || 'admin';
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (deps.currentMode !== 'chat') {
        sendJson({ ok: false, error: '该接口仅 chat 模式可用' }, 403);
        return;
      }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      const st = getSocialV2State(key);
      if (st.pendingWakeTimer) {
        clearTimeout(st.pendingWakeTimer);
        st.pendingWakeTimer = null;
      }
      if (!st.bootstrapSent) st.bootstrapSent = true;
      saveSocialV2State();
      // 必须 await + catch：以前这里是一句裸调用，函数里一旦抛异常就变成
      // 「未处理异常」，控制台看到的是 ok:true（像成功了），实际唤醒被丢掉。
      try {
        await sendWakePromptV2(key, reason);
        log(`控制台：手动唤醒 ${key}（${reason}）`);
        sendJson({ ok: true, key, reason });
      } catch (error) {
        log(`控制台：手动唤醒 ${key} 失败：${error?.message ?? error}`);
        sendJson({ ok: false, error: `唤醒失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
  }
  async function handleSocialV2TaskRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'POST' && url.pathname === '/api/socialV2/send-card') {
      if (cfg.socialV2?.card?.enabled === false) {
        sendJson({ ok: false, error: '卡片发送已关闭' }, 403);
        return;
      }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (!/^(group|private):\d+$/.test(key)) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('sendCard')) {
        sendJson({ ok: false, error: '工具未启用：qq_send_card' }, 403);
        return;
      }
      const st = getSocialV2State(key);
      const cardCfg = resolveCardConfig();
      const now = Date.now();
      const recentMinute = (st.cardSendTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.cardSendTimes || []).filter((t) => now - t < 3600000).length;
      if (
        (cardCfg.maxPerMinute > 0 && recentMinute + 1 > cardCfg.maxPerMinute) ||
        (cardCfg.maxPerHour > 0 && recentHour + 1 > cardCfg.maxPerHour)
      ) {
        sendJson({ ok: false, error: '发卡片太频繁了，请过一会儿再试' }, 429);
        return;
      }
      st.cardSendTimes = st.cardSendTimes || [];
      st.cardSendTimes.push(now);
      if (st.cardSendTimes.length > 500) st.cardSendTimes = st.cardSendTimes.slice(-500);
      try {
        const result = await sendCardV2(key, {
          url: body.url,
          title: body.title,
          desc: body.desc,
          preview: body.preview,
          source: body.source,
          replyToMessageId: body.replyToMessageId,
          atUserId: body.atUserId,
        });
        saveSocialV2State();
        log(
          `[card] 发送分享卡 ${key}: ${result.title || result.url}${result.delivered === false ? '（⚠ 未送达）' : result.delivered === null ? '（送达待确认）' : ''}`,
        );
        const warnings = [
          '⚠️ 实测：当前网关协议版本下，QQ 客户端多半只显示「发送者版本过低，无法展示内容」这个占位气泡' +
            '（消息本身是被正常接受的，message_seq 有值，门禁在 QQ 的**发送端协议版本**上，桥接改不了）。' +
            '要分享链接，更实际的做法是用 qq_send_message 发「标题 + 完整链接」。',
          '卡片的渲染细节由 QQ 客户端决定：能渲染的版本上也可能只显示兜底文本「[分享] 标题 + 链接」，这是客户端行为。',
          '不要在同一条卡片里再附带文字（一条消息只能是一张卡）；想说话请另外调 qq_send_message。',
        ];
        if (result.delivered === null) {
          warnings.push(
            '送达回执没能在回合内确认出来（大消息走 WS 时常见）。**不要重发同一张卡**，重复卡片就是这么来的。',
          );
          warnings.push('QQ 静默丢弃时 get_msg 的 message_seq 会停在 0。');
        } else if (result.delivered === false) {
          warnings.push(
            '这次确认**没有送达**（get_msg 一直停在 message_seq=0），多半被 QQ 侧拦了，别对同一条链接反复重试。',
          );
        }
        sendJson({
          ok: true,
          key,
          delivered: result.delivered === null ? null : result.delivered === true,
          messageId: result.data?.message_id ?? null,
          card: { title: result.title, desc: result.desc, url: result.url, preview: result.preview },
          warning: warnings.join(''),
        });
      } catch (error) {
        st.cardSendTimes = st.cardSendTimes.filter((t) => t !== now);
        if (error?.uncertain === true) {
          log(`[card] ⚠ 发送结果不确定 ${key}：${error?.message ?? error}`);
          sendJson(
            {
              ok: false,
              uncertain: true,
              key,
              error: `${error?.message ?? error}。别重发同一张卡：重复卡片就是这么来的，先用 qq_get_my_recent_messages 确认到底发出去没有。`,
            },
            502,
          );
          return;
        }
        sendJson({ ok: false, error: `发送卡片失败：${error?.message ?? error}` }, 400);
      }
      return;
    }
    // ── 把长任务丢给工作车道（qq_run_task）────────────────────────────
    // 立即返回：聊天会话这一轮不用等任务跑完，所以「发图/搜图/看视频」这类慢活
    // 不再把整条会话堵死（见 workSessions 声明处的说明）。
    if (req.method === 'POST' && url.pathname === '/api/socialV2/run-task') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const task = String(body.task ?? '').trim();
      if (!key || !task) {
        sendJson({ ok: false, error: 'key 和 task 不能为空' }, 400);
        return;
      }
      if (!/^(group|private):\d+$/.test(key)) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('runTask')) {
        sendJson({ ok: false, error: '工具未启用：qq_run_task' }, 403);
        return;
      }
      if (!workLaneEnabled()) {
        sendJson(
          { ok: false, error: '工作车道未启用（控制台「工具」里打开，或 config.json socialV2.work.enabled）' },
          403,
        );
        return;
      }
      if (deps.currentMode !== 'chat') {
        sendJson({ ok: false, error: '工作车道仅在聊天模式下可用' }, 403);
        return;
      }
      if (!deps.dshReady) {
        sendJson({ ok: false, error: 'DSH 不可用，稍后再试' }, 503);
        return;
      }
      try {
        const result = await deliverWorkTask(key, task, { note: body.note });
        sendJson({
          ok: true,
          key,
          lane: result.sessionId,
          queued: result.queued,
          position: result.position,
          // 关键：明确告诉 AI「你没在等」，它这一轮可以照常接别的话。
          note: result.queued
            ? `工作车道都占着，这条排在第 ${result.position} 位，仍然不影响你继续聊天。`
            : '已交给独立的工作车道，它自己会跑完并把结论回投给你；你这一轮不用等它，可以继续接别的话。',
        });
      } catch (error) {
        log(`[work] ${key} 投递失败：${error?.message ?? error}`);
        sendJson({ ok: false, error: `交给工作车道失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
  }
  async function handleSocialV2SendRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      let rawMessages = body.messages;
      if (typeof rawMessages === 'string') {
        const trimmed = rawMessages.trim();
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') rawMessages = parsed;
            else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch {}
        }
      }
      const messages = Array.isArray(rawMessages)
        ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
        : typeof rawMessages === 'string'
          ? [String(rawMessages).trim()].filter(Boolean)
          : [];
      const replyToMessageId = body.replyToMessageId;
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
        return;
      }
      if (!key || !messages.length) {
        sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
        return;
      }
      const sendCfgBurst = cfg.socialV2?.send ?? {};
      if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
        sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) {
        sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403);
        return;
      }
      if (deps.currentMode !== 'chat') {
        sendJson({ ok: false, error: '该接口仅 chat 模式可用' }, 403);
        return;
      }
      if (!req.headers['x-agent-token']) {
        sendJson({ ok: false, error: 'chat 模式发送必须携带 agent token' }, 403);
        return;
      }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (shouldBlockSilentReply(key)) {
        sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
        return;
      }
      const sendCfg = cfg.socialV2?.send ?? {};
      const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
      const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
      if (messages.length > maxMsgs) {
        sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
        return;
      }
      for (const msg of messages) {
        if (msg.length > maxChars) {
          sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
          return;
        }
        if (SENSITIVE_RE.test(msg)) {
          sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
          return;
        }
      }
      // st/now 必须留在 try 外面：catch 里回滚发送额度时要用（原来写在 try 内，
      // 一旦发送失败，catch 反而抛 ReferenceError，真实错误被盖成 500）。
      const st = getSocialV2State(key);
      const now = Date.now();
      try {
        const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
        const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
        const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
        const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
        if (
          (maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) ||
          (maxPerHour > 0 && recentHour + messages.length > maxPerHour)
        ) {
          sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
          return;
        }
        // 先预占发送额度，避免并发绕过限频
        for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
        const sentMessages = await sendMessagesV2(key, messages, delays);
        recordSentMessagesV2(key, sentMessages);
        st.lastAiReplyAt = now;
        st.lastActionAt = now;
        st.wakeConfig.noActionCount = 0;
        saveSocialV2State();
        log(`[chat] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
        appendActivity(`${key} [chat] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
        if (sentMessages.length > 0) scheduleReplyCheckV2(key);
        // 原来硬编码 >=3 条就劝阻，等于否定了「复杂任务可以长」。
        // 现在阈值可配，且文案明确把正经事排除在外。
        const burstHintThreshold = Math.max(3, Number(sendCfg.burstHintThreshold) || 10);
        const burstHint =
          messages.length >= burstHintThreshold
            ? '你连发了较多条。如果这是在回答分析/资料/正经问题，忽略这条提示；如果只是闲聊，真人很少一口气补完。'
            : undefined;
        const spaceWarn = findCjkSpaceWarning(messages);
        const splitWarn = findSplitBoundaryWarning(messages);
        sendJson({
          ok: true,
          key,
          sent: sentMessages.length,
          failed: messages.length - sentMessages.length,
          ...(burstHint ? { hint: burstHint } : {}),
          ...(spaceWarn ? { warn: spaceWarn } : {}),
          ...(splitWarn ? { splitWarn } : {}),
        });
      } catch (error) {
        if (error?.sent?.length) {
          recordSentMessagesV2(key, error.sent);
          log(`[chat] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
        }
        // 失败/未发出的消息回滚预占的发送额度，避免假 429。
        const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
        const failedCount = Math.max(0, messages.length - sentCount);
        for (let i = 0; i < failedCount; i++) {
          const idx = st.sendTimes.indexOf(now);
          if (idx >= 0) st.sendTimes.splice(idx, 1);
        }
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        saveSocialV2State();
        sendJson(
          {
            ok: false,
            error: error?.message ?? String(error),
            // 回执超时且历史查不到：这条可能已经发出。让上游（MCP）据此提示模型「别原样重发」。
            ...(error?.uncertain === true
              ? {
                  uncertain: true,
                  hint: '这条可能已经发出（回执超时、历史里也没查到）：不要原样重发，先用 qq_get_recent_messages 确认最后几条。',
                }
              : {}),
            // 自我重复闸门：**没发出去**，是有意打回，让模型换个题再说（这不是错误）。
            ...(error?.selfRepeat === true ? { selfRepeat: true, detail: error?.detail ?? null } : {}),
            // 原样重发闸门：也是**有意拒发**，让 MCP 返回非错误结果、别诱导模型反复重试。
            ...(error?.duplicateGuard === true ? { duplicateGuard: true, detail: error?.detail ?? null } : {}),
          },
          500,
        );
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      let rawMessages = body.messages;
      if (typeof rawMessages === 'string') {
        const trimmed = rawMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') rawMessages = parsed;
            else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch {}
        }
      }
      const isRawString = typeof rawMessages === 'string';
      const messages = Array.isArray(rawMessages)
        ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
        : isRawString
          ? [String(rawMessages).trim()].filter(Boolean)
          : [];
      const replyToMessageId = body.replyToMessageId;
      const atUserId = body.atUserId ?? null;
      // 不再按空格自动分条：字符串就是一条消息；数组模式原样使用调用方间隔。
      const gapMode =
        isRawString && messages.length > 1
          ? 'auto'
          : body.gapMode === 'fixed' || body.gapMode === 'byLength'
            ? body.gapMode
            : 'auto';
      const gapMs = Number(body.gapMs);
      const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
      if (!key || !messages.length) {
        sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
        return;
      }
      const sendCfgBurst = cfg.socialV2?.send ?? {};
      if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
        sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) {
        sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403);
        return;
      }
      if (deps.currentMode !== 'chat') {
        sendJson({ ok: false, error: '该接口仅 chat 模式可用' }, 403);
        return;
      }
      if (!req.headers['x-agent-token']) {
        sendJson({ ok: false, error: 'chat 模式发送必须携带 agent token' }, 403);
        return;
      }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (kind === 'private' && atUserId) {
        sendJson({ ok: false, error: '私聊不需要 @' }, 400);
        return;
      }
      if (shouldBlockSilentReply(key)) {
        sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
        return;
      }
      if (
        replyToMessageId !== undefined &&
        replyToMessageId !== null &&
        String(replyToMessageId).trim() !== '' &&
        !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())
      ) {
        sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
        return;
      }
      const sendCfg = cfg.socialV2?.send ?? {};
      const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
      const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
      if (messages.length > maxMsgs) {
        sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
        return;
      }
      for (const msg of messages) {
        if (msg.length > maxChars) {
          sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
          return;
        }
        if (SENSITIVE_RE.test(msg)) {
          sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
          return;
        }
      }
      const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
      // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
      const st = getSocialV2State(key);
      const now = Date.now();
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
      if (
        (maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) ||
        (maxPerHour > 0 && recentHour + messages.length > maxPerHour)
      ) {
        sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
        return;
      }
      // 先预占发送额度，避免并发绕过限频
      for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      let quotedInfo = null;
      let actualReplyToMessageId = replyToMessageId;
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
        if (!resolved) {
          // 引用解析失败：回滚已预占的发送额度
          for (let i = 0; i < messages.length; i++) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
          }
          saveSocialV2State();
          sendJson(
            {
              ok: false,
              error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）',
            },
            400,
          );
          return;
        }
        quotedInfo = resolved.info;
        actualReplyToMessageId = resolved.messageId;
      }
      try {
        const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
        recordSentMessagesV2(key, sentMessages);
        st.lastAiReplyAt = now;
        st.lastActionAt = now;
        st.wakeConfig.noActionCount = 0;
        saveSocialV2State();
        log(`[chat] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
        appendActivity(`${key} [chat] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
        if (sentMessages.length > 0) scheduleReplyCheckV2(key);
        // 原来硬编码 >=3 条就劝阻，等于否定了「复杂任务可以长」。
        // 现在阈值可配，且文案明确把正经事排除在外。
        const burstHintThreshold = Math.max(3, Number(sendCfg.burstHintThreshold) || 10);
        const burstHint =
          messages.length >= burstHintThreshold
            ? '你连发了较多条。如果这是在回答分析/资料/正经问题，忽略这条提示；如果只是闲聊，真人很少一口气补完。'
            : undefined;
        const spaceWarn = findCjkSpaceWarning(messages);
        const splitWarn = findSplitBoundaryWarning(messages);
        sendJson({
          ok: true,
          key,
          sent: sentMessages.length,
          failed: messages.length - sentMessages.length,
          delays,
          quoted: quotedInfo,
          ...(burstHint ? { hint: burstHint } : {}),
          ...(spaceWarn ? { warn: spaceWarn } : {}),
          ...(splitWarn ? { splitWarn } : {}),
        });
      } catch (error) {
        if (error?.sent?.length) {
          recordSentMessagesV2(key, error.sent);
          log(`[chat] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
        }
        // 失败/未发出的消息回滚预占的发送额度，避免假 429。
        const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
        const failedCount = Math.max(0, messages.length - sentCount);
        for (let i = 0; i < failedCount; i++) {
          const idx = st.sendTimes.indexOf(now);
          if (idx >= 0) st.sendTimes.splice(idx, 1);
        }
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        saveSocialV2State();
        sendJson(
          {
            ok: false,
            error: error?.message ?? String(error),
            // 回执超时且历史查不到：这条可能已经发出。让上游（MCP）据此提示模型「别原样重发」。
            ...(error?.uncertain === true
              ? {
                  uncertain: true,
                  hint: '这条可能已经发出（回执超时、历史里也没查到）：不要原样重发，先用 qq_get_recent_messages 确认最后几条。',
                }
              : {}),
            // 自我重复闸门：**没发出去**，是有意打回，让模型换个题再说（这不是错误）。
            ...(error?.selfRepeat === true ? { selfRepeat: true, detail: error?.detail ?? null } : {}),
            // 原样重发闸门：也是**有意拒发**，让 MCP 返回非错误结果、别诱导模型反复重试。
            ...(error?.duplicateGuard === true ? { duplicateGuard: true, detail: error?.detail ?? null } : {}),
          },
          500,
        );
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (deps.currentMode !== 'chat') {
        sendJson({ ok: false, error: '该接口仅 chat 模式可用' }, 403);
        return;
      }
      if (!req.headers['x-agent-token']) {
        sendJson({ ok: false, error: 'chat 模式发送拍一拍必须携带 agent token' }, 403);
        return;
      }
      if (!agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (!v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (!v2ToolEnabled('sendPoke')) {
        sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403);
        return;
      }
      if (socialV2.paused) {
        sendJson({ ok: false, error: 'AI 已暂停，不能发送拍一拍' }, 403);
        return;
      }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
        return;
      }
      if (shouldBlockSilentReply(key)) {
        sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403);
        return;
      }
      if (kind === 'group' && !targetUserId) {
        sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
        return;
      }
      if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
        sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
        return;
      }
      const st = getSocialV2State(key);
      const sendCfg = cfg.socialV2?.send ?? {};
      const now = Date.now();
      const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
      const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
      const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
      if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
        sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
        return;
      }
      st.sendTimes.push(now);
      if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
      try {
        if (kind === 'group') {
          await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
        } else {
          // 私聊拍一拍：send_poke 自动路由到当前私聊对象
          await bot.raw('send_poke', { user_id: id });
        }
        st.lastActionAt = now;
        st.lastAiReplyAt = now;
        st.wakeConfig.noActionCount = 0;
        const pokeText = kind === 'group' ? `[拍一拍] 我拍了拍 ${targetUserId}` : '[拍一拍] 我拍了拍你';
        st.recentMessages.push({
          messageId: null,
          sender: '我',
          text: pokeText,
          plain: pokeText,
          tail: pokeText,
          kind: 'poke',
          quoteTargetIsSelf: false,
          isOwner: true,
          ownerLabel: '我',
          isSelf: true,
          media: [],
          hasMedia: false,
          forwardIds: [],
          hasForward: false,
          poke: {
            targetId: targetUserId || String(id),
            targetIsSelf: false,
            groupId: kind === 'group' ? String(id) : null,
          },
          time: Date.now(),
        });
        const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
        if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
        st.preSleepWaitSatisfiedAt = 0;
        st.preSleepWaitObservedAt = 0;
        st.preSleepWaitAccumMs = 0;
        saveSocialV2State();
        log(`[chat] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
        appendActivity(`${key} [chat] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
        sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
      } catch (error) {
        const idx = st.sendTimes.indexOf(now);
        if (idx >= 0) st.sendTimes.splice(idx, 1);
        if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
        log(`[chat] 工具拍一拍失败 ${key}:`, error?.message ?? error);
        sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
  }
  async function handleSocialV2WaitRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) {
        sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403);
        return;
      }
      if (socialV2.paused) {
        const st = getSocialV2State(key);
        sendJson({
          ok: true,
          key,
          paused: true,
          arrived: false,
          timeout: false,
          waitedMs: 0,
          newMessages: [],
          unreadCount: st.unread.length,
        });
        return;
      }
      const waitCfg = cfg.socialV2?.wait ?? {};
      const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
      const defaultMs = Number(waitCfg.defaultMs) || 30000;
      const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
      const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
      const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
      const st = getSocialV2State(key);
      // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
      if (activeWaits.has(key)) {
        sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
        return;
      }
      activeWaits.add(key);
      const finishWait = () => activeWaits.delete(key);
      req.on('close', finishWait);
      const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs))
        ? Math.max(0, Number(waitCfg.minQuietAfterNewMs))
        : 10000;
      const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
      const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
      // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
      // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
      // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
      const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
      const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
      if (st.pendingWakeTimer) {
        clearTimeout(st.pendingWakeTimer);
        st.pendingWakeTimer = null;
      }
      cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
      // baseline 用「已投递给 AI 的水位线」，而不是「本次 wait 开始时的最新 seq」：
      // 后者会让两次 wait 之间到达的消息永久消失在缝里（见 markDeliveredV2 的说明）。
      const baseline = Number(st.deliveredSeq) || 0;
      const start = Date.now();
      let arrived = false;
      let lastNewAt = 0;
      let aborted = false;
      req.on('close', () => {
        aborted = true;
      });
      while (Date.now() - start < timeoutMs && !aborted) {
        let nowSeq = st.lastUnreadSeq || 0;
        if (nowSeq - baseline >= minNew) {
          arrived = true;
          lastNewAt = Date.now();
          // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
          // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
          while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
            if ((st.lastUnreadSeq || 0) > nowSeq) {
              nowSeq = st.lastUnreadSeq || 0;
              lastNewAt = Date.now();
            }
            await sleep(200);
          }
          break;
        }
        await sleep(300);
      }
      const waitedMs = Date.now() - start;
      const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
      const preSleepRemainingMs = preSleepWaitBlockedV2(st)
        ? Math.max(0, preSleepWaitMs - (st.lastIncomingAt || 0 ? Date.now() - st.lastIncomingAt : 0))
        : 0;
      const quiet = arrived && quietMs > 0 && Date.now() - lastNewAt >= quietMs;
      // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
      // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
      const preSleepAttempt = timeoutMs >= preSleepWaitMs;
      // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
      // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
      const preSleepSatisfiedNow = !arrived
        ? waitedMs >= preSleepWaitMs
        : quiet && Date.now() - lastNewAt >= preSleepWaitMs;
      if (preSleepSatisfiedNow) {
        st.preSleepWaitSatisfiedAt = Date.now();
        st.preSleepWaitObservedAt = 0;
        st.preSleepWaitAccumMs = 0;
      } else if (!arrived) {
        // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
        st.preSleepWaitAccumMs = 0;
      } else {
        // 等待期间有新消息：
        // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
        // - 否则只清空累计，不算完成沉睡前观察。
        if (preSleepAttempt) {
          st.preSleepWaitObservedAt = Date.now();
        }
        st.preSleepWaitAccumMs = 0;
      }
      const newMessages = arrived
        ? (Array.isArray(st.recentMessages) ? st.recentMessages : []).filter(
            (m) => m && !m.isSelf && (m.seq || 0) > baseline,
          )
        : [];
      // 投出去才算「给过 AI」：下一步的 wait 不会再把同一批重复贴一遍。
      markDeliveredV2(st, newMessages);
      saveSocialV2State();
      const lastNew = newMessages.length ? newMessages[newMessages.length - 1] : null;
      const lastMessageUnfinished = lastNew
        ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || ''))
        : false;
      finishWait();
      sendJson({
        ok: true,
        key,
        arrived,
        quiet,
        quietMs,
        suggestedQuietMs,
        speakerLikelyDone: quiet,
        lastMessageUnfinished,
        timeout: !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
        waitedMs,
        preSleepWaitSatisfied: preSleepSatisfiedNow,
        preSleepWaitObserved: !!st.preSleepWaitObservedAt,
        preSleepWaitMs,
        preSleepWaitRemainingMs: preSleepRemainingMs,
        newMessages,
        unreadCount: st.unread.length,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const tool = String(body.tool ?? '').trim();
      const token = String(body.token ?? '').trim();
      if (!key || !tool || !token) {
        sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
        return;
      }
      if (!agentTokenOk(key, token)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (!v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
      const flag = flagMap[tool];
      if (!flag) {
        sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
        return;
      }
      if (!v2ToolEnabled(flag)) {
        sendJson(
          {
            ok: false,
            error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}`,
          },
          403,
        );
        return;
      }
      sendJson({ ok: true, key, tool });
      return;
    }
  }
  async function handleSocialV2ExtrasRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/socialV2/friend-dress') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const userId = String(url.searchParams.get('userId') ?? '').trim();
      const withImage = url.searchParams.get('withImage') === '1';
      if (!key || !userId) {
        sendJson({ ok: false, error: 'key 和 userId 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getFriendDress')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_friend_dress' }, 403);
        return;
      }
      try {
        const resp = await bot.request('_get_friend_dress', { user_id: Number(userId) });
        if (resp?.status && resp.status !== 'ok') throw new Error(resp.wording || resp.retcode || 'onebot 调用失败');
        const data = resp?.data ?? resp ?? {};
        const items = (Array.isArray(data.items) ? data.items : []).map((it) => ({
          kind: it?.kind ?? '',
          name: it?.name ?? '',
          itemId: it?.item_id ?? it?.itemId ?? 0,
          previewUrl: it?.preview_url ?? it?.previewUrl ?? '',
          videoUrl: it?.video_url ?? it?.videoUrl ?? '',
          price: it?.price ?? 0,
        }));
        const out = {
          ok: true,
          key,
          userId,
          isSvip: data.is_svip === true,
          avatarUrl: data.avatar_url || memberAvatarUrl(userId),
          items,
        };
        if (withImage) {
          // 优先取「挂件」，取不到就取第一个有预览图的
          const target =
            items.find((it) => it.kind.includes('挂件') && it.previewUrl) || items.find((it) => it.previewUrl);
          if (target) {
            try {
              const fetched = await safeFetchBuffer(target.previewUrl, 4 * 1024 * 1024);
              if (looksLikeImageBuffer(fetched.buffer)) {
                out.image = {
                  kind: target.kind,
                  name: target.name,
                  mimeType: mimeFromBuffer(fetched.buffer),
                  data: fetched.buffer.toString('base64'),
                };
              }
            } catch (error) {
              out.imageError = `预览图取回失败：${error?.message ?? error}`;
            }
          }
        }
        log(`[dress] ${key} 查询 ${userId} 装扮：${items.length} 项${out.image ? '（含预览图）' : ''}`);
        sendJson(out);
      } catch (error) {
        sendJson({ ok: false, error: `查询装扮失败：${error?.message ?? error}` }, 500);
      }
      return;
    }

    // 群成员/群头像（qq_get_member_avatar）：把头像取回来交给视觉模型
    if (req.method === 'GET' && url.pathname === '/api/socialV2/member-avatar') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const userId = String(url.searchParams.get('userId') ?? '').trim();
      const size = Number(url.searchParams.get('size')) || 640;
      if (!key || !userId) {
        sendJson({ ok: false, error: 'key 和 userId 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getMemberAvatar')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_member_avatar' }, 403);
        return;
      }
      const isGroup = userId === 'group';
      const avatarUrl = isGroup ? groupAvatarUrl(key.split(':')[1], size) : memberAvatarUrl(userId, size);
      if (!avatarUrl) {
        sendJson({ ok: false, error: 'userId 无效' }, 400);
        return;
      }
      try {
        const fetched = await safeFetchBuffer(avatarUrl, 4 * 1024 * 1024);
        if (!looksLikeImageBuffer(fetched.buffer)) {
          sendJson({ ok: false, error: '取回的内容不是图片' }, 500);
          return;
        }
        sendJson({
          ok: true,
          key,
          userId,
          avatar: avatarUrl,
          mimeType: mimeFromBuffer(fetched.buffer),
          data: fetched.buffer.toString('base64'),
        });
      } catch (error) {
        sendJson({ ok: false, error: `取头像失败：${error?.message ?? error}` }, 500);
      }
      return;
    }

    // 本地图库列表（qq_list_image_library）：让 AI 知道 assets/stickers/ 里有哪些图可用
    if (req.method === 'GET' && url.pathname === '/api/socialV2/image-library') {
      if (cfg.socialV2?.image?.enabled === false) {
        sendJson({ ok: false, error: '图片功能已关闭' }, 403);
        return;
      }
      const key = String(url.searchParams.get('key') ?? '').trim();
      if (req.headers['x-agent-token']) {
        if (!key || !agentTokenOk(key, req.headers['x-agent-token'])) {
          sendJson({ ok: false, error: 'agent token 无效' }, 403);
          return;
        }
        if (!v2SessionAllowed(key)) {
          sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
          return;
        }
        if (!v2ToolEnabled('listImageLibrary')) {
          sendJson({ ok: false, error: '工具未启用：qq_list_image_library' }, 403);
          return;
        }
      }
      const limits = resolveImageConfig();
      const indexPath = path.join(limits.libraryDir, 'index.json');
      let lib = { items: [] };
      try {
        lib = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      } catch {
        /* 图库还没建立 */
      }
      const query = String(url.searchParams.get('query') ?? '')
        .trim()
        .toLowerCase();
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      let items = Array.isArray(lib.items) ? lib.items : [];
      if (query) {
        items = items.filter((x) =>
          [x.file, x.title, x.source, x.origin].some((v) =>
            String(v || '')
              .toLowerCase()
              .includes(query),
          ),
        );
      }
      const total = items.length;
      const out = items.slice(0, limit).map((x) => ({
        file: x.file,
        width: x.width,
        height: x.height,
        kb: Math.round((Number(x.bytes) || 0) / 1024),
        source: x.source || '',
        origin: x.origin || '',
        title: x.title || '',
      }));
      sendJson({
        ok: true,
        dir: String(cfg.socialV2?.image?.libraryDir || 'assets/stickers'),
        total,
        count: out.length,
        items: out,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
      if (!stickerEnabled()) {
        sendJson({ ok: false, error: '表情包体系已关闭' }, 403);
        return;
      }
      const key = String(url.searchParams.get('key') ?? '').trim();
      const query = String(url.searchParams.get('query') ?? '').trim();
      const onlyUnlabeled = ['1', 'true', 'yes'].includes(
        String(url.searchParams.get('onlyUnlabeled') ?? '').toLowerCase(),
      );
      const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
      const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
      let force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
      if (!key) {
        sendJson({ ok: false, error: 'key 不能为空' }, 400);
        return;
      }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) {
        sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403);
        return;
      }
      // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
      if (req.headers['x-agent-token'] && force) {
        const now = Date.now();
        if (now - deps.lastForcedAgentStickerSync < 10000) force = false;
        else deps.lastForcedAgentStickerSync = now;
      }
      try {
        const synced = await syncStickerLibrary(force);
        const list = formatStickerList(synced?.entries ?? deps.stickerEntries, query, count, { onlyUnlabeled });
        sendJson({
          ok: true,
          key,
          ...list,
          syncedAt: synced?.syncedAt ?? deps.stickerSyncedAt,
          fromCache: synced?.fromCache ?? false,
        });
      } catch (error) {
        sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
    // 管理端表情库接口（控制台）
    // 手动触发一次掉线补拉（控制台用；也方便出问题时现场验证）
    if (url.pathname === '/api/socialV2/backfill' && req.method === 'POST') {
      try {
        const r = await backfillMissedMessages('console');
        sendJson({ ok: true, ...r, note: r.added ? `补回 ${r.added} 条` : '没有发现缺口（或还没建立基线）' });
      } catch (error) {
        sendJson({ ok: false, error: `补拉失败：${error?.message ?? error}` }, 500);
      }
      return;
    }
  }
  async function handleSelfProfileRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/socialV2/self-profile') {
      const conf = profileCfg();
      let selfId = '';
      try {
        selfId = await getBotSelfId();
      } catch {
        /* 离线时也能看现状 */
      }
      sendJson({
        ok: true,
        enabled: conf.enabled,
        config: conf,
        selfId: selfId || null,
        current: deps.selfProfile.current,
        avatar: {
          sha256: deps.selfProfile.avatar.sha256,
          updatedAt: deps.selfProfile.avatar.updatedAt,
          hasPrevious: !!(deps.selfProfile.avatar.previousFile && fs.existsSync(deps.selfProfile.avatar.previousFile)),
          // 控制台直接用这个 URL 预览（走同一个控制台鉴权）
          previewUrl: selfId ? `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(selfId)}&s=640` : '',
        },
        canRevert: {
          nickname: !!previousValueFor(deps.selfProfile.history, 'nickname'),
          personalNote: !!previousValueFor(deps.selfProfile.history, 'personalNote'),
          avatar: !!(deps.selfProfile.avatar.previousFile && fs.existsSync(deps.selfProfile.avatar.previousFile)),
        },
        history: deps.selfProfile.history.slice(-20).reverse(),
        summary: formatProfileState(deps.selfProfile),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/self-profile') {
      const body = await readBody();
      const viaAgent = !!req.headers['x-agent-token'];
      const key = String(body.key ?? '').trim();
      if (viaAgent) {
        if (!key || !/^(group|private):\d+$/.test(key)) {
          sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
          return;
        }
        if (!agentTokenOk(key, req.headers['x-agent-token'])) {
          sendJson({ ok: false, error: 'agent token 无效' }, 403);
          return;
        }
        if (!v2SessionAllowed(key)) {
          sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
          return;
        }
        if (!v2ToolEnabled('setProfile')) {
          sendJson({ ok: false, error: '工具未启用：qq_set_profile' }, 403);
          return;
        }
        // 关键闸门：只认管理员上下文。群友再怎么忽悠也够不到账号级身份。
        if (!isAdminProfileContext(key)) {
          sendJson(
            {
              ok: false,
              error:
                '改资料只在「管理员上下文」可用：要么这是管理员的私聊，要么本轮是由管理员的消息触发的。' +
                '这是账号级身份（全群全私聊可见），不能让群友借一句话间接改掉。' +
                '如果确实是管理员要改，请他本人直接说一句再试。',
            },
            403,
          );
          return;
        }
      }
      try {
        const result = await applyProfileChange(
          {
            nickname: body.nickname,
            personalNote: body.personalNote,
            avatar: body.avatar,
            reason: body.reason,
          },
          { by: viaAgent ? `ai:${key}` : 'console' },
        );
        sendJson({ ok: true, ...result, summary: formatProfileState(deps.selfProfile) });
      } catch (error) {
        sendJson({ ok: false, error: `改资料失败：${error?.message ?? error}` }, 400);
      }
      return;
    }
    // 回滚上一次改动（控制台）
    if (req.method === 'POST' && url.pathname === '/api/socialV2/self-profile-revert') {
      const body = await readBody();
      try {
        const result = await revertProfile({ field: String(body.field ?? ''), by: 'console' });
        sendJson({ ok: true, ...result, summary: formatProfileState(deps.selfProfile) });
      } catch (error) {
        sendJson({ ok: false, error: `回滚失败：${error?.message ?? error}` }, 400);
      }
      return;
    }
  }
  async function handleExploreRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2SessionAllowed, v2ToolEnabled } = routeCtx;
    if (req.method === 'POST' && url.pathname === '/api/socialV2/explore-topic') {
      const body = await readBody();
      const seed = String(body.seed ?? body.topic ?? body.keyword ?? '').trim();
      if (!seed) {
        sendJson({ ok: false, error: 'seed（种子关键词）不能为空' }, 400);
        return;
      }
      const agentKey = String(body.key ?? '').trim();
      const viaAgent = !!req.headers['x-agent-token'];
      if (viaAgent) {
        if (!agentKey || !/^(group|private):\d+$/.test(agentKey)) {
          sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
          return;
        }
        if (!agentTokenOk(agentKey, req.headers['x-agent-token'])) {
          sendJson({ ok: false, error: 'agent token 无效' }, 403);
          return;
        }
        if (!v2SessionAllowed(agentKey)) {
          sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
          return;
        }
        if (!v2ToolEnabled('exploreTopic')) {
          sendJson({ ok: false, error: '工具未启用：qq_explore_topic' }, 403);
          return;
        }
      }
      try {
        const job = startTopicExploration(seed, {
          by: viaAgent ? `ai:${agentKey}` : 'console',
          maxDepth: body.maxDepth,
          maxTopics: body.maxTopics,
        });
        sendJson({
          ok: true,
          id: job.id,
          seed: job.seed,
          status: job.status,
          maxDepth: job.maxDepth,
          maxTopics: job.maxTopics,
          progress: formatJobProgress(job),
          note:
            '任务已在后台独立会话里开跑，不用等它：挖到的梗会直接进黑话库（已确认），' +
            '主题综述进知识库，之后聊天就能用上。想看进度可以再来查 /api/socialV2/explore-jobs（控制台）。',
        });
      } catch (error) {
        sendJson({ ok: false, error: `发起探索失败：${error?.message ?? error}` }, 400);
      }
      return;
    }
    // 探索任务列表/进度（控制台）
    if (req.method === 'GET' && url.pathname === '/api/socialV2/explore-jobs') {
      sendJson({
        ok: true,
        enabled: exploreCfg().enabled,
        config: exploreCfg(),
        jobs: deps.exploreJobs.map((j) => ({
          id: j.id,
          seed: j.seed,
          status: j.status,
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
          maxDepth: j.maxDepth,
          maxTopics: j.maxTopics,
          stats: j.stats,
          error: j.error,
          queue: (j.queue ?? []).map((t) => ({ name: t.name, depth: t.depth })),
          visited: (j.visited ?? []).map((v) => ({
            name: v.name,
            depth: v.depth,
            kind: v.kind,
            summary: v.summary,
            terms: v.terms,
            related: v.related,
          })),
          log: (j.log ?? []).slice(-20),
          progress: formatJobProgress(j),
        })),
      });
      return;
    }
    // 停止一个探索任务（控制台）
    if (req.method === 'POST' && url.pathname === '/api/socialV2/explore-stop') {
      const body = await readBody();
      const id = String(body.id ?? '').trim();
      if (!id) {
        sendJson({ ok: false, error: 'id 不能为空' }, 400);
        return;
      }
      try {
        const job = stopTopicExploration(id);
        sendJson({ ok: true, id: job.id, status: job.status, progress: formatJobProgress(job) });
      } catch (error) {
        sendJson({ ok: false, error: error?.message ?? String(error) }, 404);
      }
      return;
    }
  }

  return {
    handleSocialLegacyRoutes,
    handleSocialV2ConfigRoutes,
    handleSocialV2ProfileRoutes,
    handleSocialV2TaskRoutes,
    handleSocialV2SendRoutes,
    handleSocialV2WaitRoutes,
    handleSocialV2ExtrasRoutes,
    handleSelfProfileRoutes,
    handleExploreRoutes,
  };
}
