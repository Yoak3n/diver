/**
 * 打包后闭包自检：在最终产物（sidecar/）上按 Node 解析校验随包源码的全部裸导入。
 * 与运行时同算法：createRequire(源码文件).resolve(spec)（走 node_modules 共享解析根）。
 * 并断言打包不变量：
 *  - 不带 *.tar* 依赖归档（P1 后依赖是真实文件，无需首启解压）
 *  - harness/packages 与 plugins 下无 node_modules 树（闭包集中在 node_modules/）
 *  - tsx loader 在位（command.rs 启动契约：node_modules/tsx/dist/loader.mjs）
 * 用法：node scripts/check-plugin-closure.mjs   退出码 0=通过，1=有缺失。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SIDE = join(ROOT, 'src-tauri', 'resources', 'sidecar')
const HARNESS = join(SIDE, 'harness')
const PLUGINS = join(SIDE, 'plugins')
const NM = join(SIDE, 'node_modules')

const { scanPackageDir, bareSpec } = await import('./lib/source-imports.mjs')

// ── 打包不变量 ───────────────────────────────────────────────────────────
const problems = []
function findTar(dir, depth = 0) {
  if (depth > 3) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isFile() && /\.tar(\.zst)?$/.test(e.name)) problems.push(`存在依赖归档（应已消除）: ${full.replace(ROOT + '\\', '')}`)
    if (e.isDirectory() && e.name !== 'node_modules') findTar(full, depth + 1)
  }
}
findTar(SIDE)

function findNestedNm(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const full = join(dir, e.name)
    if (e.name === 'node_modules') {
      problems.push(`随包源码树带 node_modules（应集中在 node_modules/）: ${full.replace(ROOT + '\\', '')}`)
      continue
    }
    findNestedNm(full)
  }
}
for (const root of [join(HARNESS, 'packages'), PLUGINS]) {
  if (existsSync(root)) findNestedNm(root)
}

if (!existsSync(join(NM, 'tsx', 'dist', 'loader.mjs'))) {
  problems.push('tsx loader 不在位: node_modules/tsx/dist/loader.mjs（command.rs 启动契约）')
}

// ── 裸导入解析校验（与运行时同一解析算法）────────────────────────────────
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
  for (const e of readdirSync(PLUGINS, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      dirs.push(join(PLUGINS, e.name))
    }
  }
  return dirs
}

let refCount = 0
const missing = new Map()
for (const dir of shippedPackageDirs()) {
  const found = scanPackageDir(dir)
  for (const [spec, froms] of found) {
    if (!bareSpec(spec) || spec.startsWith('node:')) continue
    for (const f of froms) {
      refCount++
      try {
        createRequire(f).resolve(spec)
      } catch {
        if (!missing.has(spec)) missing.set(spec, new Set())
        missing.get(spec).add(f.replace(ROOT + '\\', '').replace(ROOT + '/', ''))
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
if (problems.length > 0) {
  console.error(`FAIL: ${problems.length} 个打包不变量违反`)
  for (const p of problems) console.error(`  - ${p}`)
}
if (missing.size || problems.length) process.exit(1)

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
console.log(`OK: ${refCount} 处裸导入全部可解析；无归档/嵌套依赖树；node_modules/ 共 ${nmFiles} 个文件`)
