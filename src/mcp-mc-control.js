/**
 * 给 MCP server 注册 Minecraft 控制工具（推流 / AI 游玩 / 服务端 / B站开播）。
 *
 * 为什么单独抽一个文件：mcp-host-server.js 已经 275 行，再塞 5 个工具会太挤；
 * 而且这些动作都走 SSH 到 tzd（见 mc-control.js 的架构说明）。
 *
 * 读写分离：
 *   mc_control_status —— 只读，不加门禁（随时可查）
 *   mc_control        —— 有副作用，走门禁：
 *                        判定与拒绝原因都由 hostControlDecision() 给出
 *                        （config.json 开关 + bridge 模式 + 群活动守卫）
 */

export function registerMcControlTools(server, { z, hostControlDecision, mcControl }) {
  const {
    getFullStatus, getStreamStatus, getMcServices,
    controlStream, controlAi, controlServer, controlLive,
  } = mcControl;

  // ———————————————— 只读：状态 ————————————————
  server.tool(
    'mc_control_status',
    '查看 Minecraft 全套状态：服务端/AI/推流/相机各服务是否 active，B站房间是否直播中、RTMP 连接数、HUD 帧率、CPU 温度。只读，随时可查。',
    {},
    async () => {
      try {
        const st = await getFullStatus();
        const s = st.services || {};
        const lines = [
          `服务端 mcserver : ${s.mcserver?.active ?? '?'}`,
          `AI     mcmind   : ${s.mcmind?.active ?? '?'}   (旧 bot mcbot: ${s.mcbot?.active ?? '?'})`,
          `推流   mccapture: ${s.mccapture?.active ?? '?'}`,
          `相机   mcfollow : ${s.mcfollow?.active ?? '?'}   守护 mccamguard: ${s.mccamguard?.active ?? '?'}`,
          `快捷栏 hotbar   : ${s['hotbar-sync']?.active ?? '?'}`,
          '',
          `直播: ${st.stream?.room || '(未知)'}`,
          `RTMP 连接 ${st.stream?.rtmpConnections ?? '?'} 条  ffmpeg ${st.stream?.ffmpegProcesses ?? '?'} 个  HUD: ${st.stream?.hud || '(无)'}`,
          `CPU 温度: ${st.stream?.cpuTemp || '?'}°C`,
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: !st.ok };
      } catch (e) {
        return { content: [{ type: 'text', text: '查询失败：' + (e?.message ?? e) }], isError: true };
      }
    }
  );

  // ———————————————— 有副作用：控制 ————————————————
  server.tool(
    'mc_control',
    '控制 Minecraft 各项开关。target=live 时控制 B站直播（start 申请新推流码开播 / stop 下播 / status）；' +
    'target=stream 控制推流进程（start/stop/restart）；target=ai 控制 AI 游玩（Mindcraft，start/stop/restart）；' +
    'target=server 控制 MC 服务端（start/stop/restart）。' +
    '注意：开播需 B站账号未过期的人脸认证，若返回 needFaceAuth 则需账号本人在手机 App 上完成，无法绕过。',
    {
      target: z.enum(['live', 'stream', 'ai', 'server']).describe('要控制的对象'),
      action: z.enum(['start', 'stop', 'restart', 'status']).describe('动作；status 只对 live 有效'),
      title: z.string().optional().describe('B站直播间标题（仅 target=live 且 action=start 时用，最多 40 字）'),
    },
    async ({ target, action, title }) => {
      const decision = await hostControlDecision();
      if (!decision.allowed) {
        return { content: [{ type: 'text', text: `拒绝：${decision.reason}。` }], isError: true };
      }

      try {
        let r;
        if (target === 'live') {
          if (action === 'restart') return { content: [{ type: 'text', text: '拒绝：B站直播不支持 restart，请用 stop 后 start。' }], isError: true };
          r = await controlLive(action, title);
          if (!r.ok) return { content: [{ type: 'text', text: `失败：${r.error}` }], isError: true };
          const VERB = { start: '开播', stop: '下播', status: '查询' };
          const outcome = action === 'status'
            ? '当前状态'
            : r.opened ? '已开播 ✅'
              : r.needFaceAuth ? '需要人脸认证 ❌'
                : action === 'stop' ? '已下播 ✅' : '已执行';
          const text = `B站直播${VERB[action]}：${outcome}${r.hint ? '\n' + r.hint : ''}\n---\n${r.detail || ''}`;
          return { content: [{ type: 'text', text }], isError: !!r.needFaceAuth };
        }
        if (action === 'status') return { content: [{ type: 'text', text: '拒绝：status 只对 target=live 有效（其它目标请用 mc_control_status）。' }], isError: true };

        if (target === 'stream') r = await controlStream(action);
        else if (target === 'ai') r = await controlAi(action);
        else r = await controlServer(action);

        const text = r.ok
          ? `${target} ${action} 完成，当前状态：${r.state}`
          : `失败：${r.error}`;
        return { content: [{ type: 'text', text }], isError: !r.ok };
      } catch (e) {
        return { content: [{ type: 'text', text: '执行异常：' + (e?.message ?? e) }], isError: true };
      }
    }
  );

  return server;
}
