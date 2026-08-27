// Diver 插件依赖一键安装脚本（随包使用，无需用户机器安装 Node/npm）。
//
// 用法（在 sidecar 运行时目录下）：
//   node install-deps.mjs              # 为 plugins/ 下所有插件安装依赖
//   node install-deps.mjs --plugin <name>   # 只装指定插件
//   node install-deps.mjs --all        # 等价默认（全部）
//
// 原理：用随包 node + 随包 npm，为每个插件的 package.json 声明的依赖执行
// `npm install`（安装到插件目录自己的 node_modules）。插件依赖集中在
// plugins/node_modules 的则跳过（预置）。
//
// 依赖解析说明：
//   - 插件声明了依赖，但 plugins/node_modules 里已有 → 跳过（预置）
//   - 插件声明了新依赖（用户新增插件引入）→ 在 plugins/node_modules 安装
//   - @cos/* 引擎核心由 harness 提供，不需要安装

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = resolve(import.meta.dirname ?? '.')
const PLUGINS = join(HERE, 'plugins')
const PLUGINS_NM = join(PLUGINS, 'node_modules')
const NODE = join(HERE, 'node.exe')
const NPM_CLI = join(HERE, 'node_modules', 'npm', 'bin', 'npm-cli.js')

const args = process.argv.slice(2)
const only = args.includes('--plugin') ? args[args.indexOf('--plugin') + 1] : null

function log(...m) { console.log('[install-deps]', ...m) }

if (!existsSync(NODE)) {
  console.error('[install-deps] 未找到随包 node.exe（应在 sidecar 运行时目录运行）')
  process.exit(1)
}
if (!existsSync(NPM_CLI)) {
  console.error('[install-deps] 未找到随包 npm（node_modules/npm/bin/npm-cli.js），无法安装依赖')
  process.exit(1)
}
if (!existsSync(PLUGINS)) {
  console.error('[install-deps] 未找到 plugins/ 目录')
  process.exit(1)
}

// 收集要处理的插件
const dirs = only
  ? [only]
  : readdirSync(PLUGINS, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules')
      .map((e) => e.name)

let installed = 0
let skipped = 0
for (const name of dirs) {
  const pkgPath = join(PLUGINS, name, 'package.json')
  if (!existsSync(pkgPath)) {
    log(`跳过 ${name}（无 package.json）`)
    continue
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const deps = pkg.dependencies ?? {}
  const extDeps = Object.keys(deps).filter((d) => !d.startsWith('@cos/'))
  if (extDeps.length === 0) {
    log(`跳过 ${name}（无外部依赖）`)
    skipped++
    continue
  }
  // 已存在于 plugins/node_modules 的跳过
  const missing = extDeps.filter((d) => !existsSync(join(PLUGINS_NM, d)))
  if (missing.length === 0) {
    log(`跳过 ${name}（依赖已齐全）`)
    skipped++
    continue
  }
  log(`安装 ${name} 的依赖: ${missing.join(', ')}`)
  try {
    // 用一个临时目录让 npm 安装，再把产物合并进 plugins/node_modules ——
    // 避免 npm 在共享目录里"整理"（删除手工预置的 @cos/cordis/SDK 等）。
    const tmp = join(PLUGINS, '.deps-tmp')
    mkdirSync(tmp, { recursive: true })
    execFileSync(NODE, [NPM_CLI, 'install', '--no-audit', '--no-fund', '--prefix', tmp, ...missing.map((d) => `${d}@${deps[d]}`)], {
      cwd: tmp, stdio: 'inherit',
    })
    // 合并：把临时 node_modules 里的包复制进 plugins/node_modules
    const tmpNm = join(tmp, 'node_modules')
    if (existsSync(tmpNm)) {
      const { cpSync } = await import('node:fs')
      for (const entry of readdirSync(tmpNm, { withFileTypes: true })) {
        const src = join(tmpNm, entry.name)
        const dst = join(PLUGINS_NM, entry.name)
        if (entry.isDirectory()) {
          cpSync(src, dst, { recursive: true, force: true })
        } else {
          copyFileSync(src, dst)
        }
      }
    }
    rmSync(tmp, { recursive: true, force: true })
    installed++
  } catch (e) {
    console.error(`[install-deps] ${name} 依赖安装失败: ${e.message}`)
    process.exitCode = 1
  }
}

log(`完成：安装 ${installed} 个，跳过 ${skipped} 个`)
