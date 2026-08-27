/**
 * @cos/sidecar/companion-sea — SEA entry for the resident HTTP companion
 * sidecar (packaged build). Same behaviour as `companion.ts` (boots the Diver
 * companion composition and stays resident while `@diver/backend` serves
 * HTTP/SSE on `DIVER_PORT`, printing `DIVER_READY`), but resolves the diver
 * bundle and plugin paths from CLI arguments / environment instead of
 * `import.meta.url` relative-to-repo layout — the packaged runtime directory
 * has no `cos-plugins/` checkout next to it.
 *
 * Plugin openness: third-party plugins are NOT baked into the binary. They
 * ship as source directories under `plugins/` (see bundle-release.mjs) and are
 * loaded from disk at runtime via `--plugin-root` — users can edit/delete/add
 * plugins without rebuilding the SEA binary. The SEA binary embeds only the
 * engine core (@cos/*); the plugins' runtime dependencies (@cos/*, cordis,
 * external packages) resolve from `plugins/node_modules`.
 *
 * Runtime layout (set by the Tauri shell):
 *   cwd        = <install>/resources/sidecar      (cordis.yml / secrets.yml live here)
 *   COS_HOME   = <user data>/...                  (sessions / workspace / memory)
 *   DIVER_PORT = 53620
 *   DIVER_UI_DIST = <install>/resources/sidecar/dist
 *
 * CLI (overriding defaults):
 *   --bundles <path>       bundle layer dir (e.g. .../bundles/bundle-companion)
 *   --plugin-root <dir>    open plugins dir (row-name packages; default: ./plugins)
 *   --cos-home <dir>       override COS_HOME
 *
 * NOTE: this entry is compiled to CJS by scripts/build-sea.mjs, so the boot
 * logic lives inside `main()` (no top-level await).
 *
 * @module @cos/sidecar/companion-sea
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { boot, bootOptionsFromCli, parseCliArgs } from '@cos/boot'
import type { Context } from 'cordis'

export async function main(overrides: { watchRoots?: string[]; plugins?: Record<string, unknown> } = {}): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2))

  // Bundles: explicit --bundles wins; otherwise default to a
  // `bundles/bundle-companion` directory next to the SEA runtime (the cwd is
  // the sidecar resource dir in the packaged build).
  const cwd = process.cwd()
  let bundleDirs: string[]
  if (cli.bundles.length > 0) {
    bundleDirs = cli.bundles.map((spec) => resolve(cwd, spec))
  } else {
    const fallback = join(cwd, 'bundles', 'bundle-companion')
    bundleDirs = [fallback]
  }
  const missing = bundleDirs.filter((dir) => !existsSync(join(dir, 'cordis.patch.yml')))
  if (missing.length > 0) {
    console.error(
      `[cos] companion bundle not found: ${missing.join(', ')} — expected cordis.patch.yml in the bundle layer (packaged layout: <sidecar>/bundles/bundle-companion)`,
    )
    process.exit(1)
  }

  // Open plugins dir: explicit --plugin-root wins; otherwise default to
  // ./plugins next to the SEA runtime. When present, third-party plugins load
  // from disk (editable/deletable/addable) and the baked registry is skipped
  // for row names — the baked `overrides.plugins` only serves as a fallback
  // for engine-internal names that are never mounted by row.
  const pluginRoot = cli.pluginRoot !== undefined
    ? resolve(cwd, cli.pluginRoot)
    : join(cwd, 'plugins')

  let ctx: Context | undefined
  try {
    ctx = await boot(bootOptionsFromCli(cli, {
      bundles: bundleDirs,
      // Open plugins dir: disk-first for third-party row names.
      pluginRoot,
      // The baked registry (engine core @cos/*) is ALWAYS passed: core rows
      // in cordis.yml (@cos/agent-loop etc.) must resolve from the embedded
      // graph, never from the disk plugins dir (which only holds @diver/*).
      // Third-party names (@diver/*) hit the disk plugins dir first via
      // pluginRoot; the baked registry has no such names in the open build.
      plugins: overrides.plugins,
      watchRoots: overrides.watchRoots ?? [],
      required: ['agentLoop', 'llm', 'tools', 'sessions', 'agents', 'systemPrompt', 'credentials', 'sessionPersistence', 'subagents'],
    }))
  } catch (error) {
    console.error(`[cos] boot failed: ${error}`)
    process.exit(1)
  }
  console.error(`[cos] companion (SEA) booted — bundles: ${bundleDirs.join(', ')}, plugins: ${pluginRoot}`)

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

  // The HTTP server (via @diver/backend) keeps the event loop alive; the
  // signal listeners below also count as handles, so the process stays
  // resident even if no server mounted. stdin is deliberately ignored — the
  // Tauri shell runs this entry with stdin at null.
  await new Promise<void>(() => {
    process.on('SIGINT', () => { void settle('SIGINT') })
    process.on('SIGTERM', () => { void settle('SIGTERM') })
  })
}
