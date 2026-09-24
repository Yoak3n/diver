// Diver release 打包脚本：编排「前端构建 → sidecar 资源组装 → 插件/引擎源码 → NSIS 安装包」。
//
// 方案：不随包 Node（安装包更小）。引擎/插件源码随包，Node 运行时由壳在
// 首次启动时解析：本机 Node ≥ 22 → 直接用；否则下载官方 zip 到应用缓存。
//  - 引擎（@cos/*）与插件（@diver/*）全是磁盘源码 —— 完全开放，可改/删/加
//  - 插件依赖安装用系统/缓存 Node 自带的 npm（install-deps）
//  - 无 SEA 烘焙、无 postject、无签名损坏
//
// 用法：
//   pnpm bundle:release                  # 完整构建（前端 + sidecar 组装 + NSIS）
//   pnpm bundle:release --assemble-only  # 只组装 sidecar 资源（不在此处跑 tauri build）
//   pnpm bundle:release --skip-frontend  # 跳过前端构建
//
// 被 `cargo tauri build` 引用（tauri.conf.json beforeBuildCommand）时，本脚本以
// `--assemble-only --skip-frontend` 运行：只负责把 sidecar 资源组装进
// src-tauri/resources/sidecar/，随后由 Tauri 编译 Rust 并打包 NSIS——
// 实现「一行命令完成全部打包流程」。
//
// 产物：
//   src-tauri/resources/sidecar/   # 打包进安装包的 sidecar 运行时目录
//   src-tauri/target/release/bundle/nsis/Diver_*_x64-setup.exe   # NSIS 安装包
//
// 依赖：pnpm ≥ 9、Node ≥ 22。

import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const HARNESS = join(ROOT, 'harness')
const COS_PLUGINS = join(ROOT, 'cos-plugins')
const SRC_TAURI = join(ROOT, 'src-tauri')
const SIDECAR_RES = join(SRC_TAURI, 'resources', 'sidecar')

// 随包分发的开放插件（源码目录名 = cos-plugins 下的包目录名）。
// native-bridge / web-tools 是其它插件的运行时库（import @diver/*），必须随包。
const OPEN_PLUGINS = [
  'companion',
  'memory',
  'self-prompt',
  'backend',
  'basic-tools',
  'mcp',
  'llm-commandcode',
  'llm-volcark',
  'native-bridge',
  'web-tools',
]

