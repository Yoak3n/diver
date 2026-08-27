/**
 * @cos/sidecar/companion-bundle — 随包 Node 形态的常驻 HTTP companion 入口
 * （直接运行，非 SEA）。与 companion-sea.ts 行为一致（boot 陪伴组合、
 * @diver/backend 提供 HTTP/SSE、打印 DIVER_READY），但：
 *   - 由外层程序用随包 node + tsx 启动（node --import tsx companion-bundle.ts）
 *   - 引擎核心（@cos/*）从磁盘源码加载（harness/packages），不再是内嵌烘焙
 *   - 第三方插件（@diver/*）从 plugins/ 目录加载（开放，可改/删/加）
 *
 * 运行时布局（由 Tauri 壳设置）：
 *   cwd        = <install>/resources/sidecar      (cordis.yml / secrets.yml 在这)
 *   COS_HOME   = <user data>/...                  (sessions / workspace / memory)
 *   DIVER_PORT = 53620
 *   DIVER_UI_DIST = <install>/resources/sidecar/dist
 *
 * CLI：
 *   --bundles <path>        bundle 层目录（默认 ./bundles/bundle-companion）
 *   --plugin-root <dir>     开放插件目录（默认 ./plugins）
 *   --harness <dir>         引擎目录（默认 ./harness；核心 @cos/* 从这解析）
 *   --cos-home <dir>        覆盖 COS_HOME
 *
 * 核心包解析：cordis.yml 里的 @cos/* 行名显式映射到 <harness>/packages/<pkg>
 * 的源码入口（pluginPaths），不依赖 node_modules 的 pnpm 链接（随包布局下
 * 链接链会断裂）。第三方行名经 pluginRoot 从 plugins/ 解析。
 *
 * @module @cos/sidecar/companion-bundle
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { boot, bootOptionsFromCli, parseCliArgs } from '@cos/boot'
import type { Context } from 'cordis'

/** 引擎核心包名 → harness/packages/<pkg>/src/index.ts（cordis.yml 行名 = 包目录名）。 */
const CORE_PLUGIN_NAMES = [
  'llm', 'credentials', 'session', 'persistence', 'system-prompt', 'persona',
  'tools', 'scope', 'llm-deepseek', 'mock-llm', 'agents', 'agent-loop', 'subagents',
]

export async function main(overrides: { watchRoots?: string[] } = {}): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2))
  const cwd = process.cwd()

  // Bundles：显式 --bundles 优先，否则默认 ./bundles/bundle-companion。
  let bundleDirs: string[]
  if (cli.bundles.length > 0) {
    bundleDirs = cli.bundles.map((spec) => resolve(cwd, spec))
  } else {
    bundleDirs = [join(cwd, 'bundles', 'bundle-companion')]
  }
  const missing = bundleDirs.filter((dir) => !existsSync(join(dir, 'cordis.patch.yml')))
  if (missing.length > 0) {
    console.error(`[cos] companion bundle not found: ${missing.join(', ')}`)
    process.exit(1)
  }

  // 引擎目录：显式 --harness 优先，否则默认 ./harness。
  const harnessDir = cli.harness !== undefined
    ? resolve(cwd, cli.harness)
    : join(cwd, 'harness')

  // 开放插件目录：显式 --plugin-root 优先，否则默认 ./plugins。
  const pluginRoot = cli.pluginRoot !== undefined
    ? resolve(cwd, cli.pluginRoot)
    : join(cwd, 'plugins')

  // 核心包 pluginPaths：@cos/<pkg> → <harness>/packages/<pkg>/src/index.ts
  const corePaths: Record<string, string> = {}
  for (const pkg of CORE_PLUGIN_NAMES) {
    const entry = join(harnessDir, 'packages', pkg, 'src', 'index.ts')
    if (existsSync(entry)) corePaths[`@cos/${pkg}`] = entry
  }

  let ctx: Context | undefined
  try {
    ctx = await boot(bootOptionsFromCli(cli, {
      configPath: join(cwd, 'cordis.yml'), // 显式：sidecar 目录的 cordis.yml
      bundles: bundleDirs,
      pluginPaths: corePaths,   // 核心 @cos/* → harness 磁盘源码
      pluginRoot,               // 第三方 @diver/* → plugins 开放目录
      watchRoots: overrides.watchRoots ?? [],
      required: ['agentLoop', 'llm', 'tools', 'sessions', 'agents', 'systemPrompt', 'credentials', 'sessionPersistence', 'subagents'],
    }))
  } catch (error) {
    console.error(`[cos] boot failed: ${error}`)
    process.exit(1)
  }
  console.error(`[cos] companion booted — bundles: ${bundleDirs.join(', ')}, harness: ${harnessDir}, plugins: ${pluginRoot}`)

  let settling = false
  async function settle(signal: string): Promise<void> {
    if (settling) return
    settling = true
    console.error(`[cos] ${signal} — disposing companion tree`)
    try {
      await ctx?.fiber.dispose()
    } catch (error) {
      console.error(`[cos] dispose failed: ${error}`)
    }
    process.exit(0)
  }

  // HTTP server (via @diver/backend) keeps the event loop alive.
  await new Promise<void>(() => {
    process.on('SIGINT', () => { void settle('SIGINT') })
    process.on('SIGTERM', () => { void settle('SIGTERM') })
  })
}

// 直接运行入口（node --import tsx companion-bundle.ts ...）
void main()

