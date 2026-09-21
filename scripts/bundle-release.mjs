// Diver release 打包脚本：编排「前端构建 → 随包 Node 运行时组装 → 插件/引擎源码 → NSIS 安装包」。
//
// 方案：随包 node.exe + npm + harness 引擎源码 + cos-plugins 插件源码。
//  - 用户机器无需预装 Node（node.exe 随包）
//  - 引擎（@cos/*）与插件（@diver/*）全是磁盘源码 —— 完全开放，可改/删/加
//  - 随包 npm 支持一键安装插件依赖（install-deps）
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
const OPEN_PLUGINS = ['memory', 'voice', 'backend', 'basic-tools', 'mcp', 'llm-commandcode']

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
console.log(`[bundle] 随包 Node: ${NODE_BIN} (${(execFileSync(NODE_BIN, ['--version'], { encoding: 'utf8' }) ?? '').trim()})`)

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

// 2.1 随包 Node 运行时：node.exe + npm
step('随包 Node 运行时')
copyFileSync(NODE_BIN, join(SIDECAR_RES, 'node.exe'))
const npmSrc = join(dirname(NODE_BIN), 'node_modules', 'npm')
if (existsSync(npmSrc)) {
  mkdirSync(join(SIDECAR_RES, 'node_modules'), { recursive: true })
  copyReal(npmSrc, join(SIDECAR_RES, 'node_modules', 'npm'))
  console.log('  ✓ node.exe + npm')
} else {
  console.warn(`  (跳过: npm 未找到 ${npmSrc}，插件依赖安装不可用)`)
}