// 随包 Node 运行时来源（开发机 nvm 安装目录）。
const NODE_BIN = process.env.DIVER_NODE_BIN ?? (() => {
  const candidates = [
    process.env.NVM_SYMLINK ? join(process.env.NVM_SYMLINK, 'node.exe') : null,
    'E:/SDK/nvm/v22.20.0/node.exe',
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  // fallback: PATH 上的 node
  try {
    const out = execFileSync('where', ['node'], { encoding: 'utf8' }).split(/\r?\n/)[0]
    if (out) return out.trim()
  } catch { /* ignore */ }
  return null
})()

const args = process.argv.slice(2)
const assembleOnly = args.includes('--assemble-only')
const skipFrontend = args.includes('--skip-frontend')

function run(cmd, cwd, label) {
  console.log(`\n[${label}] ${cmd}`)
  execFileSync(cmd, { cwd, stdio: 'inherit', shell: true })
}

function step(label) {
  console.log(`\n════════ ${label} ════════`)
}

/** 真实复制（解引用符号链接）：cpSync 会保持符号链接，安装包必须自包含。 */
function copyReal(src, dst) {
  let stat
  try { stat = lstatSync(src) } catch { cpSync(src, dst, { recursive: true }); return }
  const real = stat.isSymbolicLink() ? realpathSync(src) : src
  cpSync(real, dst, { recursive: true })
}

// ── 0. 前置检查 ─────────────────────────────────────────────────────────
if (!NODE_BIN || !existsSync(NODE_BIN)) {
  console.error('[bundle] 未找到 node.exe，请设置 DIVER_NODE_BIN 或安装 Node ≥ 22')
  process.exit(1)
}
console.log(`[bundle] 构建机 Node（不随包，仅构建用）: ${NODE_BIN} (${(execFileSync(NODE_BIN, ['--version'], { encoding: 'utf8' }) ?? '').trim()})`)

// ── 1. 前端构建（Vite → dist/）──────────────────────────────────────────
if (!assembleOnly && !skipFrontend) {
  step('前端构建 (vite build)')
  run('pnpm build', ROOT, 'frontend')
}

// ── 2. 组装 sidecar 运行时目录 ──────────────────────────────────────────
step('组装 sidecar 运行时目录')
rmSync(SIDECAR_RES, { recursive: true, force: true })
mkdirSync(join(SIDECAR_RES, 'bundles', 'bundle-companion'), { recursive: true })
mkdirSync(join(SIDECAR_RES, 'plugins'), { recursive: true })

// 2.1 不随包 Node：运行时由壳探测本机 / 按需下载（见 src-tauri/src/base/node_runtime.rs）。
step('Node 运行时（不随包）')
console.log('  ✓ 安装包不包含 node.exe；首次启动由壳解析系统 Node 或下载缓存')

// 2.2 harness 引擎源码（packages + cordis.yml + 裁剪 package.json）
step('harness 引擎源码')
const harnessDst = join(SIDECAR_RES, 'harness')
mkdirSync(harnessDst, { recursive: true })
// 运行时复制过滤：排除 node_modules（依赖由 tar 提供）以及开发/测试残留
// （scripts 冒烟与 e2e、lockfile、测试文件等 —— 安装包只需 src + package.json）。
const RUNTIME_SKIP_DIRS = new Set([
  'node_modules',
  'scripts',
  '__tests__',
  'test',
  'tests',
  'fixtures',
  '.git',
  '.idea',
  '.vscode',
])
const RUNTIME_SKIP_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'npm-shrinkwrap.json',
  '.DS_Store',
  'Thumbs.db',
  '.gitignore',
  '.npmrc',
])
const notNodeModules = (p) => {
  const norm = p.replace(/[\\/]/g, '/')
  const parts = norm.split('/').filter(Boolean)
  if (parts.some((seg) => RUNTIME_SKIP_DIRS.has(seg))) return false
  const base = parts[parts.length - 1] ?? ''
  if (RUNTIME_SKIP_FILES.has(base)) return false
  if (base.endsWith('.tsbuildinfo') || base.endsWith('.log')) return false
  if (/\.test\.tsx?$/.test(base) || /\.spec\.tsx?$/.test(base)) return false
  return true
}
cpSync(join(HARNESS, 'packages'), join(harnessDst, 'packages'), {
  recursive: true,
  filter: notNodeModules,
})
copyFileSync(join(HARNESS, 'cordis.yml'), join(harnessDst, 'cordis.yml'))
copyFileSync(join(HARNESS, 'cordis.patch.yml'), join(harnessDst, 'cordis.patch.yml'))
copyFileSync(join(HARNESS, 'pnpm-lock.yaml'), join(harnessDst, 'pnpm-lock.yaml'))
copyFileSync(join(HARNESS, 'pnpm-workspace.yaml'), join(harnessDst, 'pnpm-workspace.yaml'))
// 裁剪 package.json：去 @diver/*（插件独立）、devDeps（tsx 是运行时依赖，保留）、别名
const hp = JSON.parse(readFileSync(join(HARNESS, 'package.json'), 'utf8'))
for (const k of Object.keys(hp.dependencies ?? {})) {
  if (k.startsWith('@diver/') || k === '@deepseek-ai/cordis') delete hp.dependencies[k]
}
delete hp.devDependencies
// tsx 是运行时必需（TS loader，Node 原生 strip 不支持参数属性）
hp.dependencies.tsx = '^4.23.12'
writeFileSync(join(harnessDst, 'package.json'), JSON.stringify(hp, null, 2) + '\n')

// 2.2b sidecar 根配置（cwd = sidecar，boot 从这里读 cordis.yml / secrets）
copyFileSync(join(HARNESS, 'cordis.yml'), join(SIDECAR_RES, 'cordis.yml'))
copyFileSync(join(HARNESS, 'secrets.example.yml'), join(SIDECAR_RES, 'secrets.example.yml'))

