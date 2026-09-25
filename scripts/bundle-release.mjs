// Diver release 打包脚本：编排「前端构建 → sidecar 资源组装 → 插件/引擎源码 → NSIS 安装包」。
//
// 方案：不随包 Node（安装包更小）。引擎/插件源码随包，Node 运行时由壳在
// 首次启动时解析：本机 Node ≥ 22 → 直接用；否则下载官方 zip 到应用缓存。
//  - 引擎（@cos/*）与插件（@diver/*）全是磁盘源码 —— 完全开放，可改/删/加
//  - 第三方依赖闭包 vendor 化进 sidecar/node_modules（少数大文件；不随包 node_modules 树）
//  - 插件新增依赖用系统/缓存 Node 自带的 npm（install-deps → plugins/node_modules 优先）
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
//   target/release/bundle/nsis/Diver_*_x64-setup.exe   # NSIS 安装包（Cargo workspace 在仓库根）
//
// 依赖：pnpm ≥ 9、Node ≥ 22。

import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSeedManifest, ignoredName } from './lib/seed-manifest.mjs'

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
  'llm-custom',
  'native-bridge',
  'web-tools',
]
// 进程入口插件（paths.rs RELEASE_ENTRY 指向 plugins/companion/…）：留在安装
// 目录作 entry，不进种子（用户工作区不承载进程入口）。
const ENTRY_PLUGIN = 'companion'
const SEED_PLUGINS = OPEN_PLUGINS.filter((n) => n !== ENTRY_PLUGIN)

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
// 运行时复制过滤：排除 node_modules（第三方闭包由 node_modules/ vendor 根提供）以及开发/测试残留
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
// 2.2b sidecar 根配置（cwd = sidecar，boot 从这里读 cordis.yml / secrets）
copyFileSync(join(HARNESS, 'cordis.yml'), join(SIDECAR_RES, 'cordis.yml'))
copyFileSync(join(HARNESS, 'secrets.example.yml'), join(SIDECAR_RES, 'secrets.example.yml'))

