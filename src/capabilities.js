// 插件 → 能力 注册表（聊天模式「工具开关」的新结构）。
//
// 旧的开关是一张扁平表（config.socialV2.tools 里 47 个布尔），控制台也是一长串复选框，
// 看不出"这些能力属于同一块"，也没法整组开关。现在按**插件**归类：
//   插件 = 一组相关能力（聊天 / 媒体 / 记忆 / 群成员 / 后台任务 / 人格 / 手机 / B站）
//   能力 = 一个具体工具（沿用原来的 flag 名，保证后端判断、旧配置都能对上）
//
// 状态存 config.socialV2.plugins：{ [pluginId]: { enabled, capabilities: { [capId]: bool } } }
// 插件关掉 = 组内能力全关；能力单独关也生效（两者都开才算可用）。
import fs from 'node:fs';

/** 能力表：cap = 能力 id（默认与旧 flag 同名），flag = 旧的 tools 键名。 */
export const PLUGINS = [
  {
    id: 'chat',
    name: '聊天基础',
    icon: '💬',
    desc: '收发消息、等待与分析、唤醒配置——没有它这个群基本聊不了天',
    capabilities: [
      { id: 'getPrompt', label: '读取自己的提示词/角色卡' },
      { id: 'getUnread', label: '读未读消息' },
      { id: 'getRecent', label: '读最近消息' },
      { id: 'socialState', label: '查聊天状态（唤醒配置/未读）' },
      { id: 'sendMessage', label: '统一发送（可多条）' },
      { id: 'sendGroup', label: '发群消息' },
      { id: 'sendPrivate', label: '发私聊消息' },
      { id: 'reply', label: '引用回复' },
      { id: 'sendBurst', label: '连发多条' },
      { id: 'waitMessages', label: '等消息（判断对方说完了没）' },
      { id: 'markRead', label: '标记已读 / 潜水' },
      { id: 'setWakeConfig', label: '设置唤醒配置' },
      { id: 'getMyRecent', label: '查自己最近说过的话' },
      { id: 'getMessageDetail', label: '查看单条消息详情' },
      { id: 'getActiveMembers', label: '查活跃成员' },
      { id: 'sendPoke', label: '拍一拍' },
      { id: 'feedback', label: '向管理员反馈问题' }
    ]
  },
  {
    id: 'media',
    name: '媒体与表情',
    icon: '🖼️',
    desc: '图片、表情包、语音、视频、音乐、卡片——所有"发东西"的能力',
    capabilities: [
      { id: 'sendImage', label: '发图片' },
      { id: 'saveSticker', label: '保存外部图片进表情库' },
      { id: 'sendSticker', label: '发表情包' },
      { id: 'listStickers', label: '查收藏表情' },
      { id: 'getStickerImage', label: '看表情实际长什么样' },
      { id: 'setStickerRemark', label: '改 QQ 表情备注（动账号）' },
      { id: 'stickerNote', label: '记录自己的表情笔记' },
      { id: 'collectSticker', label: '收藏群友发的表情' },
      { id: 'getSelfImage', label: '看自己的默认形象' },
      { id: 'getImages', label: '看消息里的图片' },
      { id: 'getForwardMsg', label: '看合并转发' },
      { id: 'getMemberAvatar', label: '看群友/自己的头像' },
      { id: 'getFriendDress', label: '看个性装扮' },
      { id: 'videoFrames', label: 'B站视频抽帧' },
      { id: 'video', label: 'B站搜视频/读字幕' },
      { id: 'getMessageVideo', label: '看消息里的视频' },
      { id: 'pickSticker', label: '挑一张合适的表情' },
      { id: 'listImageLibrary', label: '查本地图库' },
      { id: 'searchImages', label: '联网找图' },
      { id: 'lookupMeme', label: '查梗/黑话含义' },
      { id: 'sendCard', label: '发链接卡片（网关版本门禁，默认关）' }
    ]
  },
  {
    id: 'memory',
    name: '记忆与知识',
    icon: '🧠',
    desc: '长期记忆、日记、群知识库、黑话库',
    capabilities: [
      { id: 'memory', label: '记忆（查询/写日记/召回）' },
      { id: 'knowledge', label: '群知识库（查/提交）' },
      { id: 'slangQuery', label: '查黑话库' },
      { id: 'slangSubmit', label: '提交黑话候选' }
    ]
  },
  {
    id: 'members',
    name: '群成员',
    icon: '🧑',
    desc: '给群友记备注、改群名片',
    capabilities: [
      { id: 'memberRemark', label: '记/改群友备注' },
      { id: 'setMemberCard', label: '改群名片（动账号，默认关）' }
    ]
  },
  {
    id: 'tasks',
    name: '后台任务',
    icon: '🛠️',
    desc: '长任务工作车道、自主探索学习',
    capabilities: [
      { id: 'runTask', label: '派发后台长任务' },
      { id: 'exploreTopic', label: '自主探索一个主题' }
    ]
  },
  {
    id: 'persona',
    name: '人格',
    icon: '🎭',
    desc: '改自己的头像/签名（动账号）',
    capabilities: [
      { id: 'setProfile', label: '改头像与签名（默认关）' }
    ]
  },
  {
    id: 'phone',
    name: '手机控制',
    icon: '📱',
    desc: '看到/操作那台 Android 手机（需要桥接侧开启，工具按能力逐个放行）',
    capabilities: [
      { id: 'phoneStatus', label: '探活（电量/隧道/亮屏）' },
      { id: 'phoneScreen', label: '查屏幕状态（前台应用/分辨率）' },
      { id: 'phoneScreenshot', label: '截屏' },
      { id: 'phoneTap', label: '点击屏幕' },
      { id: 'phoneSwipe', label: '滑动屏幕' },
      { id: 'phoneKey', label: '按键（返回/Home/电源）' },
      { id: 'phoneExec', label: '在手机上执行 shell（高危，默认关）' }
    ]
  },
  {
    id: 'bili',
    name: '刷 B站',
    icon: '📺',
    desc: '看 B站：搜索视频、读字幕、抽帧、看直播、下载音频（可单独启用）',
    capabilities: [
      { id: 'biliSearch', label: '搜视频/查赛事' },
      { id: 'biliSubtitles', label: '读视频字幕' },
      { id: 'biliFrames', label: '取视频画面' },
      { id: 'biliLive', label: '查直播是否在播' },
      { id: 'biliAudio', label: '从视频抽音频（语音包）' }
    ]
  }
];

