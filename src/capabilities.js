// 插件 → 能力 注册表（粗粒度版）。
//
// 设计原则（owner 定的）：
//   · **插件 = 一块产品能力**（聊天 / 媒体 / 记忆 / 群成员 / 后台任务 / 人格 / 手机控制），
//     控制台上就这 7 个开关，不要一个工具一个开关；
//   · **能力 = 插件里用户听得懂的那几档**（比如手机控制里：看屏幕 / 操作手机 / 刷 B站 / 执行命令）；
//   · 具体怎么实现（刷 B站用到搜索、字幕、抽帧、直播状态…）**不暴露给用户**，都收在能力后面。
//
// 一个能力可以覆盖多个底层 flag（flags 数组）：能力开 = 这些 flag 全开；能力关 = 全关。
// 状态仍存 config.socialV2.plugins，判定入口 capabilityEnabled(plugins, flag)。
export const PLUGINS = [
  {
    id: 'chat',
    name: '聊天',
    icon: '💬',
    desc: '收发消息、等待判断、唤醒配置——基础中的基础',
    capabilities: [
      { id: 'read', label: '读消息', flags: ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'getMessageDetail', 'getActiveMembers', 'getMyRecent'] },
      { id: 'send', label: '发消息', flags: ['sendMessage', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'waitMessages', 'markRead', 'sendPoke'] },
      { id: 'wake', label: '唤醒配置', flags: ['setWakeConfig'] },
      { id: 'feedback', label: '反馈问题', flags: ['feedback'] }
    ]
  },
  {
    id: 'media',
    name: '媒体',
    icon: '🖼️',
    desc: '图片、表情包、语音、视频、音乐、链接卡片',
    capabilities: [
      { id: 'image', label: '图片', flags: ['sendImage', 'getImages', 'getMemberAvatar', 'getFriendDress', 'saveSticker', 'listImageLibrary', 'searchImages'] },
      { id: 'sticker', label: '表情包', flags: ['sendSticker', 'listStickers', 'getStickerImage', 'collectSticker', 'pickSticker', 'stickerNote', 'getSelfImage', 'getForwardMsg'] },
      { id: 'voice', label: '语音', flags: ['voicePack'] },
      { id: 'video', label: '视频与音乐', flags: ['getMessageVideo', 'video', 'videoFrames'] },
      // 发 QQ 动态走 SnowLuma 的 send_qzone_msg（不需要手机，支持中文）；默认关，防它自己乱发
      { id: 'moment', label: '发动态（说说，会真的发到 Qzone）', flags: ['postMoment'], default: false },
      { id: 'stickerQQNote', label: '改 QQ 表情备注（动账号）', flags: ['setStickerRemark'], default: false },
      { id: 'card', label: '链接卡片（网关版本门禁，通常不渲染）', flags: ['sendCard'], default: false }
    ]
  },
  {
    id: 'memory',
    name: '记忆',
    icon: '🧠',
    desc: '长期记忆与日记、群知识库、黑话库',
    capabilities: [
      { id: 'remember', label: '记忆与日记', flags: ['memory'] },
      { id: 'knowledge', label: '群知识库', flags: ['knowledge'] },
      { id: 'slang', label: '黑话库', flags: ['slangQuery', 'slangSubmit'] }
    ]
  },
  {
    id: 'members',
    name: '群成员',
    icon: '🧑',
    desc: '给群友记备注',
    capabilities: [
      { id: 'remark', label: '记群友备注', flags: ['memberRemark'] },
      { id: 'profile', label: '读资料（头像 / 签名 / 等级 / 群身份）', flags: ['memberProfile'] },
      { id: 'card', label: '改群名片（动账号）', flags: ['setMemberCard'], default: false }
    ]
  },
  {
    id: 'tasks',
    name: '后台任务',
    icon: '🛠️',
    desc: '派发长任务、自主补课',
    capabilities: [
      { id: 'run', label: '派发后台长任务', flags: ['runTask'] },
      { id: 'explore', label: '自主探索主题', flags: ['exploreTopic'] }
    ]
  },
  {
    id: 'persona',
    name: '人格',
    icon: '🎭',
    desc: '改自己的头像与签名（动账号）',
    capabilities: [
      { id: 'profile', label: '改头像/签名', flags: ['setProfile'], default: false }
    ]
  },
  {
    id: 'webapps',
    name: '网页应用',
    icon: '🌐',
    desc: '给管理员/群友做小网页（看板、清单、表单），发布成公开链接，谁拿到链接都能看',
    capabilities: [
      { id: 'publish', label: '发布/更新页面（qq_webapp_save）', flags: ['webappSave'] },
      { id: 'list', label: '查看已发布页面（qq_webapp_list）', flags: ['webappList'] }
    ]
  },
  {
    id: 'phone',
    name: '手机控制',
    icon: '📱',
    desc: '让它在手机上"看"和"动"：看屏幕、操作手机、刷 B站（具体怎么刷它自己安排）',
    capabilities: [
      // 基础能力：插件开了就有，不单独给用户开关（owner：看屏幕/操作手机是插件本身的能力）。
      { id: 'screen', label: '看屏幕（状态 / 截图）', flags: ['phoneStatus', 'phoneScreen', 'phoneScreenshot'], base: true },
      { id: 'control', label: '操作手机（点击 / 滑动 / 按键）', flags: ['phoneTap', 'phoneSwipe', 'phoneKey'], base: true },
      { id: 'bili', label: '刷 B站（它自己会在手机上逛、看、回来跟你讲）', flags: ['biliSearch', 'biliSubtitles', 'biliFrames', 'biliLive', 'biliAudio'] },
      { id: 'shell', label: '在手机上执行命令（高危）', flags: ['phoneExec'], default: false }
    ]
  }
];