// 2.2 harness 引擎源码（packages + cordis.yml + 裁剪 package.json）
step('harness 引擎源码')
const harnessDst = join(SIDECAR_RES, 'harness')
mkdirSync(harnessDst, { recursive: true })
// 排除所有层级的 node_modules（pnpm workspace 包内也有 node_modules，
// 复制链接会残留残缺文件；依赖统一由随包 node_modules.tar 提供）。
const notNodeModules = (p) => {
  const norm = p.replace(/[\\/]/g, '/')
  return !norm.split('/').includes('node_modules')
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

// 插件依赖：@cos/* 链接到 harness packages（磁盘源码，无 type-strip 限制）
//  + cordis/yaml 等从 harness node_modules 链接
step('插件依赖')
const pluginsNm = join(pluginsDst, 'node_modules')
mkdirSync(join(pluginsNm, '@cos'), { recursive: true })
const harnessNm = join(harnessDst, 'node_modules')
// @cos/* 核心包（插件 import 的）：真实复制 harness/packages 源码。
// （不能用 junction/symlink —— NSIS 打包会丢链接；源码 TS 不在 node_modules
// 语义下，无 type-strip 限制。）
for (const pkg of ['llm', 'tools', 'types', 'credentials', 'boot']) {
  const src = join(harnessDst, 'packages', pkg)
  const dst = join(pluginsNm, '@cos', pkg)
  if (existsSync(src) && !existsSync(dst)) {
    cpSync(src, dst, { recursive: true, filter: notNodeModules })
    console.log(`  ✓ @cos/${pkg} (copied)`)
  }
}
// cordis / yaml（插件依赖）：真实复制（解引用），并补齐其传递依赖
const extDeps = ['cordis', 'yaml']
for (const name of extDeps) {
  const src = join(harnessNm, name)
  const dst = join(pluginsNm, name)
  if (existsSync(src) && !existsSync(dst)) {
    copyReal(src, dst)
    console.log(`  ✓ ${name}`)
  }
}
// zod：mcp 插件的 SDK 依赖（harness 不直接依赖，从根 node_modules 复制）
const zodSrc = join(ROOT, 'node_modules', 'zod')
if (existsSync(zodSrc) && !existsSync(join(pluginsNm, 'zod'))) {
  copyReal(zodSrc, join(pluginsNm, 'zod'))
  console.log('  ✓ zod')
}
// 插件依赖补全：复制 cordis 后补齐其传递依赖（cosmokit、@standard-schema 等）
for (const pkg of ['cosmokit', '@standard-schema/spec']) {
  const srcPkg = pkg.includes('/') ? pkg.split('/') : [null, pkg]
  const scope = srcPkg[0]
  const name = srcPkg[1]
  // 从 harness 顶层（已提升）复制
  const srcTop = scope ? join(harnessNm, scope, name) : join(harnessNm, name)
  const dstTop = scope ? join(pluginsNm, scope, name) : join(pluginsNm, name)
  if (existsSync(srcTop) && !existsSync(dstTop)) {
    if (scope) mkdirSync(join(pluginsNm, scope), { recursive: true })
    copyReal(srcTop, dstTop)
    console.log(`  ✓ ${pkg} (cordis 依赖)`)
  }
}
// @modelcontextprotocol/sdk + 其依赖（mcp 插件用）
// SDK 直接声明了 express / hono / ajv / cors / eventsource / zod-to-json-schema
// 等一整套 server transport 依赖，且这些包各自还有深层传递依赖（express → 
// accepts/body-parser/qs/router…；ajv → fast-uri/json-schema-traverse/…）。
// 只复制一层会导致插件加载时 `Cannot find module` 崩溃（如 ajv 缺
// json-schema-traverse）。这里做递归 BFS：复制一个包后把它声明的依赖也入队，
// 直到闭包完整，全部从根 node_modules 真实复制。
const sdkSrc = join(COS_PLUGINS, 'mcp', 'node_modules', '@modelcontextprotocol', 'sdk')
if (existsSync(sdkSrc) && !existsSync(join(pluginsNm, '@modelcontextprotocol', 'sdk'))) {
  mkdirSync(join(pluginsNm, '@modelcontextprotocol'), { recursive: true })
  copyReal(sdkSrc, join(pluginsNm, '@modelcontextprotocol', 'sdk'))
  console.log('  ✓ @modelcontextprotocol/sdk')

  // BFS 队列：初始为 SDK 自身（其依赖会展开）；复制到 plugins/node_modules 的
  // 每个包都入队继续展开，直到没有新依赖。
  const queue = [join(pluginsNm, '@modelcontextprotocol', 'sdk')]
  const seen = new Set([join(pluginsNm, '@modelcontextprotocol', 'sdk')])
  let copied = 0
  while (queue.length > 0) {
    const pkgDir = queue.shift()
    const pkgPath = join(pkgDir, 'package.json')
    if (!existsSync(pkgPath)) continue
    let declared = []
    try {
      const j = JSON.parse(readFileSync(pkgPath, 'utf8'))
      declared.push(
        ...Object.keys(j.dependencies ?? {}),
        ...Object.keys(j.optionalDependencies ?? {}),
      )
    } catch { /* ignore */ }
    for (const d of declared) {
      const [scope, name] = d.startsWith('@') ? d.split('/') : [null, d]
      const src = scope ? join(ROOT, 'node_modules', scope, name) : join(ROOT, 'node_modules', d)
      const dst = scope ? join(pluginsNm, scope, name) : join(pluginsNm, d)
      if (!existsSync(src) || existsSync(dst)) continue
      if (scope) mkdirSync(join(pluginsNm, scope), { recursive: true })
      copyReal(src, dst)
      copied++
      queue.push(dst)
      seen.add(dst)
    }
  }
  console.log(`  ✓ SDK 依赖闭包 (${copied} 个传递依赖)`)
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
copyFileSync(join(ROOT, 'scripts', 'extract-deps.mjs'), join(SIDECAR_RES, 'extract-deps.mjs'))

// 2.8b 归档 node_modules：把海量小文件打成 tar（NSIS 只复制几个大文件，
// 安装极快）；首次启动 sidecar 前由 extract-deps.mjs 解压一次。
// 插件/引擎源码保持开放（不归档），只归档只读依赖。
step('归档 node_modules（加速安装）')
const tarArchives = [
  { src: join(SIDECAR_RES, 'node_modules'), out: join(SIDECAR_RES, 'node_modules.tar'), label: 'npm' },
  { src: join(SIDECAR_RES, 'harness', 'node_modules'), out: join(SIDECAR_RES, 'harness', 'node_modules.tar'), label: 'harness' },
  { src: join(SIDECAR_RES, 'plugins', 'node_modules'), out: join(SIDECAR_RES, 'plugins', 'node_modules.tar'), label: 'plugins' },
]
for (const { src, out, label } of tarArchives) {
  if (!existsSync(src)) {
    console.warn(`  (跳过: ${label} node_modules 不存在 ${src})`)
    continue
  }
  // tar 归档：Windows 自带 tar.exe；用相对路径（-C 切目录）保证归档内路径无前缀
  execFileSync('tar', ['-cf', out, '-C', src, '.'], { stdio: 'inherit' })
  rmSync(src, { recursive: true, force: true })
  const size = (existsSync(out) ? (lstatSync(out).size / 1024 / 1024) : 0)
  console.log(`  ✓ ${label} node_modules → ${label}.tar (${size.toFixed(1)} MB)`)
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
    'node.exe + node_modules/npm 为随包 Node 运行时（用户机器无需安装 Node）。',
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