export const ALL_CAPS = PLUGINS.flatMap((p) => p.capabilities.map((c) => ({ ...c, plugin: p.id, pluginName: p.name })));

/** 旧扁平开关 → 新结构（迁移用）。未知 flag 归到 chat 之外会丢，所以这里保留兜底 extra。 */
export function migrateLegacyTools(legacyTools = {}) {
  const out = {};
  for (const p of PLUGINS) {
    const caps = {};
    for (const c of p.capabilities) {
      const key = c.flag || c.id;
      // 旧配置里有就用旧值；没有（= 新加的能力，如手机/B站）默认**关**，由人在控制台开。
      caps[c.id] = Object.prototype.hasOwnProperty.call(legacyTools, key) ? legacyTools[key] !== false : c.default === true;
    }
    // 组内全关时把插件也标记为关，界面上更直观
    out[p.id] = { enabled: Object.values(caps).some(Boolean), capabilities: caps };
  }
  return out;
}

/** 某个旧 flag 现在是否可用（插件开 && 能力开）。缺配置时回退到旧扁平表，保证升级不炸。 */
export function capabilityEnabled(pluginsState, flag) {
  const cap = ALL_CAPS.find((c) => (c.flag || c.id) === flag);
  if (!cap) return true; // 注册表里没有的能力（新加的代码）默认放行
  const st = pluginsState && typeof pluginsState === 'object' ? pluginsState : null;
  if (!st) return true;
  const plugin = st[cap.plugin];
  if (!plugin || typeof plugin !== 'object') return true;
  if (plugin.enabled === false) return false;
  const caps = plugin.capabilities && typeof plugin.capabilities === 'object' ? plugin.capabilities : null;
  if (!caps) return true;
  return caps[cap.id] !== false;
}

/** 生成给控制台用的清单（含每一项当前状态）。 */
export function pluginCatalog(pluginsState = {}) {
  return PLUGINS.map((p) => {
    const st = pluginsState[p.id] || {};
    const caps = p.capabilities.map((c) => ({
      id: c.id,
      label: c.label,
      enabled: (st.capabilities && typeof st.capabilities === 'object')
        ? st.capabilities[c.id] !== false
        : true
    }));
    return {
      id: p.id, name: p.name, icon: p.icon, desc: p.desc,
      enabled: st.enabled !== false && caps.some((c) => c.enabled),
      capabilities: caps
    };
  });
}
