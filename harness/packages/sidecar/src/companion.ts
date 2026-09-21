/**
 * @cos/sidecar/companion — resident HTTP sidecar entry (dev / monorepo).
 *
 * Boots the shared companion composition (see companion-boot.ts):
 * core @cos/* from harness sources, @diver/* from the open plugins root,
 * companion bundle layer, profile `companion` for shell-managed enable/disable.
 *
 * Run (from the harness dir; the repo root is located from this module):
 *   node --import tsx --expose-internals packages/sidecar/src/companion.ts
 *   pnpm start:companion
 * @module @cos/sidecar/companion
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, bootOptionsFromCli, parseCliArgs } from '@cos/boot'
import type { Context } from 'cordis'
import { companionBootOptions, resolveCompanionPaths } from './companion-boot.ts'

const cli = parseCliArgs(process.argv.slice(2))

// This file lives at <repo>/harness/packages/sidecar/src/ — four levels up is the repo root.
const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '..', '..', '..', '..')
const paths = resolveCompanionPaths(cli, { root: repoRoot, preferCosPlugins: true })

const hasPlugins = existsSync(join(paths.pluginsRoot, 'memory', 'package.json'))
  || existsSync(join(paths.pluginsRoot, 'backend', 'package.json'))
if (!existsSync(paths.bundleDir) || !hasPlugins) {
  console.error(
    `[cos] companion plugins not found under ${paths.pluginsRoot} — expected cos-plugins next to harness`,
  )
  process.exit(1)
}

const bootOpts = bootOptionsFromCli(cli, companionBootOptions(cli, paths))
console.error(
  `[cos] companion boot — profile=${bootOpts.profile ?? 'flat'} `
  + `bundle=${paths.bundleDir} plugins=${paths.pluginsRoot} harness=${paths.harnessDir}`,
)

let ctx: Context | undefined
try {
  ctx = await boot(bootOpts)
} catch (error) {
  console.error(`[cos] boot failed: ${error}`)
  process.exit(1)
}

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

// The HTTP server (via @diver/backend) keeps the event loop alive.
await new Promise<void>(() => {
  process.on('SIGINT', () => { void settle('SIGINT') })
  process.on('SIGTERM', () => { void settle('SIGTERM') })
})