// 2.4 随包 harness 依赖：pnpm install（离线用 lockfile，生成自洽 node_modules）
step('harness 依赖安装 (pnpm install)')
if (existsSync(join(ROOT, 'node_modules', 'pnpm'))) {
  run('node "' + join(ROOT, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs') + '" install --offline', harnessDst, 'pnpm-install')
} else {
  run('pnpm install --offline', harnessDst, 'pnpm-install')
}

// 2.4b 解引用 node_modules 里的符号链接（pnpm 顶层链接 → 真实副本）。
// NSIS 打包不跟随链接，链接会丢失；解引用后全部是真实文件，可正常打包。
step('解引用 harness node_modules 链接')
function derefNodeModules(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      const target = realpathSync(full)
      let targetStat
      try { targetStat = lstatSync(target) } catch { rmSync(full, { force: true }); continue }
      if (targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        rmSync(full, { recursive: true, force: true })
        cpSync(target, full, { recursive: true })
        derefNodeModules(full)
      } else {
        rmSync(full, { force: true })
        copyFileSync(target, full)
      }
    } else if (entry.isDirectory() && entry.name !== '.bin' && entry.name !== '.ignored_typescript' && entry.name !== '.ignored') {
      // 无条件递归（pnpm 的 .pnpm 内部有任意深度嵌套链接）
      derefNodeModules(full)
    }
  }
}
if (existsSync(join(harnessDst, 'node_modules'))) {
  derefNodeModules(join(harnessDst, 'node_modules'))
  console.log('  ✓ 链接已解引用（NSIS 可打包）')
}

// 2.4c 依赖补全：pnpm 把传递依赖放在 .pnpm 嵌套里，顶层包（解引用后是真实
// 目录）import 它们时靠链接链解析；NSIS 打包后链接链断裂。必须把顶层包声明的
// 依赖从 .pnpm 提升到 harness/node_modules 顶层，保证安装后自包含可解析。
const hnmTop = join(harnessDst, 'node_modules')
const pnpmDir = join(hnmTop, '.pnpm')

/** 从 .pnpm 提升一个包到顶层（含 scoped）。返回是否成功。 */
function promotePkg(pkgName, destName) {
  // .pnpm 目录名：scoped 包 → "@scope+name@version"；unscoped → "name@version"
  const prefix = pkgName.startsWith('@')
    ? pkgName.replace('/', '+')
    : pkgName
  const matches = existsSync(pnpmDir)
    ? readdirSync(pnpmDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith(prefix + '@'))
    : []
  for (const m of matches) {
    const src = join(pnpmDir, m.name, 'node_modules', pkgName)
    const dst = join(hnmTop, destName)
    if (existsSync(src) && !existsSync(dst)) {
      cpSync(src, dst, { recursive: true })
      return true
    }
  }
  return false
}

/** 收集一个包声明的全部依赖名（dependencies + optionalDependencies）。 */
function declaredDeps(pkgDir) {
  const out = []
  const pkgPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgPath)) return out
  try {
    const j = JSON.parse(readFileSync(pkgPath, 'utf8'))
    out.push(...Object.keys(j.dependencies ?? {}), ...Object.keys(j.optionalDependencies ?? {}))
  } catch { /* ignore */ }
  return out
}

/** 判断某依赖名能否从顶层解析（顶层直接存在，或顶层包有嵌套）。 */
function resolvableFromTop(dep) {
  const [scope, name] = dep.startsWith('@') ? dep.split('/') : [null, dep]
  const top = scope ? join(hnmTop, scope, name) : join(hnmTop, name)
  return existsSync(top)
}

