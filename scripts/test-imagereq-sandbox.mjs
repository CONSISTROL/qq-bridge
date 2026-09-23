// ⚠️ 诊断脚本：会创建一个挂了 qq-chat-v2 预设的真实 DSH 会话，并按唤醒格式喂一句话。
// 模型如果决定发言/发图，会**真的**通过桥接发到目标会话（默认 private:10001），
// 所以别拿群号跑。用途：改完预设/工具描述后，验证模型的真实行为（而不是靠猜）。
//
// 用法：node scripts/test-imagereq-sandbox.mjs [要喂的那句话]

import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient, unwrap, discoverDshLaunchToken } from '../src/dsh-client.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const cfg = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));
const KEY = 'private:10001';
const token = JSON.parse(fs.readFileSync(`${ROOT}/state/social-v2.json`, 'utf8')).conversations[KEY].agentToken;

const dsh = cfg.dsh ?? {};
const launchToken = dsh.authToken || discoverDshLaunchToken() || '';
const api = new NodeApiClient(dsh.baseUrl || 'http://127.0.0.1:3080', undefined, {
  token: launchToken, header: dsh.authHeader || 'authorization', prefix: dsh.authPrefix || 'Bearer'
});

const ws = unwrap(await api.workspace.create({ path: path.join(ROOT, 'state', 'agents') }), 'workspace.create');
const created = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId, agentPreset: 'qq-chat-v2' }), 'session.create');
const sessionId = created.sessionId;
console.log('沙盒 sessionId =', sessionId);

const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const prompt = [
  `【当前时间】${now}（Asia/Shanghai）`,
  `【会话令牌】${token}（调用二代状态/发送工具时请在参数中带上此令牌）`,
  '',
  `【唤醒】${KEY}`,
  '原因：收到新消息。',
  '【行动前】先判断：群里在聊什么？有没有人直接找你？对方说完了吗？你有没有真正想说的？',
  '你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前必须按【沉睡前强制等待】先等够观察窗口。',
  '',
  '【新消息】',
  `${KEY}（私聊）：${process.argv[2] || '来点永雏塔菲色图'}`
].join('\n');

const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] });
console.log('prompt 已接受:', JSON.stringify(accepted).slice(0, 160));
fs.writeFileSync('/tmp/sandbox-session-id.txt', sessionId);