// 2.4 随包 harness 依赖：pnpm install（离线用 lockfile，生成自洽 node_modules）。
// 必须用**原版** package.json + lockfile 冻结安装：裁剪过的 manifest 与 lockfile
// 必然失配（CI 默认 frozen 直接拒绝；关闭 frozen 又会离线重算、解析版本漂移，
// 且 @esbuild 平台二进制（optionalDependencies）被静默丢弃 → tsx 转译失败、
// 助手启动失败）。装完再把裁剪版覆盖为随包元数据。
step('harness 依赖安装 (pnpm install)')
copyFileSync(join(HARNESS, 'package.json'), join(harnessDst, 'package.json'))
if (existsSync(join(ROOT, 'node_modules', 'pnpm'))) {
  run('node "' + join(ROOT, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs') + '" install --offline --frozen-lockfile', harnessDst, 'pnpm-install')
} else {
  run('pnpm install --offline --frozen-lockfile', harnessDst, 'pnpm-install')
}
// 2.4b 安装后门禁：CI 上 pnpm 曾静默丢 registry/dev/optional 依赖，直到用户
// 启动失败才暴露。这里把安装现场（manifest 依赖数、环境变量、关键探针）钉进
// 日志并立即失败，坏产物不再出厂。
{
  const nm = join(harnessDst, 'node_modules')
  const depCount = Object.keys(JSON.parse(readFileSync(join(harnessDst, 'package.json'), 'utf8')).dependencies ?? {}).length
  console.log(`  [诊断] package.json 依赖 ${depCount} 项`)
  const envBits = Object.keys(process.env)
    .filter((k) => /^(npm_config_.*|NODE_ENV)$/i.test(k))
    .sort()
    .map((k) => `${k}=${process.env[k]}`)
  console.log(`  [诊断] env ${envBits.length ? envBits.join(' ') : '(干净: 无 npm_config_*/NODE_ENV)'}`)
  const platBin = `@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`
  const probes = ['tsx/dist/loader.mjs', 'esbuild/package.json', '@cordisjs/plugin-loader/package.json', 'typescript/package.json', 'postject/package.json', platBin]
  const missing = probes.filter((p) => !existsSync(join(nm, p)))
  for (const p of probes) console.log(`  [诊断] ${missing.includes(p) ? '✗' : '✓'} node_modules/${p}`)
  // 门禁只卡运行时硬依赖（tsx/esbuild/@cordisjs）；typescript/postject 是 devDeps
  // 仅作现场证据；平台二进制由 build-core-bundle 兜底复制 + 硬校验负责。
  const fatal = missing.filter((p) => !['typescript/package.json', 'postject/package.json', platBin].includes(p))
  if (fatal.length) {
    console.error(`  ✗ harness 依赖安装不完整: ${fatal.join(', ')}（见上方诊断；终止打包）`)
    process.exit(1)
  }
}
// 裁剪 package.json（随包元数据）：去 @diver/*（插件独立）、devDeps（tsx 是运行时依赖，保留）、别名
const hp = JSON.parse(readFileSync(join(HARNESS, 'package.json'), 'utf8'))
for (const k of Object.keys(hp.dependencies ?? {})) {
  if (k.startsWith('@diver/') || k === '@deepseek-ai/cordis') delete hp.dependencies[k]
}
delete hp.devDependencies
// tsx 是运行时必需（TS loader，Node 原生 strip 不支持参数属性）
hp.dependencies.tsx = '^4.23.12'
writeFileSync(join(harnessDst, 'package.json'), JSON.stringify(hp, null, 2) + '\n')

// 2.4b 依赖 vendor 化：第三方闭包打进 sidecar/node_modules 少数大文件，
// @cos/@diver 映射回源码，tsx/esbuild/typescript 白名单物理保留。
// （解引用/提升/.pnpm 清理等 node_modules 搬运逻辑全部退役：不再随包 node_modules。）





// 2.5 出厂种子镜像：plugins.seed/ 明文镜像 + seed-manifest.json（逐文件 hash）。
// 运行时唯一插件区 = 用户工作区 %APPDATA%\...\cos\plugins（B′ 播种对账：
// boot 按 seedVersion 标记播种/升级，未改静默更新、改过保留 + .incoming 并存）。
// 安装目录不再展开运行时插件目录——plugins.seed/ 只作播种源，运行时不加载。
step('进程入口 (plugins/companion/) + 出厂种子镜像 (plugins.seed/)')
// 入口插件 companion：node 启动的 entry（paths.rs RELEASE_ENTRY），不播种。
rmSync(join(SIDECAR_RES, 'plugins'), { recursive: true, force: true })
cpSync(join(COS_PLUGINS, ENTRY_PLUGIN), join(SIDECAR_RES, 'plugins', ENTRY_PLUGIN), {
  recursive: true,
  filter: (p) => !ignoredName(basename(p)),
})
console.log(`  ✓ ${ENTRY_PLUGIN}（进程入口）`)
// 种子镜像：运行时唯一插件区 = 用户工作区 %APPDATA%\...\cos\plugins（B′ 播种
// 对账：boot 按 seedVersion 标记播种/升级，未改静默更新、改过保留 + .incoming
// 并存）。plugins.seed/ 只作播种源，运行时不加载。
const seedDst = join(SIDECAR_RES, 'plugins.seed')
rmSync(seedDst, { recursive: true, force: true })
const seedPluginNames = []
for (const name of SEED_PLUGINS) {
  const src = join(COS_PLUGINS, name)
  if (!existsSync(join(src, 'package.json'))) {
    console.error(`[bundle] 插件 ${name} 缺少 package.json: ${src}`)
    process.exit(1)
  }
  cpSync(src, join(seedDst, name), {
    recursive: true,
    filter: (p) => !ignoredName(basename(p)),
  })
  seedPluginNames.push(name)
  console.log(`  ✓ ${name}`)
}
const seedManifest = buildSeedManifest(seedDst, seedPluginNames)
writeFileSync(join(seedDst, 'seed-manifest.json'), `${JSON.stringify(seedManifest, null, 2)}\n`)
console.log(`  ✓ seed-manifest.json（seedVersion=${seedManifest.seedVersion}）`)





// 2.6 companion bundle 层（patch 配置）
const bundleSrc = join(COS_PLUGINS, 'bundle-companion')
const bundleDst = join(SIDECAR_RES, 'bundles', 'bundle-companion')
for (const f of ['cordis.patch.yml', 'bundle.yml', 'package.json', 'plugins.json']) {
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

// 2.8b 依赖 vendor 化：第三方闭包 → sidecar/node_modules 少数大文件；
// @cos/@diver 映射回源码（引擎/插件明文可读写），tsx/esbuild/typescript 白名单物理保留。
// harness/node_modules（pnpm install 产物）只作构建期解析源。
step('依赖 vendor 化 (build-core-bundle)')
run(`node "${join(ROOT, 'scripts', 'build-core-bundle.mjs')}" --sidecar "${SIDECAR_RES}"`, ROOT, 'core-bundle')

step('移除 harness 依赖树（已 vendor 化）')
{
  const workNm = join(SIDECAR_RES, 'harness', 'node_modules')
  if (existsSync(workNm)) {
    rmSync(workNm, { recursive: true, force: true })
    console.log('  ✓ harness/node_modules 已移除（闭包在 sidecar/node_modules）')
  }
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

// 2.8d 依赖闭包自检：在**最终产物**上按 Node 解析校验随包源码的全部裸导入
//（必须在空壳清理之后——清理即打包不变量的一部分）。
step('依赖闭包自检')
{
  const check = join(ROOT, 'scripts', 'check-plugin-closure.mjs')
  if (existsSync(check)) {
    run(`node "${check}"`, ROOT, 'closure-check')
  }
}

// 2.9 说明文件
writeFileSync(
  join(SIDECAR_RES, 'README.txt'),
  [
    'Diver sidecar 运行时目录（自动生成）。',
    'Node 运行时不随包：应用首次启动会使用本机 Node ≥ 22，或自动下载到应用缓存。',
    'harness/ 为引擎源码（@cos/*）；plugins/companion/ 为进程入口；plugins.seed/ 为出厂插件镜像（@diver/* 明文 TS，只作播种源）。',
    'node_modules/ 为构建期固化的第三方依赖（vendor 大文件 + @cos/@diver 源码映射 + tsx/esbuild 白名单）。',
    '',
    '【插件工作区】运行时唯一插件区 = %APPDATA%\\com.diver.companion\\cos\\plugins（首启自动播种，改 src/*.ts 重启生效）：',
    '  - 修改：改 cos\\plugins\\<name>\\src/*.ts，重启应用生效',
    '  - 删除：删 cos\\plugins\\<name>\\ + bundles/bundle-companion/cordis.patch.yml 对应行',
    '  - 新增：放 cos\\plugins\\<name>/（package.json main → src/index.ts，相对导入带 .ts）',
    '            + cordis.patch.yml 加一行（- id: <name> / name: "@diver/<name>"）',
    '  - 升级对账：你没改过的插件随新版静默更新；改过的保留你的版本，',
    '            官方新版放 cos\\plugins\\.incoming\\<版本>\\<name>，自行合并',
    '  - 装依赖：node install-deps.mjs （为 cos\\plugins 下所有插件安装 package.json 声明的依赖，',
    '            落 cos\\plugins\\node_modules，优先于内置依赖；引擎与 @diver 库无需安装）',
    '  - 诊断：  node plugin-doctor.mjs （检查插件目录与 patch 行是否匹配、依赖与改动状态、.incoming 提示）',
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
  console.log('\n[bundle] 完成。安装包位于 target/release/bundle/nsis/')
}
