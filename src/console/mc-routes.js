// Minecraft 状态 / 推流 / 服务控制：控制台路由。
//
// 从 bridge.js 抽出的控制台路由。依赖由工厂函数注入：
// 稳定的函数/常量按值传入；会被重新赋值的绑定用 getter/setter（模块内以 deps.xxx 访问）。

export function createMcRoutes(deps) {
  const {
    QUALITY_PRESETS,
    SERVICE_KEYS,
    controlService,
    controlStandby,
    getMcServices,
    getMcStatus,
    getStreamConfig,
    getStreamStatus,
    getThermal,
    getWhitelist,
    memoryState,
    postCommand,
    recentBotLog,
    recentStreamLog,
    runLiveAction,
    runStreamAction,
    setStreamConfig,
    setThermal,
    whitelistAction,
  } = deps;

  async function handleMcRoutes(routeCtx) {
    const { req, res, url, sendJson, readBody } = routeCtx;
    if (req.method === 'GET' && url.pathname === '/api/mc/status') {
      try {
        sendJson(await getMcStatus());
      } catch (e) {
        sendJson({ ok: false, error: e?.message ?? String(e) }, 500);
      }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/mc/log') {
      // limit<=0 或 all 表示返回全部历史（文件是 append-only，历史都在）
      const raw = url.searchParams.get('limit');
      const limit = raw === 'all' ? 0 : Number(raw || 40);
      const lines = recentBotLog(limit);
      sendJson({ ok: true, lines, total: recentBotLog(0).length, limit: Number.isFinite(limit) ? limit : 40 });
      return;
    }
    // AI 记忆：当前记忆全文 / 当前目标 / 教训库 / 经验流水尾部。
    // 只读派生文件，不碰笔记本上的原始文件。
    if (req.method === 'GET' && url.pathname === '/api/mc/memory') {
      try {
        const m = memoryState();
        sendJson({ ok: m.known !== false, ...m });
      } catch (e) {
        sendJson({ ok: false, error: e?.message ?? String(e) }, 500);
      }
      return;
    }
    // 投递指令给 bot：写 bot-command.txt，由 botd.js 轮询执行。
    // 只允许白名单动作前缀，避免控制台变成任意脚本执行入口。
    if (req.method === 'POST' && url.pathname === '/api/mc/command') {
      const body = await readBody();
      const cmd = String(body.command || '').trim();
      const ALLOWED = /^(say|pos|mine|stop|goto)\b/i;
      if (!ALLOWED.test(cmd)) {
        sendJson({ ok: false, error: '只允许 say / pos / mine / stop / goto 开头的指令' }, 400);
        return;
      }
      const r = postCommand(cmd);
      sendJson(r.ok ? { ok: true, delivered: r.delivered } : { ok: false, error: r.error }, r.ok ? 200 : 500);
      return;
    }

    // ===== MC 直播推流管理（B站开播/下播 + 推流进程）=====
    // 只允许控制台（管理端）调用：带 agent token 的 AI 工具一律拒绝，
    // 免得 AI 能自己开播/下播/重启推流。
    if (url.pathname.startsWith('/api/mc/stream') || url.pathname === '/api/mc/live') {
      if (req.headers['x-agent-token']) {
        sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/mc/stream') {
        try {
          sendJson({ ok: true, ...getStreamStatus() });
        } catch (e) {
          sendJson({ ok: false, error: e?.message ?? String(e) }, 500);
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/mc/stream/log') {
        const limit = Math.min(400, Math.max(1, Number(url.searchParams.get('limit') || 60)));
        sendJson({ ok: true, lines: recentStreamLog(limit) });
        return;
      }
      // 画质配置：读 / 写（写的时候会做范围钳制）
      if (req.method === 'GET' && url.pathname === '/api/mc/stream/config') {
        sendJson({ ok: true, config: getStreamConfig(), presets: QUALITY_PRESETS });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mc/stream/config') {
        const body = await readBody();
        const r = setStreamConfig(body);
        sendJson(r, r.ok ? 200 : 400);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mc/stream/action') {
        const body = await readBody();
        const r = runStreamAction(body.action);
        sendJson(r, r.ok ? 200 : 400);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mc/live') {
        const body = await readBody();
        const r = runLiveAction(body.action, body.title);
        sendJson(r, r.ok ? 200 : 400);
        return;
      }
      sendJson({ ok: false, error: '未知的直播接口' }, 404);
      return;
    }

    // ===== MC 全套手动控制（笔记本上的服务启停 / 待机封面）=====
    // 与上面的推流接口同门槛：只允许控制台（管理端），带 agent token 的一律拒绝，
    // 免得 AI 能自己把服务端/客户端/推流关掉。
    if (
      url.pathname === '/api/mc/services' ||
      url.pathname === '/api/mc/service' ||
      url.pathname === '/api/mc/standby' ||
      url.pathname === '/api/mc/thermal'
    ) {
      if (req.headers['x-agent-token']) {
        sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
        return;
      }
      // 服务清单与实时状态（SSH 查 systemd，约 2~3 秒）
      if (req.method === 'GET' && url.pathname === '/api/mc/services') {
        try {
          const svc = await getMcServices();
          const out = {};
          for (const [key, unit] of Object.entries(SERVICE_KEYS)) {
            out[key] = { unit, ...(svc.services?.[unit] ?? { active: 'unknown' }) };
          }
          sendJson({ ok: svc.ok, services: out, error: svc.error });
        } catch (e) {
          sendJson({ ok: false, error: e?.message ?? String(e) }, 500);
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mc/service') {
        const body = await readBody();
        try {
          const r = await controlService(body.key, body.action);
          sendJson(r, r.ok ? 200 : 400);
        } catch (e) {
          sendJson({ ok: false, error: e?.message ?? String(e) }, 500);
        }
        return;
      }
      if (url.pathname === '/api/mc/standby') {
        try {
          if (req.method === 'GET') {
            sendJson(await controlStandby('status'));
          } else {
            const body = await readBody();
            const r = await controlStandby(body.action, body.seconds);
            sendJson(r, r.ok ? 200 : 400);
          }
        } catch (e) {
          sendJson({ ok: false, error: e?.message ?? String(e) }, 500);
        }
        return;
      }
      // 功耗/频率策略：读当前配置+实际值，写则校验后立即应用
      if (url.pathname === '/api/mc/thermal') {
        try {
          if (req.method === 'GET') {
            sendJson(await getThermal());
          } else {
            const body = await readBody();
            const fields = {
              PL1_W: body.PL1_W,
              PL2_W: body.PL2_W,
              MAX_MHZ: body.MAX_MHZ,
              GOVERNOR: body.GOVERNOR,
              EPP: body.EPP,
            };
            const r = await setThermal(fields);
            sendJson(r, r.ok ? 200 : 400);
          }
        } catch (e) {
          sendJson({ ok: false, error: e?.message ?? String(e) }, 500);
        }
        return;
      }
      sendJson({ ok: false, error: '未知的 MC 控制接口' }, 404);
      return;
    }
    // ===== MC 服务器白名单（名单增删 + 开关）=====
    // 门槛同上面的 MC 控制接口：仅控制台（管理端）可用，
    // 带 agent token 的 AI 工具一律拒绝，免得 AI 能自己把自己加进白名单。
    if (url.pathname === '/api/mc/whitelist') {
      if (req.headers['x-agent-token']) {
        sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
        return;
      }
      try {
        if (req.method === 'GET') {
          sendJson(await getWhitelist());
        } else {
          const body = await readBody();
          const r = await whitelistAction(String(body.action || '').trim(), body.name);
          sendJson(r, r.ok ? 200 : 400);
        }
      } catch (e) {
        sendJson({ ok: false, error: e?.message ?? String(e) }, 500);
      }
      return;
    }
  }

  return { handleMcRoutes };
}
