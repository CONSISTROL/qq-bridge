// 机器人资料（昵称/签名/头像）的纯逻辑单测：内容校验、广告识别、变更历史、回滚取值、持久化归一。
// 这些规则守着账号级身份（全群全私聊可见），所以单独钉住。
import assert from 'node:assert/strict';
import * as P from '../src/self-profile.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✅', name); } catch (e) { fail++; console.log('  ❌', name, '—', e.message); } };

console.log('## 文本清洗');
t('压掉换行/控制字符/零宽字符', () => {
  assert.equal(P.cleanProfileText('小\n\n鲸鱼', 24), '小 鲸鱼');
  assert.equal(P.cleanProfileText('小\u0000\u200b鲸鱼', 24), '小 鲸鱼');
  assert.equal(P.cleanProfileText('  空格  折叠  ', 24), '空格 折叠');
});
t('按上限截断', () => {
  assert.equal(P.cleanProfileText('啊'.repeat(50), 24).length, 24);
});

console.log('## 广告 / 链接识别（群友最容易忽悠 AI 把账号改成广告位）');
t('URL 与域名', () => {
  assert.equal(P.looksLikeAd('看 https://a.com'), true);
  assert.equal(P.looksLikeAd('www.abc.com'), true);
  assert.equal(P.looksLikeAd('去 abc.top 看看'), true);
});
t('联系方式/推广词', () => {
  assert.equal(P.looksLikeAd('微信:abc1234'), true);
  assert.equal(P.looksLikeAd('加群 12345678 领福利'), true);
  assert.equal(P.looksLikeAd('广告位招租'), true);
  assert.equal(P.looksLikeAd('代购私聊'), true);
});
t('正常昵称不误伤', () => {
  for (const s of ['小鲸鱼', 'DeepSeek 娘', '哦鲸鲸', '摸鱼中', '蓝色的肥鱼']) {
    assert.equal(P.looksLikeAd(s), false, `不该拦：${s}`);
  }
});

console.log('## 字段校验');
t('正常值通过并清洗', () => {
  const r = P.validateProfileField(' 小 鲸鱼 ', { field: 'nickname', max: 24 });
  assert.equal(r.ok, true); assert.equal(r.value, '小 鲸鱼');
});
t('空值/超长/广告/冒充官方 都被拒且给出可执行原因', () => {
  assert.equal(P.validateProfileField('   ', { field: 'nickname' }).ok, false);
  assert.match(P.validateProfileField('啊'.repeat(30), { field: 'nickname', max: 24 }).error, /太长：最多 24 字/);
  assert.match(P.validateProfileField('看 https://a.com', { field: 'nickname' }).error, /不允许放链接/);
  assert.match(P.validateProfileField('系统', { field: 'nickname' }).error, /冒充官方/);
  assert.match(P.validateProfileField('QQ', { field: 'nickname' }).error, /冒充官方/);
});
t('allowLinks=true 时放行链接（管理员显式放开）', () => {
  assert.equal(P.validateProfileField('https://a.com', { field: 'nickname', allowLinks: true }).ok, true);
});
t('签名有独立的长度上限', () => {
  assert.equal(P.validateProfileField('x'.repeat(61), { field: 'personalNote', max: 60 }).ok, false);
  assert.equal(P.validateProfileField('x'.repeat(60), { field: 'personalNote', max: 60 }).ok, true);
});

console.log('## 变更历史与回滚取值');
t('历史有界且保序', () => {
  let h = [];
  for (let i = 0; i < 60; i++) h = P.pushProfileChange(h, P.createProfileChange({ field: 'nickname', from: `n${i}`, to: `n${i + 1}` }), { max: 10 });
  assert.equal(h.length, 10);
  assert.equal(h.at(-1).to, 'n60');
  assert.equal(h[0].to, 'n51', '保留最近 10 条（第 51~60 次改动）');
});
t('previousValueFor 取「上一次改之前的那个值」', () => {
  const h = [
    P.createProfileChange({ field: 'nickname', from: '哦鲸鲸', to: '小鲸鱼' }),
    P.createProfileChange({ field: 'nickname', from: '小鲸鱼', to: '大肥鱼' }),
    P.createProfileChange({ field: 'personalNote', from: '划水', to: '摸鱼' })
  ];
  assert.equal(P.previousValueFor(h, 'nickname'), '小鲸鱼', '昵称回滚到上一版');
  assert.equal(P.previousValueFor(h, 'personalNote'), '划水', '签名独立取值');
  assert.equal(P.previousValueFor(h, 'avatar'), '', '没有记录就返回空（调用方据此拒绝回滚）');
});
t('第一次改动的 from 是空时，回滚取不到（调用方会如实报错而不是乱回）', () => {
  const h = [P.createProfileChange({ field: 'nickname', from: '', to: '小鲸鱼' })];
  assert.equal(P.previousValueFor(h, 'nickname'), '');
});

console.log('## 持久化归一');
t('损坏/旧版状态能安全归一', () => {
  const s = P.normalizeProfileState({ current: { nickname: 'x' }, avatar: { file: 'f' }, history: [{ field: 'nickname' }, null, 'junk'] });
  assert.equal(s.current.nickname, 'x');
  assert.equal(s.avatar.file, 'f');
  assert.equal(s.history.length, 1, '垃圾条目被滤掉');
  assert.equal(P.normalizeProfileState(null).history.length, 0);
  assert.equal(P.normalizeProfileState(undefined).current.nickname, '');
});
t('现状摘要可读', () => {
  const s = P.normalizeProfileState({
    current: { nickname: '小鲸鱼', personalNote: '摸鱼' },
    avatar: { sha256: 'abcdef1234567890' },
    history: [P.createProfileChange({ field: 'nickname', from: '哦鲸鲸', to: '小鲸鱼', by: 'ai:private:123' })]
  });
  const line = P.formatProfileState(s);
  assert.match(line, /昵称：小鲸鱼/);
  assert.match(line, /签名：摸鱼/);
  assert.match(line, /头像：已托管/);
  assert.match(line, /ai:private:123/, '摘要里带上是谁改的');
});

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