if (existsSync(pnpmDir)) {
  let hoisted = 0
  // 待检查队列：顶层目录（真实包）
  const topDirs = readdirSync(hnmTop, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '@esbuild')
    .map((e) => join(hnmTop, e.name))
  // @scope 下的包
  for (const scopeDir of readdirSync(hnmTop, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('@') && e.name !== '@esbuild')) {
    const scopeFull = join(hnmTop, scopeDir.name)
    for (const sub of readdirSync(scopeFull, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      topDirs.push(join(scopeFull, sub.name))
    }
  }
  // 也检查 @cos/boot 这类包内部 node_modules 里的包（如 cordis）的依赖
  const queue = [...topDirs]
  const seen = new Set()
  while (queue.length > 0) {
    const dir = queue.pop()
    if (seen.has(dir)) continue
    seen.add(dir)
    const deps = declaredDeps(dir)
    for (const dep of deps) {
      const [scope, name] = dep.startsWith('@') ? dep.split('/') : [null, dep]
      const dest = scope ? `${scope}/${name}` : name
      if (resolvableFromTop(dep)) continue
      if (promotePkg(dep, dest)) {
        hoisted++
        queue.push(join(hnmTop, dest))
      }
    }
  }
  console.log(`  ✓ 依赖补全: 提升 ${hoisted} 个传递依赖到顶层`)
}

// 2.4d 删除 .pnpm store：闭包已全部提升/解引用到顶层与各包嵌套 node_modules，
// 运行时 Node 解析从不经过 .pnpm；留着只是双倍体积与上万小文件（解压慢主因之一）。
if (existsSync(pnpmDir)) {
  rmSync(pnpmDir, { recursive: true, force: true })
  console.log('  ✓ 已删除 node_modules/.pnpm（提升后无用）')
}

// 2.5 开放插件目录：源码 + 依赖
step('开放插件目录 (plugins/)')
const pluginsDst = join(SIDECAR_RES, 'plugins')
for (const name of OPEN_PLUGINS) {
  const src = join(COS_PLUGINS, name)
  if (!existsSync(join(src, 'package.json'))) {
    console.error(`[bundle] 插件 ${name} 缺少 package.json: ${src}`)
    process.exit(1)
  }
  cpSync(src, join(pluginsDst, name), { recursive: true, filter: notNodeModules })
  console.log(`  ✓ ${name}`)
}

// 插件依赖闭包：按各插件 package.json 递归收集，保证 NSIS 安装后可解析。
//  - @cos/*     → harness/packages 源码（含 plugin-api）
//  - @diver/*   → cos-plugins 同目录源码（native-bridge / web-tools 等库）
//  - npm 包     → 从 harness / 根 / 插件本地 node_modules 真实复制 + BFS 传递依赖
step('插件依赖')
const pluginsNm = join(pluginsDst, 'node_modules')
mkdirSync(join(pluginsNm, '@cos'), { recursive: true })
mkdirSync(join(pluginsNm, '@diver'), { recursive: true })
const harnessNm = join(harnessDst, 'node_modules')

/** 从多个候选根解析 npm 包目录。 */
function findPkgRoot(pkgName, extraRoots = []) {
  const roots = [join(ROOT, 'node_modules'), harnessNm, ...extraRoots]
  for (const r of roots) {
    const p = join(r, ...pkgName.split('/'))
    if (existsSync(join(p, 'package.json'))) return p
  }
  return null
}

/** 把 @cos/<name> 源码复制进 plugins/node_modules（无 type-strip 限制）。 */
function copyCosPackage(name) {
  const src = join(harnessDst, 'packages', name)
  const dst = join(pluginsNm, '@cos', name)
  if (!existsSync(join(src, 'package.json')) || existsSync(dst)) return false
  cpSync(src, dst, { recursive: true, filter: notNodeModules })
  console.log(`  ✓ @cos/${name} (copied)`)
  return true
}

/** 把 @diver/<name> 源码复制进 plugins/node_modules（保持开放可改）。 */
function copyDiverPackage(name, extraRoots = []) {
  const src = join(COS_PLUGINS, name)
  const dst = join(pluginsNm, '@diver', name)
  if (!existsSync(join(src, 'package.json')) || existsSync(dst)) return false
  cpSync(src, dst, { recursive: true, filter: notNodeModules })
  console.log(`  ✓ @diver/${name} (copied)`)
  // 源码包自身依赖也入队展开
  expandDeclaredDeps(src, extraRoots)
  return true
}

/** 读取 package.json 的 dependencies + optionalDependencies 名。 */
function declaredDepNames(pkgDir) {
  const pkgPath = join(pkgDir, 'package.json')
  if (!existsSync(pkgPath)) return []
  try {
    const j = JSON.parse(readFileSync(pkgPath, 'utf8'))
    return [
      ...Object.keys(j.dependencies ?? {}),
      ...Object.keys(j.optionalDependencies ?? {}),
    ]
  } catch {
    return []
  }
}

/** 扫源码裸 import（package.json 可能漏声明，如 plugin-api → schemastery）。 */
function sourceImportNames(pkgDir) {
  const out = new Set()
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!/\.(ts|tsx|mts|js|mjs|cjs)$/.test(e.name)) continue
      let text
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1]
        if (!spec || spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('file:')) continue
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        out.add(name)
      }
    }
  }
  walk(join(pkgDir, 'src'), 0)
  walk(pkgDir, 0)
  return [...out]
}

