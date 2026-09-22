// Diver 桌宠可选模型拉取：安装 N.E.K.O 的 YUI 模型到 public/pet/models/
//
// 用法：
//   pnpm pet:models          # Hiyori（若缺）+ YUI 两套
//   pnpm pet:models:yui      # 仅 YUI
//
// 学习评估用途。YUI 角色/模型版权归 Project N.E.K.O. Team，
// 仓库 Apache-2.0 不自动授予角色商用再分发权，请勿打进对外发行包。
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MODELS_DIR = join(ROOT, 'public', 'pet', 'models')
const WORK_DIR = join(MODELS_DIR, '.yui-work')

const YUI_PACKS = [
  {
    id: 'yui-lolita',
    url: process.env.PET_YUI_LOLITA_URL
      ?? 'https://raw.githubusercontent.com/Project-N-E-K-O/N.E.K.O/main/assets/yui-lolita.tar.gz',
    model3Name: 'yui-lolita.model3.json',
  },
  {
    id: 'yui-origin',
    url: process.env.PET_YUI_ORIGIN_URL
      ?? 'https://raw.githubusercontent.com/Project-N-E-K-O/N.E.K.O/main/assets/yui-origin.tar.gz',
    model3Name: 'yui-origin.model3.json',
  },
]

const onlyYui = process.argv.includes('--yui')

function hasFile(p) {
  return existsSync(p)
}

/** 把模型根目录里散落的 shy*.motion3.json 补进 model3.json 的 Motions.shy（YUI 原包漏声明）。 */
function ensureShyGroup(model3Path) {
  const dir = dirname(model3Path)
  const raw = JSON.parse(readFileSync(model3Path, 'utf8'))
  const motions = raw?.FileReferences?.Motions
  if (!motions) return
  const found = readdirSync(dir)
    .filter((n) => /^shy\d+\.motion3\.json$/i.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  if (!found.length) return
  const next = found.map((File) => ({ File }))
  const prev = (motions.shy ?? []).map((m) => m.File).join(',')
  const now = next.map((m) => m.File).join(',')
  if (prev === now) return
  motions.shy = next
  writeFileSync(model3Path, JSON.stringify(raw, null, 2) + '\n', 'utf8')
  console.log(`[pet:models] 已补声明 shy 动作组：${now}`)
}

/** YUI 原包 LipSync Ids 为空 → 口型同步失效。补上标准嘴部参数。 */
function ensureLipSyncGroup(model3Path) {
  const raw = JSON.parse(readFileSync(model3Path, 'utf8'))
  const groups = raw?.Groups
  if (!Array.isArray(groups)) return
  const lip = groups.find((g) => g?.Name === 'LipSync')
  const need = ['ParamMouthOpenY', 'ParamMouthForm']
  if (lip && Array.isArray(lip.Ids) && need.every((id) => lip.Ids.includes(id))) return
  if (lip) {
    lip.Ids = need
  } else {
    groups.push({ Target: 'Parameter', Name: 'LipSync', Ids: need })
  }
  writeFileSync(model3Path, JSON.stringify(raw, null, 2) + '\n', 'utf8')
  console.log(`[pet:models] 已补 LipSync 参数组：${need.join(', ')}`)
}

async function download(url, dest) {
  console.log(`[pet:models] 下载 ${url}`)
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

function extractTarGz(tgz, destDir) {
  mkdirSync(destDir, { recursive: true })
  execFileSync('tar', ['-xzf', tgz, '-C', destDir], { stdio: 'inherit' })
}

function findModel3(dir, name, depth = 0) {
  if (depth > 5) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return dir
    if (entry.isDirectory()) {
      const hit = findModel3(p, name, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

async function installPack(pack) {
  const target = join(MODELS_DIR, pack.id)
  const model3 = join(target, pack.model3Name)
  if (hasFile(model3)) {
    console.log(`[pet:models] 已存在：${target}`)
    ensureShyGroup(model3)
    ensureLipSyncGroup(model3)
    return
  }

  rmSync(WORK_DIR, { recursive: true, force: true })
  mkdirSync(WORK_DIR, { recursive: true })
  const tgz = join(WORK_DIR, `${pack.id}.tar.gz`)
  const extractDir = join(WORK_DIR, 'extracted')

  await download(pack.url, tgz)
  console.log(`[pet:models] 解压 ${pack.id}`)
  extractTarGz(tgz, extractDir)

  const src = findModel3(extractDir, pack.model3Name)
  if (!src) {
    throw new Error(`解压包中未找到 ${pack.model3Name}`)
  }
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(src)) {
    renameSync(join(src, entry), join(target, entry))
  }
  rmSync(WORK_DIR, { recursive: true, force: true })

  if (!hasFile(model3)) {
    throw new Error(`安装后仍缺少 ${model3}`)
  }
  ensureShyGroup(model3)
  ensureLipSyncGroup(model3)
  console.log(`[pet:models] 完成：${target}`)
}

// 可选：确保 Hiyori 在场（切换功能的默认模型）
if (!onlyYui) {
  const hiyori = join(MODELS_DIR, 'Hiyori', 'Hiyori.model3.json')
  if (!hasFile(hiyori)) {
    console.log('[pet:models] Hiyori 缺失，先跑 pet:fetch…')
    try {
      execFileSync(process.execPath, [join(ROOT, 'scripts', 'pet-fetch.mjs')], { stdio: 'inherit' })
    } catch (err) {
      console.warn(`[pet:models] Hiyori 拉取失败（可稍后 pnpm pet:fetch）：${err?.message ?? err}`)
    }
  }
}

for (const pack of YUI_PACKS) {
  try {
    await installPack(pack)
  } catch (err) {
    console.error(`[pet:models] ${pack.id} 安装失败：${err?.message ?? err}`)
    process.exitCode = 1
  }
}

console.log('[pet:models] 全部处理完毕（YUI 仅供本地学习评估）')
