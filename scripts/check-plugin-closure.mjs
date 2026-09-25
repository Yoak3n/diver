/**
 * 打包后闭包自检：在最终产物（sidecar/）上按 Node 解析校验随包源码的全部裸导入。
 *
 * 解析环境 = **B′ 用户工作区模拟**（与 seed.ts 同机制的 junction）：在 %TEMP% 重建
 * `<cos>/node_modules → sidecar/node_modules` 与 `<cos>/plugins/node_modules/@diver/<slug>`
 * 链接，从用户侧路径解析。并断言真实落点 ⊆ sidecar —— 泄漏零容忍：
 * 旧检查锚定仓库源码，walk-up 借道开发机仓库根 node_modules 会假绿（真机必断）。
 *
 * 打包不变量：
 *  - 不带 *.tar* 依赖归档（P1 后依赖是真实文件，无需首启解压）
 *  - harness/packages 与 plugins 下无 node_modules 树（闭包集中在 node_modules/）
 *  - tsx loader 在位（command.rs 启动契约：node_modules/tsx/dist/loader.mjs）
 *  - 进程入口与出厂种子在位（RELEASE_ENTRY / plugins.seed/seed-manifest.json）
 * 用法：node scripts/check-plugin-closure.mjs   退出码 0=通过，1=有缺失。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve, dirname, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SIDE = join(ROOT, 'src-tauri', 'resources', 'sidecar')
const HARNESS = join(SIDE, 'harness')
const PLUGINS = join(SIDE, 'plugins')
const SEED = join(SIDE, 'plugins.seed')
const NM = join(SIDE, 'node_modules')

const { scanPackageDir, bareSpec } = await import('./lib/source-imports.mjs')

// ── 打包不变量 ───────────────────────────────────────────────────────────
const problems = []
function findTar(dir, depth = 0) {
  if (depth > 3) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isFile() && /\.tar(\.zst)?$/.test(e.name)) problems.push(`存在依赖归档（应已消除）: ${relative(ROOT, full)}`)
    if (e.isDirectory() && e.name !== 'node_modules') findTar(full, depth + 1)
  }
}
findTar(SIDE)

function findNestedNm(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const full = join(dir, e.name)
    if (e.name === 'node_modules') {
      problems.push(`随包源码树带 node_modules（应集中在 node_modules/）: ${relative(ROOT, full)}`)
      continue
    }
    findNestedNm(full)
  }
}
for (const root of [join(HARNESS, 'packages'), PLUGINS, SEED]) {
  if (existsSync(root)) findNestedNm(root)
}

if (!existsSync(join(NM, 'tsx', 'dist', 'loader.mjs'))) {
  problems.push('tsx loader 不在位: node_modules/tsx/dist/loader.mjs（command.rs 启动契约）')
}
if (!existsSync(join(PLUGINS, 'companion', 'src', 'companion-bundle.ts'))) {
  problems.push('进程入口不在位: plugins/companion/src/companion-bundle.ts（paths.rs RELEASE_ENTRY）')
}
if (!existsSync(join(SEED, 'seed-manifest.json'))) {
  problems.push('出厂种子 manifest 不在位: plugins.seed/seed-manifest.json（B′ 播种契约）')
} else {
  // manifest 与目录对账：目录里有的插件必须有 hash 记录（否则播种/对账判据缺失）
  const seed = JSON.parse(readFileSync(join(SEED, 'seed-manifest.json'), 'utf8'))
  for (const e of readdirSync(SEED, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    if (!seed.plugins?.[e.name]) problems.push(`plugins.seed/${e.name} 缺 manifest 记录`)
  }
}

// ── 用户工作区模拟（junction 与 seed.ts 同机制）──────────────────────────
const FAKE = join(tmpdir(), `cos-closure-${process.pid}`)
const FAKE_PLUGINS = join(FAKE, 'plugins')
rmSync(FAKE, { recursive: true, force: true })
mkdirSync(join(FAKE_PLUGINS, 'node_modules', '@diver'), { recursive: true })
const linkType = process.platform === 'win32' ? 'junction' : 'dir'
symlinkSync(NM, join(FAKE, 'node_modules'), linkType)
for (const e of readdirSync(SEED, { withFileTypes: true })) {
  if (!e.isDirectory() || e.name.startsWith('.')) continue
  let isDiverLib = false
  try {
    isDiverLib = String(JSON.parse(readFileSync(join(SEED, e.name, 'package.json'), 'utf8')).name ?? '').startsWith('@diver/')
  } catch { /* 无 package.json 的目录不链接 */ }
  if (isDiverLib) symlinkSync(join(SEED, e.name), join(FAKE_PLUGINS, 'node_modules', '@diver', e.name), linkType)
}
const SIDE_REAL = realpathSync(SIDE)