/** flag → 所属能力（建立反查表，判定用）。 */
const FLAG_TO_CAP = new Map();
for (const p of PLUGINS) for (const c of p.capabilities) for (const f of c.flags) FLAG_TO_CAP.set(f, { plugin: p.id, cap: c.id, def: c.default === true, base: c.base === true });

export const ALL_FLAGS = [...FLAG_TO_CAP.keys()];

/** 旧扁平开关 → 新结构：能力开 = 它覆盖的 flag 全为开（高危项默认关）。 */
export function migrateLegacyTools(legacyTools = {}) {
  const out = {};
  for (const p of PLUGINS) {
    const caps = {};
    for (const c of p.capabilities) {
      if (c.base) continue; // 基础能力不存开关
      const known = c.flags.filter((f) => Object.prototype.hasOwnProperty.call(legacyTools, f));
      caps[c.id] = known.length ? known.every((f) => legacyTools[f] !== false) : c.default === true;
    }
    out[p.id] = { enabled: Object.values(caps).some(Boolean), capabilities: caps };
  }
  return out;
}

/** 某能力当前是否可用（插件开 && 能力开）。找不到映射的 flag 默认放行。 */
export function capabilityEnabled(pluginsState, flag) {
  const info = FLAG_TO_CAP.get(flag);
  if (!info) return true;
  const st = pluginsState && typeof pluginsState === 'object' ? pluginsState : null;
  if (!st) return true;
  const plugin = st[info.plugin];
  if (!plugin || typeof plugin !== 'object') return true;
  if (plugin.enabled === false) return false;
  // 基础能力（看屏幕 / 操作手机）不单独存开关：插件开着就能用
  if (info.base) return true;
  const caps = plugin.capabilities && typeof plugin.capabilities === 'object' ? plugin.capabilities : null;
  if (!caps) return true;
  return caps[info.cap] !== false;
}

/** 控制台清单。 */
export function pluginCatalog(pluginsState = {}) {
  return PLUGINS.map((p) => {
    const st = pluginsState[p.id] || {};
    const caps = p.capabilities.map((c) => {
      const base = c.base === true;
      return {
        id: c.id,
        label: c.label,
        optIn: c.default === true,
        base,
        // 基础能力：插件开=可用；其余看自己的能力开关
        enabled: base
          ? st.enabled !== false
          : (st.capabilities && typeof st.capabilities === 'object' ? st.capabilities[c.id] !== false : c.default === true)
      };
    });
    return { id: p.id, name: p.name, icon: p.icon, desc: p.desc, enabled: st.enabled !== false && caps.some((c) => c.enabled), capabilities: caps };
  });
}

/** 高危（默认关）能力 id 集合——"全部开启"时跳过。 */
export const OPT_IN_CAPS = new Set(PLUGINS.flatMap((p) => p.capabilities.filter((c) => c.default === true).map((c) => `${p.id}:${c.id}`)));
