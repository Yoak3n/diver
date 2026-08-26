/**
 * @cos/sidecar/companion — resident HTTP sidecar entry for the outer program
 * (the Tauri shell). Boots the Diver companion composition and stays resident
 * while `@diver/backend` serves HTTP/SSE on `DIVER_PORT` (prints
 * `DIVER_READY` on stdout). Stays alive until SIGINT / SIGTERM, then disposes
 * the tree.
 *
 * Diver-mode default: the diver bundles and plugins ARE this repo's own
 * `cos-plugins/` sources, so they are resolved BY PATH directly — no profile
 * install, no harness dependency changes. `--profile <name>` / `--bundles
 * <spec>` explicitly override/complement the defaults for the generic
 * (profile-install) story.
 *
 * Run (from anywhere; the repo root is located from this module):
 *   node --import tsx --expose-internals packages/sidecar/src/companion.ts
 *   pnpm start:companion
 *   dist/cos-sidecar.exe --profile companion   # SEA, plugins baked at build
 * @module @cos/sidecar/companion
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, bootOptionsFromCli, parseCliArgs } from '@cos/boot'
import type { Context } from 'cordis'

const cli = parseCliArgs(process.argv.slice(2))

// Diver direct-path mode: `this file` lives at
// <repo>/harness/packages/sidecar/src/, so four `..` steps from this directory
// reach the repo root where `cos-plugins/` lives.
const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '..', '..', '..', '..')
const diverPluginsRoot = join(repoRoot, 'cos-plugins')
const diverBundles = [join(diverPluginsRoot, 'bundle-companion')]
const diverPluginPaths: Record<string, string> = {
  '@diver/memory': join(diverPluginsRoot, 'memory'),
  '@diver/voice': join(diverPluginsRoot, 'voice'),
  '@diver/backend': join(diverPluginsRoot, 'backend'),
  '@diver/basic-tools': join(diverPluginsRoot, 'basic-tools'),
  '@diver/mcp': join(diverPluginsRoot, 'mcp'),
}
if (!existsSync(diverBundles[0]) || !existsSync(join(diverPluginPaths['@diver/memory'], 'package.json'))) {
  console.error(`[cos] diver plugins not found under ${diverPluginsRoot} — expected the cos-plugins checkout next to the harness`)
  process.exit(1)
}

// A profile boot (generic DSH path) replaces the diver defaults entirely.
const diverOverrides = cli.profile === undefined
  ? { bundles: diverBundles, pluginPaths: diverPluginPaths }
  : {}
let ctx: Context | undefined
try {
  ctx = await boot(bootOptionsFromCli(cli, {
    ...(cli.profile === undefined ? {} : { profile: cli.profile }),
    ...diverOverrides,
    required: ['agentLoop', 'llm', 'tools', 'sessions', 'agents', 'systemPrompt', 'credentials', 'sessionPersistence', 'subagents'],
  }))
} catch (error) {
  console.error(`[cos] boot failed: ${error}`)
  process.exit(1)
}
console.error(`[cos] companion booted (${cli.profile === undefined ? `diver path ${diverBundles[0]}` : `profile ${cli.profile}`})`)

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

// The HTTP server (via @diver/backend) keeps the event loop alive; the signal
// listeners below also count as handles, so the process stays resident even
// if no server mounted. stdin is deliberately ignored — the Tauri shell runs
// this entry with stdin at null.
await new Promise<void>(() => {
  process.on('SIGINT', () => { void settle('SIGINT') })
  process.on('SIGTERM', () => { void settle('SIGTERM') })
})