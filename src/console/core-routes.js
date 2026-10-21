import { listUpgrades, proposeUpgrade, decideUpgrade, activePromptHints } from '../self-upgrade.js';
// 控制台核心路由：首页/状态、角色、会话、白名单、安全、令牌、重启。
//
// 从 bridge.js 抽出的控制台路由。依赖由工厂函数注入：
// 稳定的函数/常量按值传入；会被重新赋值的绑定用 getter/setter（模块内以 deps.xxx 访问）。

export function createConsoleCoreRoutes(deps) {
  const {
    ACTIVITY_LOG,
    KNOWN_AGENT_TOKENS,
    ROOT,
    SENSITIVE_RE,
    STATE_DIR,
    addGoal,
    addProfile,
    allowed,
    api,
    atomicWriteJson,
    atomicWriteText,
    bot,
    budgetStatus,
    cancelAllSocialTimers,
    cancelPendingEntry,
    cancelSocialTimers,
    cfg,
    clearAllSocialV2Timers,
    clearSocialV2Timers,
    collectors,
    completeGoal,
    countItems,
    crypto,
    deleteItem,
    drainAllPromptQueues,
    drainPromptQueue,
    escapeCqText,
    fs,
    listApps,
    listGoals,
    listItems,
    listProfile,
    listRoles,
    log,
    markReadCalledKeys,
    messageMediaStore,
    migrateFromJson,
    modeAllowed,
    normalizeOwnerQQ,
    path,
    pending,
    pendingSendToolCalls,
    pendingWakeKeys,
    profileForPrompt,
    queued,
    queuedHintAt,
    readActivityTail,
    readApp,
    readJsonSafe,
    readRoleState,
    recentLog,
    reconcileSessionPolicies,
    redactKnownTokensOnly,
    releaseLock,
    removeApp,
    removeProfile,
    retireAllWorkLanes,
    reverse,
    sanitizeRoleName,
    saveApp,
    saveSocialV2State,
    saveState,
    seenForwardIds,
    sendToolSucceededSessions,
    sessionPromises,
    slangExtractionCooldowns,
    slangSubmitTimes,
    slangWindows,
    social,
    socialData,
    spawn,
    spendBudget,
    text,
    toolCallNames,
    unwrap,
    upsertItem,
    v2TurnStartAt,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
    writeRoleState,
  } = deps;

  async function handleConsoleCoreRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, SECURITY_HEADERS } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      try {
        // 控制台外壳：导航 + 视图容器，具体分区在 public/console/views/*.html
        res.end(fs.readFileSync(path.join(ROOT, 'public', 'console', 'index.html'), 'utf8'));
      } catch {
        res.end('控制台页面缺失：鱼群bot/public/console/index.html');
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const rs = readRoleState();
      sendJson({
        mode: deps.currentMode,
        role: rs.role ?? null,
        roleMode: rs.mode ?? 'active',
        dshReady: deps.dshReady,
        ownerQQ: cfg.ownerQQ ?? null,
        allowGroups: cfg.allow?.groups ?? [],
        allowPrivate: cfg.allow?.private ?? [],
        socialPaused: socialData.paused,
        activity: readActivityTail(100),
      });
      return;
    }
  }
  async function handleRoleRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/presets') {
      let presets = [];
      try {
        const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
        presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
      } catch {}
      sendJson({ presets });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/role') {
      const body = await readBody();
      const rs = readRoleState();
      if (body.role && typeof body.role === 'string') {
        const name = sanitizeRoleName(body.role);
        if (!fs.existsSync(path.join(ROOT, 'roles', name + '.md'))) {
          sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
          return;
        }
        writeRoleState(name, rs.mode);
        log(`控制台：角色已设置为 ${name}`);
        sendJson({ ok: true, role: name });
      } else {
        writeRoleState(null, rs.mode);
        log('控制台：角色已清除');
        sendJson({ ok: true, role: null });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/role-mode') {
      const body = await readBody();
      const rs = readRoleState();
      const mode = body.mode === 'silent' ? 'silent' : 'active';
      writeRoleState(rs.role, mode);
      log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
      sendJson({ ok: true, roleMode: mode });
      return;
    }
    // ── 人格管理 ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/roles') {
      const rs = readRoleState();
      sendJson({ roles: listRoles(), current: rs.role ?? null });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/roles/create') {
      const body = await readBody();
      const name = sanitizeRoleName(body.name);
      const content = String(body.content ?? '').trim();
      if (!name) {
        sendJson({ ok: false, error: '角色名不能为空（仅限中文/字母/数字/横线）' }, 400);
        return;
      }
      if (!content) {
        sendJson({ ok: false, error: '角色内容不能为空' }, 400);
        return;
      }
      if (name === 'README') {
        sendJson({ ok: false, error: '该名称被保留' }, 400);
        return;
      }
      const roleFile = path.join(ROOT, 'roles', name + '.md');
      if (fs.existsSync(roleFile)) {
        sendJson({ ok: false, error: `角色「${name}」已存在` }, 400);
        return;
      }
      fs.mkdirSync(path.join(ROOT, 'roles'), { recursive: true });
      atomicWriteText(roleFile, content + (content.endsWith('\n') ? '' : '\n'));
      log(`控制台：创建人格「${name}」`);
      sendJson({ ok: true, role: name });
      return;
    }
  }
  async function handleAdminRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, consoleCookieHeader, CONSOLE_COOKIE_MAX_AGE_SEC } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const list = [];
      for (const [key, sessionId] of Object.entries(deps.state.sessions)) {
        list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
      }
      sendJson({ sessions: list });
      return;
    }
    // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/pending') {
      const list = [];
      for (const [key, p] of pending.entries()) {
        list.push({
          key,
          kind: p.kind,
          sessionId: p.sessionId,
          ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
          ...(p.kind === 'question' ? { questions: p.questions } : {}),
        });
      }
      sendJson({ pending: list });
      return;
    }
    // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
    if (req.method === 'GET' && url.pathname === '/api/whitelist') {
      sendJson({
        allow: cfg.allow ?? { private: [], groups: [] },
        deny: cfg.deny ?? { private: [], groups: [] },
        ownerQQ: cfg.ownerQQ ?? null,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/whitelist') {
      const body = await readBody();
      const toNum = (arr) =>
        Array.isArray(arr)
          ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))]
          : undefined;
      const configFile = path.join(ROOT, 'config.json');
      // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
      const file = readJsonSafe(configFile, null, true);
      const allow = {
        private: toNum(body.allow?.private) ?? file.allow?.private ?? [],
        groups: toNum(body.allow?.groups) ?? file.allow?.groups ?? [],
      };
      const deny = {
        private: toNum(body.deny?.private) ?? file.deny?.private ?? [],
        groups: toNum(body.deny?.groups) ?? file.deny?.groups ?? [],
      };
      // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
      let ownerQQ = cfg.ownerQQ ?? null;
      if (body.ownerQQ !== undefined) {
        try {
          ownerQQ = normalizeOwnerQQ(body.ownerQQ);
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
          return;
        }
      }
      file.allow = allow;
      file.deny = deny;
      file.ownerQQ = ownerQQ;
      atomicWriteJson(configFile, file);
      cfg.allow = { private: allow.private, groups: allow.groups };
      cfg.deny = { private: deny.private, groups: deny.groups };
      cfg.ownerQQ = ownerQQ;
      reconcileSessionPolicies();
      log(
        `控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`,
      );
      sendJson({ ok: true, allow, deny, ownerQQ });
      return;
    }

    // ── 安全拦截通知设置 ─────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/security') {
      sendJson({ security: cfg.security ?? { interceptNotify: true } });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/security') {
      const body = await readBody();
      const configFile = path.join(ROOT, 'config.json');
      const file = readJsonSafe(configFile, null, true);
      const next = { ...(file.security ?? {}), ...body };
      if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
      else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
      file.security = next;
      atomicWriteJson(configFile, file);
      cfg.security = { ...(cfg.security ?? {}), ...next };
      log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
      sendJson({ ok: true, security: cfg.security });
      return;
    }
    // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/console/token') {
      const body = await readBody();
      let newToken = String(body.token ?? '').trim();
      const generated = !newToken;
      if (generated) {
        newToken = crypto.randomBytes(24).toString('hex');
      }
      if (newToken.length < 16) {
        sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
        return;
      }
      if (newToken.length > 128) {
        sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
        return;
      }
      if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
        sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
        return;
      }
      const configFile = path.join(ROOT, 'config.json');
      const file = readJsonSafe(configFile, null, true);
      // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
      file.consoleToken = generated ? '' : newToken;
      atomicWriteJson(configFile, file);
      cfg.consoleToken = generated ? '' : newToken;
      atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
      routeCtx.setConsoleToken(newToken);
      // 让当前浏览器立刻改用新令牌，否则下一次刷新就回到「输入令牌」
      res.setHeader('Set-Cookie', consoleCookieHeader(newToken, CONSOLE_COOKIE_MAX_AGE_SEC));
      log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
      sendJson({ ok: true, token: newToken, generated });
      return;
    }
    // ── 忘记本机令牌（只清这个浏览器的 Cookie；令牌本身不变） ────────────────
    if (req.method === 'POST' && url.pathname === '/api/console/logout') {
      res.setHeader('Set-Cookie', consoleCookieHeader('', 0));
      log('控制台：已清除本机记住的访问令牌');
      sendJson({ ok: true });
      return;
    }
    // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/test-send') {
      const body = await readBody();
      const kind = body.kind === 'private' ? 'private' : 'group';
      const id = Number(body.id);
      const message = String(body.message ?? '').trim();
      if (!Number.isFinite(id) || id <= 0) {
        sendJson({ ok: false, error: '目标 id 无效' }, 400);
        return;
      }
      if (!message) {
        sendJson({ ok: false, error: '消息不能为空' }, 400);
        return;
      }
      if (SENSITIVE_RE.test(message)) {
        sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
        return;
      }
      if (!allowed(kind, id, cfg)) {
        sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403);
        return;
      }
      if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: `当前模式（${deps.currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403);
        return;
      }
      try {
        const safeMessage = escapeCqText(redactKnownTokensOnly(message));
        const result =
          kind === 'private'
            ? await bot.sendPrivateMessage(id, text(safeMessage))
            : await bot.sendGroupMessage(id, text(safeMessage));
        log(`控制台：测试发送 ${kind}:${id} 成功`);
        sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
      } catch (error) {
        sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
      }
      return;
    }
  }
  async function handleMiscAdminRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody, v2ToolEnabled } = routeCtx;
    if (url.pathname === '/api/socialData/bili-hot') {
      const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit')) || 12));
      const now = Date.now();
      if (
        deps.biliHotCache.items.length &&
        now - deps.biliHotCache.at < 10 * 60 * 1000 &&
        deps.biliHotCache.limit >= limit
      ) {
        sendJson({ ok: true, cached: true, items: deps.biliHotCache.items.slice(0, limit) });
        return;
      }
      try {
        const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
        const r = await fetch(`https://api.bilibili.com/x/web-interface/popular?ps=${Math.max(limit, 20)}&pn=1`, {
          headers: { 'user-agent': UA, referer: 'https://www.bilibili.com' },
          signal: AbortSignal.timeout(20000),
        });
        const j = await r.json();
        const items = (j?.data?.list || [])
          .slice(0, Math.max(limit, 20))
          .map((v) => ({
            bvid: String(v?.bvid || ''),
            title: String(v?.title || '').slice(0, 120),
            owner: String(v?.owner?.name || '').slice(0, 40),
            view: Number(v?.stat?.view) || 0,
            danmaku: Number(v?.stat?.danmaku) || 0,
            url: v?.bvid ? `https://www.bilibili.com/video/${v.bvid}` : '',
            desc: String(v?.desc || '').slice(0, 200),
          }))
          .filter((x) => x.bvid && x.title);
        deps.biliHotCache = { at: now, items, limit };
        sendJson({ ok: true, cached: false, items: items.slice(0, limit) });
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
      }
      return;
    }
    // ── 统一记忆库（一个 SQLite 管所有记忆：黑话/知识库/档案/备注/轻量记忆）──
    if (url.pathname === '/api/memdb' || url.pathname.startsWith('/api/memdb/')) {
      const action = url.pathname === '/api/memdb' ? '' : url.pathname.slice('/api/memdb/'.length);
      try {
        if (req.method === 'GET') {
          const kind = String(url.searchParams.get('kind') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim();
          const scope = String(url.searchParams.get('scope') ?? '').trim();
          const limit = Number(url.searchParams.get('limit')) || 200;
          sendJson({
            ok: true,
            counts: countItems({ stateDir: STATE_DIR }),
            items: listItems({ stateDir: STATE_DIR, kind, q, scope, limit }),
          });
          return;
        }
        const body = await readBody();
        if (action === 'add' || action === 'update') {
          sendJson(upsertItem({ stateDir: STATE_DIR, item: body }));
          return;
        }
        if (action === 'delete') {
          sendJson(deleteItem({ stateDir: STATE_DIR, id: body.id }));
          return;
        }
        if (action === 'migrate') {
          sendJson(migrateFromJson({ stateDir: STATE_DIR, log }));
          return;
        }
        sendJson({ ok: false, error: '未知操作' }, 404);
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return;
    }
    // ── Web 应用：AI 给管理员请求做的小页面，对外挂在 /apps/<slug> ──────
    if (url.pathname === '/apps' || url.pathname.startsWith('/apps/')) {
      const slug = decodeURIComponent(url.pathname.slice('/apps'.length).replace(/^\//, '')).split('/')[0] || '';
      if (req.method === 'GET') {
        const html = slug ? readApp({ stateDir: STATE_DIR, slug }) : null;
        if (!html) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('页面不存在');
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'X-Frame-Options': 'SAMEORIGIN',
          'Referrer-Policy': 'no-referrer',
        });
        res.end(html);
        return;
      }
    }
    if (url.pathname === '/api/webapps' || url.pathname.startsWith('/api/webapps/')) {
      const action = url.pathname === '/api/webapps' ? '' : url.pathname.slice('/api/webapps/'.length);
      // 能力开关：发布页 / 看列表 分别受 plugins.webapps 控制（控制台 → 插件 → 网页应用）
      if (req.method === 'POST' && !v2ToolEnabled('webappSave')) {
        sendJson({ ok: false, error: '能力未启用：发布页面（控制台 → 插件 → 网页应用）' }, 403);
        return;
      }
      if (req.method === 'GET' && !v2ToolEnabled('webappList')) {
        sendJson({ ok: false, error: '能力未启用：查看页面列表' }, 403);
        return;
      }
      try {
        if (req.method === 'GET') {
          sendJson({ ok: true, apps: listApps({ stateDir: STATE_DIR }) });
          return;
        }
        const body = await readBody();
        if (action === 'save') {
          const r = saveApp({
            stateDir: STATE_DIR,
            slug: body.slug,
            title: body.title,
            description: body.description,
            html: body.html,
          });
          log(`[webapp] ${r.ok ? '保存' : '保存失败'} ${body.slug}`);
          sendJson(
            r.ok
              ? { ok: true, slug: r.slug, publicUrl: `https://anihub.xin/qq/apps/${r.slug}` }
              : { ok: false, error: r.error },
            r.ok ? 200 : 400,
          );
          return;
        }
        if (action === 'remove') {
          sendJson(removeApp({ stateDir: STATE_DIR, slug: body.slug }));
          return;
        }
        sendJson({ ok: false, error: '未知操作' }, 404);
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return;
    }
    // ── 自主升级（从对话里自己发现问题并升级）───────────────────
    if (url.pathname === '/api/self-upgrade' || url.pathname.startsWith('/api/self-upgrade/')) {
      const action = url.pathname === '/api/self-upgrade' ? '' : url.pathname.slice('/api/self-upgrade/'.length);
      try {
        if (req.method === 'GET') {
          sendJson({ ok: true, items: listUpgrades({ stateDir: STATE_DIR, status: String(url.searchParams.get('status') ?? '') }), active: activePromptHints({ stateDir: STATE_DIR }) });
          return;
        }
        const body = await readBody();
        if (action === 'propose') {
          const r = proposeUpgrade({ stateDir: STATE_DIR, kind: body.kind, content: body.content, reason: body.reason, key: body.key });
          if (r.ok) log(`[self-upgrade] ${r.item.kind} ${r.item.status}：${String(r.item.content).slice(0, 60)}`);
          sendJson(r, r.ok ? 200 : 400);
          return;
        }
        if (action === 'decide') { sendJson(decideUpgrade({ stateDir: STATE_DIR, id: body.id, approve: body.approve !== false })); return; }
        sendJson({ ok: false, error: '未知操作' }, 404);
      } catch (error) { sendJson({ ok: false, error: String(error?.message ?? error) }, 500); }
      return;
    }
    // ── 购物平台注册表（技能可自助扩充）──────────────────────
    if (url.pathname === '/api/shop/platforms' || url.pathname === '/api/shop/platforms/add') {
      const file = path.join(STATE_DIR, 'shop-platforms.json');
      const readAll = () => {
        const v = readJsonSafe(file, { platforms: [] });
        return Array.isArray(v?.platforms) ? v : { platforms: [] };
      };
      try {
        if (req.method === 'GET') {
          sendJson({ ok: true, ...readAll() });
          return;
        }
        const body = await readBody();
        const id = String(body.id ?? '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '')
          .slice(0, 20);
        const template = String(body.template ?? '').trim();
        if (!id || !template) {
          sendJson({ ok: false, error: '需要 id 和 template（template 里用 {q} 占位关键词）' }, 400);
          return;
        }
        const data = readAll();
        if (data.platforms.some((p) => p.id === id)) {
          sendJson({ ok: false, error: '这个平台已经在了' }, 400);
          return;
        }
        data.platforms.push({
          id,
          name: String(body.name || id).slice(0, 20),
          pkg: String(body.pkg || '').slice(0, 80),
          template: template.slice(0, 400),
          source: String(body.source || 'ai'),
        });
        atomicWriteJson(file, data);
        log(`[shop] 新增平台 ${id}（来源 ${body.source || 'ai'}）`);
        sendJson({ ok: true, platform: { id, name: body.name || id } });
        return;
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return;
    }
    // ── 档案：跨会话共享的事实型记忆 ──────────────────
    if (url.pathname === '/api/socialData/profile' || url.pathname.startsWith('/api/socialData/profile/')) {
      const action =
        url.pathname === '/api/socialData/profile' ? '' : url.pathname.slice('/api/socialData/profile/'.length);
      try {
        if (req.method === 'GET') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim();
          const pf = profileForPrompt({ stateDir: STATE_DIR, key });
          sendJson({
            ok: true,
            shared: pf.shared,
            local: pf.local,
            items: listProfile({ stateDir: STATE_DIR, q, limit: 200 }),
          });
          return;
        }
        const body = await readBody();
        if (action === 'add') {
          const r = addProfile({
            stateDir: STATE_DIR,
            text: body.text,
            scope: body.scope || 'all',
            tags: body.tags,
            from: body.from || 'ai',
          });
          // 同一份事实也写进统一记忆库（memdb 是召回的真源），否则新记的东西永远召不回来
          if (r.ok) {
            try {
              upsertItem({
                stateDir: STATE_DIR,
                item: {
                  id: `fact:${r.item.id}`,
                  kind: 'fact',
                  scope: r.item.scope,
                  text: r.item.text,
                  tags: r.item.tags,
                  at: r.item.at,
                },
              });
            } catch {
              /* 忽略 */
            }
          }
          sendJson(r);
          return;
        }
        if (action === 'remove') {
          sendJson(removeProfile({ stateDir: STATE_DIR, id: body.id }));
          return;
        }
        sendJson({ ok: false, error: '未知操作' }, 404);
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return;
    }
    // ── 自主性（L2）：自己的目标 / 每日自由行动预算 / 行动日志 ──────────
    if (url.pathname === '/api/socialData/autonomy' || url.pathname.startsWith('/api/socialData/autonomy/')) {
      const action =
        url.pathname === '/api/socialData/autonomy' ? '' : url.pathname.slice('/api/socialData/autonomy/'.length);
      const limit = Math.max(0, Number(cfg.socialData?.autonomy?.dailyBudget ?? 5));
      try {
        if (req.method === 'GET' && (action === '' || action === 'status')) {
          sendJson({
            ok: true,
            budget: budgetStatus({ stateDir: STATE_DIR, limit }),
            goals: listGoals({ stateDir: STATE_DIR }),
            log: recentLog({ stateDir: STATE_DIR, limit: 20 }),
          });
          return;
        }
        const body = req.method === 'POST' ? await readBody() : {};
        if (req.method === 'POST' && action === 'goal-add') {
          sendJson(addGoal({ stateDir: STATE_DIR, text: body.text, source: body.source || 'ai' }));
          return;
        }
        if (req.method === 'POST' && action === 'goal-done') {
          sendJson(completeGoal({ stateDir: STATE_DIR, id: body.id }));
          return;
        }
        if (req.method === 'POST' && action === 'spend') {
          sendJson(spendBudget({ stateDir: STATE_DIR, limit, what: body.what }));
          return;
        }
        sendJson({ ok: false, error: '未知操作' }, 404);
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return;
    }
    // ── 发 QQ 动态（SnowLuma 的 send_qzone_msg，支持中文、不用手机）──────
    if (url.pathname === '/api/socialData/post-moment' || url.pathname === '/api/socialData/delete-moment') {
      if (!v2ToolEnabled('postMoment')) {
        sendJson({ ok: false, error: '能力未启用：发动态（控制台 → 插件 → 媒体）' }, 403);
        return;
      }
      const body = await readBody();
      try {
        if (url.pathname === '/api/socialData/post-moment') {
          const content = String(body.content ?? '').trim();
          if (!content) {
            sendJson({ ok: false, error: 'content 不能为空' }, 400);
            return;
          }
          const r = await bot.raw('send_qzone_msg', { content });
          const tid = r?.tid ?? '';
          log(`[moment] 已发动态 tid=${tid || '?'}（${content.length} 字）`);
          sendJson({ ok: !!tid, tid, content, time: r?.time ?? null });
          return;
        }
        const tid = String(body.tid ?? '').trim();
        if (!tid) {
          sendJson({ ok: false, error: 'tid 不能为空' }, 400);
          return;
        }
        await bot.raw('delete_qzone_msg', { tid });
        log(`[moment] 已删除动态 tid=${tid}`);
        sendJson({ ok: true, tid, deleted: true });
        return;
      } catch (error) {
        sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
      }
      return;
    }
  }
  async function handleSessionAdminRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody } = routeCtx;
    if (req.method === 'POST' && url.pathname === '/api/session/reset') {
      const body = await readBody();
      const key = String(body.key ?? '');
      if (!key || !deps.state.sessions[key]) {
        sendJson({ ok: false, error: '会话不存在' }, 404);
        return;
      }
      deps.sessionEpoch++;
      const oldSessionId = deps.state.sessions[key];
      delete deps.state.sessions[key];
      // 权限元数据必须与映射一起删除，否则会永久残留在 sessions.json 里。
      delete deps.state.sessionPolicies[key];
      reverse.delete(oldSessionId);
      collectors.delete(oldSessionId);
      sendToolSucceededSessions.delete(oldSessionId);
      pendingSendToolCalls.delete(oldSessionId);
      v2TurnStartAt.delete(oldSessionId);
      toolCallNames.delete(oldSessionId);
      const pe = pending.get(key);
      if (pe) {
        clearTimeout(pe.timer);
        cancelPendingEntry(pe).catch(() => {});
      }
      pending.delete(key);
      queued.delete(key);
      queuedHintAt.delete(key);
      sessionPromises.delete(key);
      drainPromptQueue(key, '会话已重置');
      social.recentMessages.delete(key);
      messageMediaStore.delete(key);
      social.pendingSummaries.delete(key);
      social.states.delete(key);
      social.silentContext.delete(key);
      social.silentTurns.delete(oldSessionId);
      social.exitingSessions.delete(oldSessionId);
      slangWindows.delete(key);
      slangExtractionCooldowns.delete(key);
      slangSubmitTimes.delete(key);
      cancelSocialTimers(key);
      clearSocialV2Timers(key);
      pendingWakeKeys.delete(key);
      wakeConfigUpdatedKeys.delete(key);
      markReadCalledKeys.delete(key);
      wakeConfigMissCount.delete(key);
      const removedChat = socialData.conversations.get(key);
      if (removedChat?.agentToken) KNOWN_AGENT_TOKENS.delete(removedChat.agentToken);
      socialData.conversations.delete(key);
      seenForwardIds.delete(key);
      saveSocialV2State();
      saveState();
      // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
      try {
        await api.stopSessionWork(oldSessionId);
      } catch (error) {
        log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`);
      }
      try {
        await api.workspace.archiveSession({ sessionId: oldSessionId });
      } catch {}
      log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
      sendJson({ ok: true, key, archived: oldSessionId });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
      deps.sessionEpoch++;
      let archivedCount = 0;
      let stoppedCount = 0;
      try {
        // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
        // 只处理 cwd 位于 鱼群bot state/ 下的根会话；子代理会话由父会话管理，不能误归档。
        const list = unwrap(await api.sessions.list({}), 'session.list');
        const stateDir = path.resolve(STATE_DIR);
        const statePrefix = path.normalize(stateDir + path.sep);
        const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
        const isUnderState = (cwd) =>
          process.platform === 'win32'
            ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
            : cwd.startsWith(statePrefix);
        for (const item of list.items ?? []) {
          if (item.origin === 'subagent' || item.parentSessionId) continue;
          const cwd = normPath(item.cwd);
          if (isUnderState(cwd)) {
            // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
            try {
              await api.stopSessionWork(item.sessionId);
              stoppedCount += 1;
            } catch (error) {
              log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`);
            }
            try {
              await api.workspace.archiveSession({ sessionId: item.sessionId });
              archivedCount += 1;
            } catch {}
          }
        }
      } catch {}
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        cancelPendingEntry(entry).catch(() => {});
      }
      pending.clear();
      queued.clear();
      queuedHintAt.clear();
      sessionPromises.clear();
      drainAllPromptQueues('工作区已清空');
      social.states.clear();
      social.recentMessages.clear();
      messageMediaStore.clear();
      seenForwardIds.clear();
      social.pendingSummaries.clear();
      social.silentContext.clear();
      social.silentTurns.clear();
      social.exitingSessions.clear();
      slangWindows.clear();
      slangExtractionCooldowns.clear();
      slangSubmitTimes.clear();
      cancelAllSocialTimers();
      clearAllSocialV2Timers();
      for (const st of socialData.conversations.values()) {
        if (st?.agentToken) KNOWN_AGENT_TOKENS.delete(st.agentToken);
      }
      socialData.conversations.clear();
      saveSocialV2State();
      deps.state.sessions = {};
      deps.state.sessionPolicies = {};
      reverse.clear();
      // 工作车道也一起退役/归档：不然清空工作区后它们仍活着，还会把结论回投到已清空的会话。
      retireAllWorkLanes();
      deps.state.workSessions = {};
      collectors.clear();
      sendToolSucceededSessions.clear();
      pendingSendToolCalls.clear();
      v2TurnStartAt.clear();
      toolCallNames.clear();
      saveState();
      try {
        fs.writeFileSync(ACTIVITY_LOG, '');
      } catch {}
      log(
        `控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`,
      );
      sendJson({ ok: true, archivedCount, stoppedCount });
      return;
    }
  }
  async function handleRestartRoute(routeCtx) {
    const { req, res, url, sendJson, readBody } = routeCtx;
    if (req.method === 'POST' && url.pathname === '/api/restart') {
      // 两种启动方式的重启语义不一样，这里必须分开，否则「手动 node src/bridge.js」
      // 的环境下按一下按钮桥接就永久下线（没有守护窗口会把它拉起来）。
      //   守护模式（Windows start.bat 循环，会设 QQ_BRIDGE_GUARDED=1）：直接退出，守护 5s 后拉起；
      //   手动模式：自己 detached 拉一个新进程（等 1s 让端口/单实例锁释放），再退出。
      const guarded = String(process.env.QQ_BRIDGE_GUARDED ?? '') === '1';
      const script = path.join(ROOT, 'src', 'bridge.js');
      let respawned = false;
      if (!guarded) {
        try {
          const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
          const cmd =
            process.platform === 'win32'
              ? { file: 'cmd', args: ['/c', `timeout /t 1 >nul & ${quote(process.execPath)} ${quote(script)}`] }
              : { file: 'sh', args: ['-c', `sleep 1; exec ${quote(process.execPath)} ${quote(script)}`] };
          const child = spawn(cmd.file, cmd.args, { cwd: ROOT, detached: true, stdio: 'inherit', env: process.env });
          child.unref();
          respawned = true;
        } catch (error) {
          log(`控制台：自我重启失败（${error?.message ?? error}），请在终端手动启动桥接`);
        }
      }
      sendJson({
        ok: true,
        respawned,
        message: guarded
          ? '正在重启桥接（守护窗口会在 5 秒后拉起）…'
          : respawned
            ? '正在重启桥接（约 1 秒后由桥接自行拉起新进程）…'
            : '正在退出桥接（自我重启失败，请手动启动）…',
      });
      setTimeout(() => {
        log(`控制台：重启桥接（${guarded ? '守护模式' : respawned ? '自行拉起新进程' : '无守护、也未拉起'}）`);
        releaseLock();
        process.exit(0);
      }, 500);
      return;
    }
  }

  return {
    handleConsoleCoreRoutes,
    handleRoleRoutes,
    handleAdminRoutes,
    handleMiscAdminRoutes,
    handleSessionAdminRoutes,
    handleRestartRoute,
  };
}
