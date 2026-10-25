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

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
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
  'llm-retry',
  'subagents',
] as const

/**
 * 产品自己的 npm scope。引擎（harness）不认识任何 scope——播种的解析链与
 * 错误归属的包名限定都从这里注入（harness `BootOptions.pluginScope`）。
 */
export const DIVER_PLUGIN_SCOPE = '@diver'

/**
 * 产品核心插件：其未捕获错误立即 panic（引擎默认清单为空——见 harness
 * `BootOptions.corePlugins` / error-guard.ts）。backend 是 UI 的 HTTP/SSE 通道，
 * 挂了产品即死；native-bridge 是插件间共享 RPC 库，坏了会连坐。
 */
export const DIVER_CORE_PLUGINS = ['@diver/backend', '@diver/native-bridge'] as const

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

/** cos home：sidecar 启动时 Rust 注入 COS_HOME；未注入时与引擎兜底一致（~/.cos）。 */
function cosHomeOf(): string {
  return process.env.COS_HOME || join(homedir(), '.cos')
}

/** 对 base cordis.yml credentials 行的 config 覆盖 patch（见 pinCredentialsSecrets）。 */
interface CredentialsSecretsPin {
  id: 'credentials'
  config: { file: string }
}

/**
 * 凭据 secrets 文件钉在 $COS_HOME/secrets.yml（用户数据目录：可写、升级不丢）。
 *
 * 引擎默认 `credentials.config.file: ./secrets.yml`（harness/cordis.yml）按
 * sidecar 进程 cwd 解析：dev cwd 是仓库 harness/（可写），打包后是
 * <install>/resources/sidecar（AppImage squashfs / Program Files 只读）——
 * 设置面板保存 API Key 时写该路径必然失败，凭据永远 unresolved，面板呈现
 * 「保存无反应、始终未配置」。这里经 extraPatches 以绝对路径覆盖 base
 * cordis.yml 里 credentials 行的 config；@cos/credentials（读，取该 config）
 * 与 @diver/backend 的 secrets 写入（取 ctx.credentials.secretFile）随之同源。
 * 顺带把旧布局残留在 harness cwd 的 secrets.yml 一次性搬入 COS_HOME
 * （该位置仅 dev 曾成功写过）。
 */
function pinCredentialsSecrets(cosHome: string, harnessDir: string): CredentialsSecretsPin {
  const file = join(cosHome, 'secrets.yml')
  const legacy = join(harnessDir, 'secrets.yml')
  if (!existsSync(file) && existsSync(legacy)) {
    try {
      mkdirSync(cosHome, { recursive: true })
      copyFileSync(legacy, file)
      console.error(`[cos] 迁移 secrets 文件: ${legacy} → ${file}`)
    } catch (err) {
      console.error('[cos] 迁移 secrets 文件失败（保存凭据时将在新位置重建）:', err)
    }
  }
  return { id: 'credentials', config: { file } }
}

export interface CompanionPaths {
  /** Engine dir containing `packages/@cos/*` sources + node_modules/tsx. */
  harnessDir: string
  /** Open plugin root for `@diver/*` (unscoped package name). */
  pluginsRoot: string
  /**
   * 出厂种子镜像目录（安装目录 `plugins.seed/`，P1c/B′）。存在时 boot 按
   * seedVersion 把种子对账到 pluginsRoot 用户工作区；dev 布局缺省。
   */
  seedDir?: string
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

  const cosHome = cosHomeOf()
  const defaultPlugins = prefer
    ? (existsSync(join(root, 'cos-plugins')) ? join(root, 'cos-plugins') : join(root, 'plugins'))
    : (existsSync(join(root, 'plugins')) ? join(root, 'plugins') : join(cosHome, 'plugins'))

  const pluginsRoot = cli.pluginRoot !== undefined
    ? resolve(process.cwd(), cli.pluginRoot)
    : defaultPlugins

  const seedDir = existsSync(join(root, 'plugins.seed')) ? join(root, 'plugins.seed') : undefined

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

  return { harnessDir, pluginsRoot, ...(seedDir === undefined ? {} : { seedDir }), bundleDir, configPath }
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
  const secretsPin = pinCredentialsSecrets(cosHomeOf(), paths.harnessDir)

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
      pluginScope: DIVER_PLUGIN_SCOPE,
      corePlugins: [...DIVER_CORE_PLUGINS],
      ...(paths.seedDir === undefined ? {} : { seedDir: paths.seedDir }),
      profile: SAFE_PROFILE,
      required: [...REQUIRED_SERVICES],
      extraPatches: [secretsPin, safeInsert] as BootOptions['extraPatches'],
    }
  }

  // P4: profile-installed plain plugins (non-bundle) mount as insert rows.
  const cosHome = cosHomeOf()
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
    pluginScope: DIVER_PLUGIN_SCOPE,
    corePlugins: [...DIVER_CORE_PLUGINS],
    ...(paths.seedDir === undefined ? {} : { seedDir: paths.seedDir }),
    profile,
    required: [...REQUIRED_SERVICES],
    extraPatches: (profileInserts.length === 0
      ? [secretsPin]
      : [secretsPin, { insert: profileInserts }]) as BootOptions['extraPatches'],
  }
}
