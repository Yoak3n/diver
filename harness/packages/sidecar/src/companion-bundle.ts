/**
 * @cos/sidecar/companion-bundle — resident HTTP companion entry for the
 * packaged (non-SEA) layout: bundled Node + tsx + open plugin directory.
 *
 * Same composition contract as companion.ts (companion-boot.ts):
 *   - core @cos/* via pluginPaths → <harness>/packages
 *   - @diver/* via pluginRoot → plugins/ (open, editable)
 *   - bundle layer from --bundles (default ./bundles/bundle-companion)
 *   - profile `companion` under COS_HOME for enable/disable overrides
 *
 * Runtime layout (driven by the Tauri shell):
 *   cwd        = <install>/resources/sidecar
 *   COS_HOME   = <user data>/.../cos
 *   DIVER_PORT = 53620
 *   DIVER_UI_DIST = <install>/resources/sidecar/dist
 *
 * CLI:
 *   --bundles <path>        bundle layer directory
 *   --plugin-root <dir>     open plugin directory
 *   --harness <dir>         engine directory
 *   --profile <name>        override companion profile
 *   --cos-home <dir>        override COS_HOME
 * @module @cos/sidecar/companion-bundle
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { boot, bootOptionsFromCli, parseCliArgs } from '@cos/boot'
import type { Context } from 'cordis'
import { companionBootOptions, resolveCompanionPaths } from './companion-boot.ts'

export async function main(overrides: { watchRoots?: string[] } = {}): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2))
  const cwd = process.cwd()
  // Packaged layout lives under cwd (resources/sidecar): harness/, plugins/, bundles/.
  const paths = resolveCompanionPaths(cli, { root: cwd, preferCosPlugins: false })

  const missing = [paths.bundleDir, paths.harnessDir].filter(
    (dir) => !existsSync(dir),
  )
  if (missing.length > 0) {
    console.error(`[cos] companion runtime paths missing: ${missing.join(', ')}`)
    process.exit(1)
  }

  const bootOpts = bootOptionsFromCli(cli, {
    ...companionBootOptions(cli, paths),
    watchRoots: overrides.watchRoots ?? [],
  })

  console.error(
    `[cos] companion (bundle) booted — profile=${bootOpts.profile ?? 'flat'} `
    + `bundles=${paths.bundleDir}, harness=${paths.harnessDir}, plugins=${paths.pluginsRoot}`,
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

  await new Promise<void>(() => {
    process.on('SIGINT', () => { void settle('SIGINT') })
    process.on('SIGTERM', () => { void settle('SIGTERM') })
  })
}

void main()