/** 按声明 + 源码 import 把一个包的依赖落入 plugins/node_modules（npm 包 BFS）。 */
function expandDeclaredDeps(pkgDir, extraRoots = []) {
  const names = [...new Set([...declaredDepNames(pkgDir), ...sourceImportNames(pkgDir)])]
  for (const d of names) {
    if (!d || d.startsWith('node:')) continue
    if (d.startsWith('@cos/')) {
      copyCosPackage(d.slice('@cos/'.length))
      continue
    }
    if (d.startsWith('@diver/')) {
      copyDiverPackage(d.slice('@diver/'.length), extraRoots)
      continue
    }
    // file: 相对路径 → 映射到 @cos / @diver 源码
    // （package.json 里是 "file:../../harness/packages/plugin-api" 等）
    const [scope, name] = d.startsWith('@') ? d.split('/') : [null, d]
    const destRel = scope ? join(scope, name) : name
    const dst = join(pluginsNm, ...destRel.split('/'))
    if (existsSync(dst)) continue
    const src = findPkgRoot(d, extraRoots)
    if (!src) {
      console.warn(`  (跳过: 未找到依赖 ${d})`)
      continue
    }
    if (scope) mkdirSync(join(pluginsNm, scope), { recursive: true })
    copyReal(src, dst)
    console.log(`  ✓ ${d}`)
    expandDeclaredDeps(dst, extraRoots)
  }
}

// plugin-api `export { z } from '@deepseek-ai/schemastery'`（源码 import，依赖未声明）
for (const pkg of ['@deepseek-ai/schemastery']) {
  const src = findPkgRoot(pkg)
  const dst = join(pluginsNm, ...pkg.split('/'))
  if (src && !existsSync(dst)) {
    mkdirSync(join(pluginsNm, '@deepseek-ai'), { recursive: true })
    copyReal(src, dst)
    console.log(`  ✓ ${pkg}`)
    expandDeclaredDeps(dst)
  }
}

