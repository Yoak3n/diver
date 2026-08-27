// Diver 插件诊断脚本（随包使用）：检查插件目录与装配配置是否一致、依赖是否齐全。
//
// 用法（在 sidecar 运行时目录下）：
//   node plugin-doctor.mjs
//
// 检查项：
//   1. bundles/bundle-companion/cordis.patch.yml 里声明的插件行，plugins/ 下是否有对应目录
//   2. plugins/ 下多余的目录（patch 里没有的）
//   3. 每个插件的 package.json main 指向的入口是否存在
//   4. 插件声明的外部依赖是否已在 plugins/node_modules（或可被解析）
//   5. 引擎 harness/packages 是否完整

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = resolve(import.meta.dirname ?? '.')
const PLUGINS = join(HERE, 'plugins')
const PATCH = join(HERE, 'bundles', 'bundle-companion', 'cordis.patch.yml')
const HARNESS = join(HERE, 'harness')

let issues = 0
function issue(msg) { console.error(`  ✗ ${msg}`); issues++ }
function ok(msg) { console.log(`  ✓ ${msg}`) }

console.log('Diver 插件诊断：')

// 1. patch 声明的插件 vs plugins/ 目录
if (!existsSync(PATCH)) {
  issue(`缺少装配配置: ${PATCH}`)
} else {
  const patch = readFileSync(PATCH, 'utf8')
  const declared = [...patch.matchAll(/name:\s*['"]?@diver\/([A-Za-z0-9_-]+)/g)].map((m) => m[1])
  const dirs = existsSync(PLUGINS)
    ? readdirSync(PLUGINS, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'node_modules').map((e) => e.name)
    : []
  for (const name of declared) {
    if (!dirs.includes(name)) issue(`patch 声明了 @diver/${name}，但 plugins/${name} 不存在（删了插件请同时删 patch 行）`)
    else ok(`插件 ${name}: 目录与 patch 匹配`)
  }
  for (const name of dirs) {
    if (!declared.includes(name)) issue(`plugins/${name} 存在，但 patch 未声明（新增插件请加 patch 行）`)
  }
  if (declared.length === 0 && dirs.length === 0) ok('无插件（空）')
}

// 2. 每个插件入口 + 依赖
if (existsSync(PLUGINS)) {
  const pluginsNm = join(PLUGINS, 'node_modules')
  for (const dir of readdirSync(PLUGINS, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === 'node_modules') continue
    const pkgPath = join(PLUGINS, dir.name, 'package.json')
    if (!existsSync(pkgPath)) { issue(`plugins/${dir.name} 缺少 package.json`); continue }
    let pkg
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { issue(`plugins/${dir.name}/package.json 解析失败（可能是 BOM/编码问题）`); continue }
    const entry = join(PLUGINS, dir.name, pkg.main ?? 'index.js')
    if (!existsSync(entry)) issue(`plugins/${dir.name} 入口不存在: ${pkg.main ?? 'index.js'}`)
    else ok(`${dir.name}: 入口 OK`)
    // 外部依赖检查
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (dep.startsWith('@cos/')) continue // 引擎核心由 harness 提供
      const resolvable = existsSync(join(pluginsNm, dep)) || existsSync(join(PLUGINS, dir.name, 'node_modules', dep))
      if (!resolvable) issue(`${dir.name} 依赖 ${dep} 未安装（运行 node install-deps.mjs）`)
    }
  }
}

// 3. 引擎完整性
if (existsSync(HARNESS)) {
  const pkgs = readdirSync(join(HARNESS, 'packages'), { withFileTypes: true }).filter((e) => e.isDirectory()).length
  ok(`引擎 harness/packages: ${pkgs} 个包`)
} else {
  issue('缺少引擎目录 harness/')
}

if (issues === 0) console.log('\n诊断通过：无问题 ✓')
else console.log(`\n发现 ${issues} 个问题（见上）`)
process.exit(issues > 0 ? 1 : 0)
