/**
 * @diver/companion/companion-boot — shared companion composition for diver
 * (dev `companion.ts` and release `companion-bundle.ts`).
 *
 * Product layer, lives under `cos-plugins/` (not in the cos harness).
 * Single loader contract (no hand-written @diver path maps):
 *   - pluginPaths  : @cos/* core → <harness>/packages/<pkg>/src/index.ts
 *   - pluginRoot   : open plugins dir (`@scope/name` → <root>/<name>`)
 *   - bundles      : companion bundle directory (cordis.patch.yml inserts)
 *   - profile      : `companion` under $COS_HOME — user patch layer holds
 *                    enable/disable overrides written by the Tauri shell
 *
 * CLI overrides still win: `--profile` / `--bundles` / `--plugin-root` /
 * `--harness` / `--config`.
 * @module @diver/companion/companion-boot
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { BootOptions, CliOptions } from '../../../harness/packages/boot/src/index.ts'
import { profilePluginInserts } from './profile-plugins.ts'

/** Default profile id under `$COS_HOME/profiles/` for the companion agent. */
export const COMPANION_PROFILE = 'companion'

/** Recovery profile: core services + minimal backend transport only. */
export const SAFE_PROFILE = 'safe'

/** Plugin rows mounted in safe mode (UI must stay reachable). */
export const SAFE_INSERTS = [
  { id: 'backend', name: '@diver/backend' },
] as const

/** Core harness packages mounted from disk (never user-uninstallable). */
export const CORE_PLUGIN_NAMES = [
  'llm',
  'credentials',
  'session',
  'persistence',
  'system-prompt',
  'persona',
  'tools',
  'skills',
  'scope',
  'llm-deepseek',
  'mock-llm',
  'agents',
  'agent-loop',
  'subagents',
] as const

/** Fail-loud service ids after settle. */
export const REQUIRED_SERVICES = [
  'agentLoop',
  'llm',
  'tools',
  'sessions',
  'agents',
  'systemPrompt',
  'credentials',
  'sessionPersistence',
  'subagents',
  'skills',
] as const

export interface CompanionPaths {
  /** Engine dir containing `packages/@cos/*` sources + node_modules/tsx. */
  harnessDir: string
  /** Open plugin root for `@diver/*` (unscoped package name). */
  pluginsRoot: string
  /** Companion bundle dir holding `cordis.patch.yml` / `bundle.yml`. */
  bundleDir: string
  /** Base composition file (`cordis.yml`). */
  configPath: string
}

/** Map `@cos/<pkg>` → `<harness>/packages/<pkg>/src/index.ts` when present. */
export function corePluginPaths(harnessDir: string): Record<string, string> {
  const corePaths: Record<string, string> = {}
  for (const pkg of CORE_PLUGIN_NAMES) {
    const entry = join(harnessDir, 'packages', pkg, 'src', 'index.ts')
    if (existsSync(entry)) corePaths[`@cos/${pkg}`] = entry
  }
  return corePaths
}

/** Resolve companion paths from CLI + a layout base (repo root or install cwd). */
export function resolveCompanionPaths(cli: CliOptions, base: {
  /** Directory that owns `harness/`, `plugins/` or `cos-plugins/`, and bundle. */
  root: string
  /** Prefer `cos-plugins` (dev monorepo) over `plugins` (release layout). */
  preferCosPlugins?: boolean
}): CompanionPaths {
  const root = resolve(base.root)
  const prefer = base.preferCosPlugins !== false

  const harnessDir = cli.harness !== undefined
    ? resolve(process.cwd(), cli.harness)
    : existsSync(join(root, 'harness', 'packages', 'sidecar', 'src'))
      ? join(root, 'harness')
      : join(process.cwd(), 'harness')

  const defaultPlugins = prefer
    ? (existsSync(join(root, 'cos-plugins')) ? join(root, 'cos-plugins') : join(root, 'plugins'))
    : (existsSync(join(root, 'plugins')) ? join(root, 'plugins') : join(root, 'cos-plugins'))

  const pluginsRoot = cli.pluginRoot !== undefined
    ? resolve(process.cwd(), cli.pluginRoot)
    : defaultPlugins

  const defaultBundle = existsSync(join(pluginsRoot, 'bundle-companion'))
    ? join(pluginsRoot, 'bundle-companion')
    : join(root, 'bundles', 'bundle-companion')

  const bundleDir = cli.bundles.length > 0
    ? resolve(process.cwd(), cli.bundles[0])
    : defaultBundle

  const configPath = cli.configPath !== join(process.cwd(), 'cordis.yml') || existsSync(cli.configPath)
    ? resolve(cli.configPath)
    : existsSync(join(process.cwd(), 'cordis.yml'))
      ? join(process.cwd(), 'cordis.yml')
      : join(harnessDir, 'cordis.yml')

  return { harnessDir, pluginsRoot, bundleDir, configPath }
}

/**
 * Build BootOptions for the companion composition.
 * @param cli - parsed argv (profile/bundles/pluginRoot/harness overrides win)
 * @param paths - resolved layout paths
 */
export function companionBootOptions(cli: CliOptions, paths: CompanionPaths): Partial<BootOptions> {
  const profile = cli.profile ?? COMPANION_PROFILE
  const safe = profile === SAFE_PROFILE
  const harnessOk = existsSync(join(paths.harnessDir, 'packages'))
  const bundleOk = existsSync(join(paths.bundleDir, 'cordis.patch.yml'))

  if (!harnessOk) {
    console.error(`[cos] harness missing: ${paths.harnessDir}`)
  }
  if (!safe && !bundleOk) {
    console.error(`[cos] companion bundle missing: ${paths.bundleDir}`)
  }

  if (safe) {
    // Recovery composition: cordis.yml core + backend insert only.
    // No companion bundle layer (avoids fragile third-party inserts).
    console.error(`[cos] SAFE profile — core + backend only (plugins=${paths.pluginsRoot})`)
    const safeInsert = {
      insert: SAFE_INSERTS.map((row) => ({ id: row.id, name: row.name })),
    }
    return {
      configPath: paths.configPath,
      bundles: [],
      pluginPaths: corePluginPaths(paths.harnessDir),
      pluginRoot: paths.pluginsRoot,
      profile: SAFE_PROFILE,
      required: [...REQUIRED_SERVICES],
      extraPatches: [safeInsert] as BootOptions['extraPatches'],
    }
  }

  // P4: profile-installed plain plugins (non-bundle) mount as insert rows.
  const cosHome = process.env.COS_HOME || join(homedir(), '.cos')
  const profileDir = join(cosHome, 'profiles', profile)
  const profileInserts = profilePluginInserts(profileDir)
  if (profileInserts.length > 0) {
    console.error(
      `[cos] profile plugins (${profile}): ${profileInserts.map((p) => p.id).join(', ')}`,
    )
  }

  return {
    configPath: paths.configPath,
    bundles: bundleOk ? [paths.bundleDir] : [],
    pluginPaths: corePluginPaths(paths.harnessDir),
    pluginRoot: paths.pluginsRoot,
    profile,
    required: [...REQUIRED_SERVICES],
    ...(profileInserts.length === 0
      ? {}
      : { extraPatches: [{ insert: profileInserts }] as BootOptions['extraPatches'] }),
  }
}
