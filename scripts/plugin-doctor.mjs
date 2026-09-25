// Diver 插件诊断脚本（随包使用）：装配一致性、依赖、改动状态、.incoming 合并提示。
//
// 用法（在 sidecar 运行时目录下）：
//   node plugin-doctor.mjs
//   node plugin-doctor.mjs --plugins <dir>   # 覆盖插件工作区目录
//
// 目标目录（P1c）：运行时唯一插件区 = 用户工作区
//   %APPDATA%\com.diver.companion\cos\plugins（COS_HOME 可覆盖）。
//
// 检查项：
//   1. bundles/bundle-companion/cordis.patch.yml 里声明的插件行，工作区是否有对应目录
//   2. 工作区多余的目录（patch 里没有的）
//   3. 每个插件的 package.json main 指向的入口是否存在
//   4. 插件声明的外部依赖是否已可解析
//   5. 引擎 harness/packages 是否完整
//   6. 改动状态（对比 plugins.seed/seed-manifest.json 出厂基线，只报告不判错）
//   7. .incoming/<ver>/<plugin> 官方新版合并提示

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = resolve(import.meta.dirname ?? '.')
const PLUGINS = (() => {
  const i = process.argv.indexOf('--plugins')
  if (i >= 0 && process.argv[i + 1]) return resolve(process.argv[i + 1])
  const cosHome = process.env.COS_HOME || join(process.env.APPDATA ?? homedir(), 'com.diver.companion', 'cos')
  return join(cosHome, 'plugins')
})()
const PATCH = join(HERE, 'bundles', 'bundle-companion', 'cordis.patch.yml')
const HARNESS = join(HERE, 'harness')
const SEED = join(HERE, 'plugins.seed', 'seed-manifest.json')

let issues = 0
function issue(msg) { console.error(`  ✗ ${msg}`); issues++ }
function ok(msg) { console.log(`  ✓ ${msg}`) }
function info(msg) { console.log(`  · ${msg}`) }
const isPluginDir = (e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')
const ignoredName = (name) => name === 'node_modules' || name.startsWith('.') || name.endsWith('.tsbuildinfo')

// 与 harness/packages/boot/src/seed-manifest.ts 同算法：归一化换行 sha256
function hashFile(path) {
  return createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n?/g, '\n'), 'utf8').digest('hex')
}
function hashTree(dir) {
  const out = {}
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      if (ignoredName(name)) continue
      const childRel = rel === '' ? name : `${rel}/${name}`
      const abs = join(dir, childRel)
      if (statSync(abs).isDirectory()) walk(childRel)
      else out[childRel] = hashFile(abs)
    }
  }
  walk('')
  return out
}

console.log(`Diver 插件诊断（工作区 ${PLUGINS}）：`)
const dirs = existsSync(PLUGINS)
  ? readdirSync(PLUGINS, { withFileTypes: true }).filter(isPluginDir).map((e) => e.name)
  : []

// 1. patch 声明的插件 vs 工作区目录
if (!existsSync(PATCH)) {
  issue(`缺少装配配置: ${PATCH}`)
} else {
  const patch = readFileSync(PATCH, 'utf8')
  const declared = [...patch.matchAll(/name:\s*['"]?@diver\/([A-Za-z0-9_-]+)/g)].map((m) => m[1])
  for (const name of declared) {
    if (!dirs.includes(name)) issue(`patch 声明了 @diver/${name}，但工作区 ${name} 不存在（删了插件请同时删 patch 行）`)
    else ok(`插件 ${name}: 目录与 patch 匹配`)
  }
  for (const name of dirs) {
    if (!declared.includes(name)) info(`工作区 ${name} 未在 patch 声明（自写插件请加 patch 行）`)
  }
  if (declared.length === 0 && dirs.length === 0) ok('无插件（空）')
}

// 2. 入口 + 依赖
if (existsSync(PLUGINS)) {
  const pluginsNm = join(PLUGINS, 'node_modules')
  for (const name of dirs) {
    const pkgPath = join(PLUGINS, name, 'package.json')
    if (!existsSync(pkgPath)) { issue(`${name} 缺少 package.json`); continue }
    let pkg
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) } catch { issue(`${name}/package.json 解析失败（可能是 BOM/编码问题）`); continue }
    const entry = join(PLUGINS, name, pkg.main ?? 'index.js')
    if (!existsSync(entry)) issue(`${name} 入口不存在: ${pkg.main ?? 'index.js'}`)
    else ok(`${name}: 入口 OK`)
    // 外部依赖检查（引擎 @cos、diver 库 @diver/@deepseek-ai/dsh-*、file: 源码依赖由内置映射提供）
    for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
      if (dep.startsWith('@cos/') || dep.startsWith('@diver/') || dep.startsWith('@deepseek-ai/dsh-')) continue
      if (String(range ?? '').startsWith('file:')) continue
      const resolvable = [
        join(PLUGINS, name, 'node_modules', dep),
        join(pluginsNm, dep),
        join(PLUGINS, '..', 'node_modules', dep),
      ].some((p) => existsSync(p))
      if (!resolvable) issue(`${name} 依赖 ${dep} 未安装（运行 node install-deps.mjs）`)
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

// 4. 改动状态（对比出厂基线，只报告不判错——改动是允许的）
if (!existsSync(SEED)) {
  info('未找到 plugins.seed/seed-manifest.json（旧版布局或非安装目录，跳过改动比对）')
} else {
  const seed = JSON.parse(readFileSync(SEED, 'utf8'))
  for (const name of dirs) {
    const entry = seed.plugins?.[name]
    if (!entry) { info(`${name}: 自写/第三方插件（不在出厂基线）`); continue }
    const user = hashTree(join(PLUGINS, name))
    const changed = Object.keys(user).filter((f) => entry.files[f] !== user[f])
    const added = changed.filter((f) => !(f in entry.files))
    const missing = Object.keys(entry.files).filter((f) => !(f in user))
    if (changed.length === 0 && missing.length === 0) info(`${name}: 未改动（升级时静默更新）`)
    else info(`${name}: 已改动——修改/新增 ${changed.length}（其中用户新增 ${added.length}）、缺失 ${missing.length}；升级时保留你的版本`)
  }
  for (const name of Object.keys(seed.plugins ?? {})) {
    if (!dirs.includes(name)) info(`${name}: 官方插件在工作区缺失（升级会重新播种）`)
  }
}

// 5. .incoming 合并提示
const incomingRoot = join(PLUGINS, '.incoming')
if (existsSync(incomingRoot)) {
  for (const ver of readdirSync(incomingRoot, { withFileTypes: true }).filter(isPluginDir)) {
    for (const d of readdirSync(join(incomingRoot, ver.name), { withFileTypes: true }).filter(isPluginDir)) {
      info(`官方新版待合并：.incoming/${ver.name}/${d.name}（合并后删除该目录）`)
    }
  }
}

if (issues === 0) console.log('\n诊断通过：无问题 ✓')
else console.log(`\n发现 ${issues} 个问题（见上）`)
process.exit(issues > 0 ? 1 : 0)
