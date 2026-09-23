// agent preset 组成戳。
//
// 背景（DSH 的硬行为，不是桥接的 bug）：一个会话的 agent preset 在**创建时读一次**，
// 之后永不重读——dsh-agent-presets 的 swap() 会以 `agent-preset/locked`
// 拒绝「已经开过回合的会话」换 preset。所以改了
// `~/.dsh/.agent-presets/<id>/agent.cordis.yml` 后，**已存在的 QQ 会话仍跑旧设定**，
// 典型症状：预设里改了「群友要图时怎么找」，QQ 里还是按老规矩搪塞。
//
// 解法：给每个会话记一份它建会话时的组成戳（这里是纯函数，便于离线单测），
// 桥接在复用会话前比对；对不上就退役重建，让预设改动真正生效。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 参与戳的组成文件（按固定顺序读，缺一个也计入，避免「删了文件反而戳不变」）。 */
export const PRESET_STAMP_FILES = Object.freeze(['agent.cordis.yml', 'preset.yml']);

/** DSH 根目录：优先环境变量，其次 ~/.dsh（与 scripts/setup-dsh.mjs 一致）。 */
export function resolveDshHome(env = process.env) {
  const override = String(env?.DSH_HOME ?? '').trim();
  return override || path.join(os.homedir(), '.dsh');
}

/**
 * 计算一个 preset 的组成戳（短 sha1）。
 *
 * @param {string} presetId preset id（如 `qq-chat-v2`）
 * @param {{dshHome?:string, files?:string[]}} [opts]
 * @returns {string} 16 位十六进制；**读不到任何组成文件时返回 ''**（表示「无法判断」，
 *   调用方据此跳过陈旧判定，避免在 preset 未安装时反复重建会话）。
 */
export function presetCompositionStamp(presetId, { dshHome = resolveDshHome(), files = PRESET_STAMP_FILES } = {}) {
  const id = String(presetId ?? '').trim();
  if (!id) return '';
  const dir = path.join(dshHome, '.agent-presets', id);
  const hash = crypto.createHash('sha1');
  let found = false;
  for (const name of files) {
    hash.update(name).update('\0');
    try {
      hash.update(fs.readFileSync(path.join(dir, name)));
      found = true;
    } catch {
      hash.update('\0missing');
    }
  }
  return found ? hash.digest('hex').slice(0, 16) : '';
}