// 核心 @cos/* 全量拷贝（除 sidecar 入口与 dsh/ 兼容层目录）：plugin-api 会链式引用
// subagents / agent-loop 等，手列必漏。dsh 兼容层按 `@deepseek-ai/dsh-*` 落盘。
{
  const allCos = readdirSync(join(harnessDst, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'sidecar' && e.name !== 'dsh')
    .map((e) => e.name)
  for (const pkg of allCos) {
    copyCosPackage(pkg)
  }
  // packages/dsh/<short> → node_modules/@deepseek-ai/dsh-<short>
  const dshRoot = join(harnessDst, 'packages', 'dsh')
  if (existsSync(dshRoot)) {
    for (const e of readdirSync(dshRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const pkgName = `dsh-${e.name}`
      const src = join(dshRoot, e.name)
      const dst = join(pluginsNm, '@deepseek-ai', pkgName)
      if (!existsSync(join(src, 'package.json')) || existsSync(dst)) continue
      mkdirSync(join(pluginsNm, '@deepseek-ai'), { recursive: true })
      cpSync(src, dst, { recursive: true, filter: notNodeModules })
      console.log(`  ✓ @deepseek-ai/${pkgName} (copied)`)
      expandDeclaredDeps(dst)
    }
  }
  for (const pkg of allCos) {
    expandDeclaredDeps(join(harnessDst, 'packages', pkg))
  }
}

// 每个已分发插件：按 package.json + 源码 import 展开依赖
for (const name of OPEN_PLUGINS) {
  const pluginDir = join(pluginsDst, name)
  const extra = [join(COS_PLUGINS, name, 'node_modules')]
  expandDeclaredDeps(pluginDir, extra)
}
// plugin-api / 其它已拷贝的 @cos 包自身的 workspace 依赖也要闭合
for (const pkg of ['plugin-api', 'subagents', 'agent-loop', 'llm', 'tools', 'credentials']) {
  expandDeclaredDeps(join(pluginsNm, '@cos', pkg))
}

// 显式兜底：plugin-api 的 `export { z } from '@deepseek-ai/schemastery'`
// （源码 import，此前 package.json 未声明导致闭包漏拷）
for (const extra of ['@deepseek-ai/schemastery']) {
  const [scope, name] = extra.split('/')
  const dst = join(pluginsNm, scope, name)
  if (existsSync(dst)) continue
  const src = findPkgRoot(extra)
  if (!src) {
    console.warn(`  (跳过: 未找到 ${extra})`)
    continue
  }
  mkdirSync(join(pluginsNm, scope), { recursive: true })
  copyReal(src, dst)
  console.log(`  ✓ ${extra} (source-import fallback)`)
  expandDeclaredDeps(dst)
}

// cordis 传递依赖兜底（cosmokit / @standard-schema）
for (const pkg of ['cosmokit', '@standard-schema/spec', 'cordis', 'yaml', 'zod']) {
  const [scope, name] = pkg.includes('/') ? pkg.split('/') : [null, pkg]
  const dst = scope ? join(pluginsNm, scope, name) : join(pluginsNm, name)
  if (existsSync(dst)) continue
  const src = findPkgRoot(pkg)
  if (!src) continue
  if (scope) mkdirSync(join(pluginsNm, scope), { recursive: true })
  copyReal(src, dst)
  console.log(`  ✓ ${pkg}`)
  expandDeclaredDeps(dst)
}

// 2.6 companion bundle 层（patch 配置）
const bundleSrc = join(COS_PLUGINS, 'bundle-companion')
const bundleDst = join(SIDECAR_RES, 'bundles', 'bundle-companion')
for (const f of ['cordis.patch.yml', 'bundle.yml', 'package.json']) {
  copyFileSync(join(bundleSrc, f), join(bundleDst, f))
}

// 2.7 前端 UI 由 Tauri frontendDist 托管（打进安装包，tauri://localhost/），
// 不再放入 sidecar 资源 —— UI 与 sidecar 端口完全解耦。
// （保留 sidecar 的 dist 占位目录说明：backend 的 serveStatic 兼容保留，
//   实际不再被窗口加载。）

// 2.8 一键依赖安装脚本 + doctor + 解压脚本
step('辅助脚本')
copyFileSync(join(ROOT, 'scripts', 'install-deps.mjs'), join(SIDECAR_RES, 'install-deps.mjs'))
copyFileSync(join(ROOT, 'scripts', 'plugin-doctor.mjs'), join(SIDECAR_RES, 'plugin-doctor.mjs'))

// 2.8b 归档 node_modules：把海量小文件打成 tar.zst（NSIS 只复制几个大文件，
// 安装极快）；首次启动 sidecar 前由壳 setup_progress 并行解压（Rust 单链路）。
// 插件/引擎源码保持开放（不归档），只归档只读依赖。
// 注意：闭包自检必须在 tar 之前（tar 会删掉 node_modules）。
step('依赖闭包自检')
{
  const check = join(ROOT, 'scripts', 'check-plugin-closure.mjs')
  if (existsSync(check)) {
    run(`node "${check}"`, ROOT, 'closure-check')
  }
}

step('归档 node_modules（加速安装）')
const tarArchives = [
  { src: join(SIDECAR_RES, 'harness', 'node_modules'), out: join(SIDECAR_RES, 'harness', 'node_modules.tar'), label: 'harness' },
  { src: join(SIDECAR_RES, 'plugins', 'node_modules'), out: join(SIDECAR_RES, 'plugins', 'node_modules.tar'), label: 'plugins' },
]
for (const { src, out, label } of tarArchives) {
  if (!existsSync(src)) {
    console.warn(`  (跳过: ${label} node_modules 不存在 ${src})`)
    continue
  }
  // zstd 归档：Windows 自带 bsdtar 内嵌 libzstd（--zstd 无需 zstd.exe），体积约
  // 1/3 且解压吞吐高；极老 tar 不支持 --zstd 时回退未压缩 tar。
  // 相对路径（-C 切目录）保证归档内路径无前缀。
  let outPath = out.replace(/\.tar$/, '.tar.zst')
  try {
    execFileSync('tar', ['--zstd', '-cf', outPath, '-C', src, '.'], { stdio: 'inherit' })
  } catch {
    outPath = out
    execFileSync('tar', ['-cf', outPath, '-C', src, '.'], { stdio: 'inherit' })
  }
  rmSync(src, { recursive: true, force: true })
  const size = (existsSync(outPath) ? (lstatSync(outPath).size / 1024 / 1024) : 0)
  console.log(`  ✓ ${label} node_modules → ${outPath.replace(/^.*[\\/]/, '')} (${size.toFixed(1)} MB)`)
}

// 2.8c 清理 pnpm install 在 packages 里生成的残留 node_modules 空壳
// （pnpm workspace 为每个包建 node_modules 链接；解引用+归档后只剩空目录，
//  tauri build 打包 resources 会因残缺文件报错，必须清掉。）
step('清理残留 node_modules 空壳')
let cleaned = 0
function rmNodeModulesDirs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory() && entry.name === 'node_modules') {
      rmSync(full, { recursive: true, force: true })
      cleaned++
    } else if (entry.isDirectory()) {
      rmNodeModulesDirs(full)
    }
  }
}
for (const root of [join(SIDECAR_RES, 'harness', 'packages'), join(SIDECAR_RES, 'plugins')]) {
  if (existsSync(root)) rmNodeModulesDirs(root)
}
console.log(`  ✓ 清理 ${cleaned} 个残留 node_modules`)

