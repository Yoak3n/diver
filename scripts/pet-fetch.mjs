// Diver 桌宠模型拉取脚本：下载 Live2D 官方示例「Hiyori」到 public/pet/models/Hiyori。
//
// 用法：
//   pnpm pet:fetch
//   PET_HIYORI_URL=<zip-url> node scripts/pet-fetch.mjs
//
// 官方示例包体约 4.7MB；仓库不提交模型文件，clone 后执行一次即可。

import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TARGET_DIR = join(ROOT, 'public', 'pet', 'models', 'Hiyori')
// 旧官方示例地址 cubism.live2d.com/sample-data/Hiyori/Hiyori.zip 已下线（HTTP 404）。
// 改用 Live2D 官方 CubismWebSamples 仓库定格 zipball（Hiyori 在 Samples/Resources/Hiyori/，
// findModelDir 可在 4 层内找到）；定格 commit 保证可复现，PET_HIYORI_URL 可覆盖。
const DEFAULT_URL =
  process.env.PET_HIYORI_URL ??
  'https://codeload.github.com/Live2D/CubismWebSamples/zip/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd'

function hasModel(dir) {
  return existsSync(join(dir, 'Hiyori.model3.json'))
}

if (hasModel(TARGET_DIR)) {
  console.log(`[pet:fetch] 模型已存在：${TARGET_DIR}`)
  process.exit(0)
}

const WORK_DIR = join(ROOT, 'public', 'pet', 'models', '.hiyori-download')
const ZIP = join(WORK_DIR, 'hiyori.zip')
const EXTRACT_DIR = join(WORK_DIR, 'extracted')

rmSync(WORK_DIR, { recursive: true, force: true })
mkdirSync(WORK_DIR, { recursive: true })
mkdirSync(EXTRACT_DIR, { recursive: true })

console.log(`[pet:fetch] 下载 ${DEFAULT_URL}`)
try {
  const res = await fetch(DEFAULT_URL)
  if (!res.ok || !res.body) {
    console.error(`[pet:fetch] 下载失败：HTTP ${res.status}`)
    process.exit(1)
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(ZIP))
} catch (err) {
  console.error(`[pet:fetch] 下载失败：${err?.message ?? err}`)
  console.error('[pet:fetch] 可通过 PET_HIYORI_URL 指定其他 zip 地址后重试')
  process.exit(1)
}

console.log(`[pet:fetch] 解压 ${ZIP}`)
try {
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${EXTRACT_DIR}' -Force`],
    { stdio: 'inherit' },
  )
} catch (err) {
  console.log(`[pet:fetch] PowerShell 解压失败（${err?.message ?? err}），尝试 tar 回退…`)
  try {
    execFileSync('tar', ['-xf', ZIP, '-C', EXTRACT_DIR], { stdio: 'inherit' })
  } catch (err2) {
    console.error(`[pet:fetch] tar 解压也失败：${err2?.message ?? err2}`)
    console.error(`[pet:fetch] 请手动解压 zip 到：${TARGET_DIR}`)
    process.exit(1)
  }
}

function findModelDir(dir, depth = 0) {
  if (depth > 4) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'Hiyori.model3.json' && entry.isFile()) return dir
    if (entry.isDirectory()) {
      const found = findModelDir(join(dir, entry.name), depth + 1)
      if (found) return found
    }
  }
  return null
}

const MODEL_DIR = findModelDir(EXTRACT_DIR)
if (!MODEL_DIR) {
  console.error('[pet:fetch] 解压包中未找到 Hiyori.model3.json，请检查下载源是否为 Hiyori 模型包')
  process.exit(1)
}

rmSync(TARGET_DIR, { recursive: true, force: true })
mkdirSync(TARGET_DIR, { recursive: true })
for (const entry of readdirSync(MODEL_DIR)) {
  renameSync(join(MODEL_DIR, entry), join(TARGET_DIR, entry))
}
rmSync(WORK_DIR, { recursive: true, force: true })

if (!hasModel(TARGET_DIR)) {
  console.error(`[pet:fetch] 安装后仍缺少 Hiyori.model3.json：${TARGET_DIR}`)
  process.exit(1)
}
// 拉取到的是官方原始模型包（只有 Idle/TapBody）：
// 1) 生成情绪动作文件（Hiyori_happy01 等）
// 2) 把情绪动作组声明补丁到 model3.json
// 这样 clone 后一条命令即可获得完整的情绪动作能力。
console.log('[pet:fetch] 应用情绪动作补丁…')
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'gen-motions.mjs')], { stdio: 'inherit' })
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'patch-model3.mjs'), join(TARGET_DIR, 'Hiyori.model3.json')], { stdio: 'inherit' })
  console.log('[pet:fetch] 情绪动作补丁完成')
} catch (err) {
  console.warn(`[pet:fetch] 情绪动作补丁失败（不影响模型本体）：${err?.message ?? err}`)
}
console.log(`[pet:fetch] 完成：${TARGET_DIR}`)
