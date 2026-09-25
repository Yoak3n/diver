// Diver 插件依赖一键安装脚本（在 sidecar 运行时目录使用）。
//
// 用法（在 sidecar 运行时目录下）：
//   node install-deps.mjs              # 为 plugins/ 下所有插件安装依赖
//   node install-deps.mjs --plugin <name>   # 只装指定插件
//   node install-deps.mjs --all        # 等价默认（全部）
//
// 原理：用当前 Node（process.execPath / DIVER_NODE_BIN）+ 其自带 npm，为每个
// 插件的 package.json 声明的依赖执行 `npm install`。Node 不随包，由应用缓存
// 或系统 Node 提供。
//
// 依赖解析说明：
//   - 插件声明了依赖，但 plugins/node_modules 里已有 → 跳过（预置）
//   - 插件声明了新依赖（用户新增插件引入）→ 在 plugins/node_modules 安装
//   - @cos/* 引擎核心由 harness 提供，不需要安装

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const HERE = resolve(import.meta.dirname ?? '.')
const PLUGINS = join(HERE, 'plugins')
const PLUGINS_NM = join(PLUGINS, 'node_modules')
const NODE = process.env.DIVER_NODE_BIN || process.execPath
const NPM_CLI = (() => {
  const candidates = [
    join(dirname(NODE), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
})()

const args = process.argv.slice(2)
const only = args.includes('--plugin') ? args[args.indexOf('--plugin') + 1] : null

function log(...m) { console.log('[install-deps]', ...m) }

if (!NPM_CLI) {
  console.error('[install-deps] 未找到 npm-cli.js（Node 旁应带 node_modules/npm）。可安装 Node ≥ 22 或设置 DIVER_NODE_BIN')
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
  // 引擎（@cos/*）、diver 库（@diver/*、@deepseek-ai/dsh-*）、file: 源码依赖
  // 由内置 node_modules 映射提供，无需安装；只装真正缺失的 npm 包。
  const extDeps = Object.keys(deps).filter((d) =>
    !d.startsWith('@cos/') && !d.startsWith('@diver/') && !d.startsWith('@deepseek-ai/dsh-')
    && !String(deps[d] ?? '').startsWith('file:'))
  if (extDeps.length === 0) {
    log(`跳过 ${name}（无外部依赖）`)
    skipped++
    continue
  }
  // 已可解析的跳过：插件本地 node_modules → plugins/node_modules → 内置 node_modules/
  const resolvable = (d) => [
    join(PLUGINS, name, 'node_modules', d),
    join(PLUGINS_NM, d),
    join(PLUGINS, '..', 'node_modules', d),
  ].some((p) => existsSync(p))
  const missing = extDeps.filter((d) => !resolvable(d))
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