// ── 裸导入解析校验（与运行时同一解析算法 + 泄漏断言）──────────────────────
/** 随包源码包目录（harness 包 / 进程入口 / 种子插件）。 */
function shippedPackageDirs() {
  const dirs = []
  const pkgs = join(HARNESS, 'packages')
  if (existsSync(pkgs)) {
    for (const e of readdirSync(pkgs, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      if (e.name === 'dsh') {
        for (const d of readdirSync(join(pkgs, 'dsh'), { withFileTypes: true })) {
          if (d.isDirectory()) dirs.push(join(pkgs, 'dsh', d.name))
        }
        continue
      }
      dirs.push(join(pkgs, e.name))
    }
  }
  for (const root of [PLUGINS, SEED]) {
    if (!existsSync(root)) continue
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        dirs.push(join(root, e.name))
      }
    }
  }
  return dirs
}

let refCount = 0
const missing = new Map()
const leaks = []
for (const dir of shippedPackageDirs()) {
  const underSeed = dir.startsWith(SEED + sep)
  const slug = dir.split(sep).pop()
  for (const [spec, froms] of scanPackageDir(dir)) {
    if (!bareSpec(spec) || spec.startsWith('node:')) continue
    for (const f of froms) {
      refCount++
      // 种子插件在用户工作区侧解析（junction 模拟）；harness/入口按实际路径解析
      const from = underSeed ? join(FAKE_PLUGINS, slug, relative(dir, f)) : f
      let resolved
      try {
        resolved = createRequire(from).resolve(spec)
      } catch {
        if (!missing.has(spec)) missing.set(spec, new Set())
        missing.get(spec).add(relative(ROOT, f))
        continue
      }
      let real
      try {
        real = realpathSync(resolved)
      } catch {
        real = resolved
      }
      if (!(real === SIDE_REAL || real.startsWith(SIDE_REAL + sep))) {
        leaks.push(`${spec} → ${real}（from ${relative(ROOT, f)}）`)
      }
    }
  }
}

if (missing.size > 0) {
  console.error(`FAIL: ${missing.size} 个裸说明符无法解析`)
  for (const [spec, froms] of [...missing.entries()].sort()) {
    console.error(`  - ${spec}`)
    for (const f of [...froms].slice(0, 6)) console.error(`      from ${f}`)
    if (froms.size > 6) console.error(`      ... +${froms.size - 6} more`)
  }
}
if (leaks.length > 0) {
  console.error(`FAIL: ${leaks.length} 处解析泄漏出 sidecar（借道开发机/系统 node_modules，真机必断）`)
  for (const l of leaks.slice(0, 12)) console.error(`  - ${l}`)
  if (leaks.length > 12) console.error(`  ... +${leaks.length - 12} more`)
}
if (problems.length > 0) {
  console.error(`FAIL: ${problems.length} 个打包不变量违反`)
  for (const p of problems) console.error(`  - ${p}`)
}
rmSync(FAKE, { recursive: true, force: true })
if (missing.size || problems.length || leaks.length) process.exit(1)

const nmFiles = (() => {
  let n = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else n++
    }
  }
  walk(NM)
  return n
})()
console.log(`OK: ${refCount} 处裸导入在用户工作区链路全部可解析且无泄漏；无归档/嵌套依赖树；node_modules/ 共 ${nmFiles} 个文件`)
