// 出站口播清洗的自检脚本（纯逻辑，不用桥接、不用网络）：
// 「行，」「总结：」这类确定性字符串靠提示词压不住（提示词里已经点名禁过，线上照样出现），
// 所以加一层出站机械清洗。这里钉住三件事：
//   1. 该洗的都要洗掉（含全角/半角标点、叠加出现）
//   2. 不该碰的**一个都不能碰**（正常语义的「行」「总结一下」等）
//   3. 洗完不能变成空消息
// 运行：node scripts/test-speech-style.mjs
import { scrubFormulaicSpeech, describeScrub } from '../src/speech-style.js';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}
const sc = (s, o) => scrubFormulaicSpeech(s, o);

console.log('\n## 该洗掉的（线上真实样本）');
{
  const a = sc('行，我先按S31那个价位看，谢了');
  check('「行，」开头 → 削掉', a.text === '我先按S31那个价位看，谢了', a.text);
  const b = sc('行，S31和初耳NOVA都记本子上了，谢两位');
  check('第二条线上样本', b.text === 'S31和初耳NOVA都记本子上了，谢两位', b.text);
  const c = sc('总结：加钱才有那一档体验，一分钱一分货');
  check('「总结：」→ 削掉标签留正文', c.text === '加钱才有那一档体验，一分钱一分货', c.text);
  check('命中类别可读', describeScrub(c.hits).includes('总结标签'), JSON.stringify(c.hits));

  check('半角逗号也认', sc('行,走吧').text === '走吧');
  check('半角冒号也认', sc('结论:就是这样').text === '就是这样');
  check('句号版也认', sc('行。那就这样').text === '那就这样');
  check('「好的，」也认', sc('好的，我这就去看').text === '我这就去看');
  check('标签+发语词叠加', sc('总结：行，那就这样').text === '那就这样', sc('总结：行，那就这样').text);
  check('「总而言之：」', sc('总而言之：这钱花得值').text === '这钱花得值');
  check('「一句话总结：」', sc('一句话总结：别熬夜').text === '别熬夜');
  check('「综上：」', sc('综上：方案A更稳').text === '方案A更稳');
  check('前导空格不影响清洗', sc('  行，走').text === '走');
  // 「X 了，」确认收到式开场（owner 反馈「认了/搜了/懂了 这些词 AI 味太重」后的线上样本）
  check('「搜了，懂了，」连剥两层', sc('搜了，懂了，这就是柚子社那套表情包的味道').text === '这就是柚子社那套表情包的味道', sc('搜了，懂了，这就是柚子社那套表情包的味道').text);
  check('「认了，」', sc('认了，我这脸现在挺柚子的').text === '我这脸现在挺柚子的');
  check('「懂了，」', sc('懂了，合着我刚那句话是趴在猫上面发出去的').text === '合着我刚那句话是趴在猫上面发出去的');
  check('「知道了，」', sc('知道了，我这就去改').text === '我这就去改');
  check('「明白了，」', sc('明白了，是我看错了').text === '是我看错了');
  check('「记下了，」', sc('记下了，下回注意').text === '下回注意');
  check('「收到了，」', sc('收到了，马上去办').text === '马上去办');
  check('「查了，」', sc('查了，那本书是 2021 年出的').text === '那本书是 2021 年出的');
  check('「看到了，」', sc('看到了，怪我眼瞎').text === '怪我眼瞎');
  check('半角逗号也认（X 了版）', sc('懂了,走吧').text === '走吧');
}

console.log('\n## 一个都不能碰的（误伤检查）');
{
  const keep = [
    '那就这么办',                       // 没有发语词
    '行',                               // 只有一个字
    '行，',                             // 洗完是空 → 必须保留原文
    '行，。',                           // 同上
    '这个方案行，我同意',                // 句中的「行，」不是开场
    '总结一下这周的进展',                // 「总结」没有冒号 → 不是标签
    '总结',                             // 同上
    '结论很明显',                        // 没有冒号
    '我总结：三条都成立',                // 「我总结：」不是句首标签（前面有「我」）
    '银行，转账记得看账号',              // 「行，」在「银行」里，不是开头
    '好了，别提了',                      // 「好了」不在清洗名单里
    '行不行，你说了算',                  // 开头的「行不行」不是「行+标点」
    '总之不是他干的',                    // 「总之」没有冒号
    '服了，你这操作',                    // 带态度的「服了」不洗（削掉会改语气）
    '行了，别念了',                      // 同上：真人语气，不是确认收到
    '查了一下，是这样',                  // 「查了」后面没紧跟标点 → 正常说法
    '看到了吗',                          // 同上
    '认了吧你',                          // 同上
    '知道了就好',                        // 同上
    '我懂了，你别说了',                  // 发语词必须真的在句首
  ];
  for (const s of keep) {
    const r = sc(s);
    check(`不动：${s.slice(0, 14)}`, r.text === s, `被改成了 ${JSON.stringify(r.text)}`);
  }
}

console.log('\n## 边界');
{
  check('空串', sc('').text === '' && sc('').changed === false);
  check('null 不炸', sc(null).text === '');
  check('undefined 不炸', sc(undefined).text === '');
  check('纯空格', sc('   ').text === '   ');
  check('没命中时 changed=false', sc('普通一句话').changed === false);
  check('命中时 changed=true', sc('行，普通一句话').changed === true);
  check('只跑指定清洗器：只洗标签', sc('总结：行，走', { scrubbers: ['label'] }).text === '行，走');
  // opener 清洗器只管句首；这里的句首是标签不是发语词，所以不该动（两个都开时才会接着洗第二层）。
  check('只跑指定清洗器：只洗发语词', sc('总结：行，走', { scrubbers: ['opener'] }).text === '总结：行，走');
  check('多次命中会记录', sc('总结：行，走').hits.length === 2);
}

console.log('\n## 真实样本回放（今天线上那三条）');
{
  const samples = [
    ['总结：加钱才有那一档体验，一分钱一分货', '加钱才有那一档体验，一分钱一分货'],
    ['行，我先按S31那个价位看，谢了', '我先按S31那个价位看，谢了'],
    ['行，S31和初耳NOVA都记本子上，谢两位', 'S31和初耳NOVA都记本子上，谢两位']
  ];
  for (const [before, after] of samples) {
    check(`回放：${before.slice(0, 12)}…`, sc(before).text === after, sc(before).text);
  }
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exitCode = failed > 0 ? 1 : 0;
