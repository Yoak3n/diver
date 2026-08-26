// Diver 桌宠：把情绪动作组声明补丁应用到 Hiyori.model3.json
//
// 官方示例包的 model3.json 只有 Idle/TapBody 两组动作；
// 本脚本为它追加 Happy/Sad/Angry/Surprised/Shy/Nod/Wave 七个情绪动作组
// （动作文件由 scripts/gen-motions.mjs 生成）。
// pet-fetch.mjs 拉取官方模型后会自动调用本脚本，保证 clone 后功能完整。
//
// 用法：node scripts/patch-model3.mjs [model3.json 路径]

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_PATH = join(ROOT, 'public', 'pet', 'models', 'Hiyori', 'Hiyori.model3.json')
const target = process.argv[2] ?? DEFAULT_PATH

/** 情绪动作组声明（与动作文件名一一对应，动作由 gen-motions.mjs 生成）。 */
const EMOTION_GROUPS = [
  { name: 'Happy', files: ['Hiyori_happy01.motion3.json'], fadeIn: 0.3, fadeOut: 0.4 },
  { name: 'Sad', files: ['Hiyori_sad01.motion3.json'], fadeIn: 0.3, fadeOut: 0.4 },
  { name: 'Angry', files: ['Hiyori_angry01.motion3.json'], fadeIn: 0.3, fadeOut: 0.4 },
  { name: 'Surprised', files: ['Hiyori_surprised01.motion3.json'], fadeIn: 0.25, fadeOut: 0.35 },
  { name: 'Shy', files: ['Hiyori_shy01.motion3.json'], fadeIn: 0.3, fadeOut: 0.4 },
  { name: 'Nod', files: ['Hiyori_nod01.motion3.json'], fadeIn: 0.2, fadeOut: 0.3 },
  { name: 'Wave', files: ['Hiyori_wave01.motion3.json'], fadeIn: 0.25, fadeOut: 0.35 },
]

if (!existsSync(target)) {
  console.error(`[patch-model3] 未找到 ${target}，请先运行 pnpm pet:fetch 或 gen-motions`)
  process.exit(1)
}

const model = JSON.parse(readFileSync(target, 'utf8'))
const motions = model.FileReferences?.Motions
if (!motions) {
  console.error('[patch-model3] model3.json 缺少 FileReferences.Motions')
  process.exit(1)
}

let added = 0
for (const { name, files, fadeIn, fadeOut } of EMOTION_GROUPS) {
  // 已存在（幂等）：跳过
  if (motions[name]) continue
  motions[name] = files.map((f) => ({ File: `motions/${f}`, FadeInTime: fadeIn, FadeOutTime: fadeOut }))
  added++
}

if (added > 0) {
  writeFileSync(target, JSON.stringify(model, null, '\t'), 'utf8')
  console.log(`[patch-model3] 已追加 ${added} 个情绪动作组（${EMOTION_GROUPS.map((g) => g.name).join('/')}）`)
} else {
  console.log('[patch-model3] 情绪动作组已存在，无需修改')
}