// 2.9 说明文件
writeFileSync(
  join(SIDECAR_RES, 'README.txt'),
  [
    'Diver sidecar 运行时目录（自动生成）。',
    'Node 运行时不随包：应用首次启动会使用本机 Node ≥ 22，或自动下载到应用缓存。',
    'harness/ 为引擎源码（@cos/*），plugins/ 为第三方插件源码（@diver/*）—— 全部开放。',
    '',
    '【插件开放】plugins/ 下的插件以 TS 源码分发：',
    '  - 修改：改 plugins/<name>/src/*.ts，重启应用生效',
    '  - 删除：删 plugins/<name>/ + bundles/bundle-companion/cordis.patch.yml 对应行',
    '  - 新增：放 plugins/<name>/（package.json main → src/index.ts，相对导入带 .ts）',
    '            + cordis.patch.yml 加一行（- id: <name> / name: "@diver/<name>"）',
    '  - 装依赖：node install-deps.mjs （为 plugins/ 下所有插件安装 package.json 声明的依赖）',
    '  - 诊断：  node plugin-doctor.mjs （检查插件目录与 patch 行是否匹配、依赖是否齐全）',
    '',
    '用户数据（会话/记忆/工作区）保存在 %APPDATA%\\com.diver.companion\\cos。',
  ].join('\n'),
  'utf8',
)

// 打印产物清单
console.log('\n[sidecar] 运行时目录：')
function listFiles(dir, prefix = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.pnpm') continue
    const rel = join(prefix, entry.name)
    if (entry.isDirectory()) listFiles(join(dir, entry.name), rel)
    else console.log(`  ${rel}`)
  }
}
listFiles(SIDECAR_RES)

// ── 3. NSIS 安装包构建 ───────────────────────────────────────────────────
if (assembleOnly) {
  // 被 beforeBuildCommand 引用时：tauri build 由 Tauri 本体执行（本脚本只是
  // beforeBuildCommand 的前置步骤），此处退出，不再重复调用 `pnpm tauri build`。
  console.log('\n[assemble-only] sidecar 资源组装完成（tauri build 由调用方/`cargo tauri build` 执行）')
} else {
  step('NSIS 安装包构建 (tauri build)')
  run('pnpm tauri build', ROOT, 'tauri-build')
  console.log('\n[bundle] 完成。安装包位于 src-tauri/target/release/bundle/nsis/')
}
