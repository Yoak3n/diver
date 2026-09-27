// @diver/backend — 插件装配与管理面：mount 列表 / 启停 / profile 切换 / native 探测。
// 磁盘格式语义见 plugin-store.ts；安装/卸载进程见 plugin-install.ts。

import { existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WebState } from './state.ts'
import {
  COMPANION_PROFILE,
  SAFE_PROFILE,
  bundleDir,
  pluginsRoot,
  profileDir,
  readActiveProfile,
} from './paths.ts'
import { NATIVE_RPC_METHODS, nativeRpcUrl, probeNativeRpc } from '@diver/native-bridge/rpc'
import {
  broadcastPlugins,
  catalog,
  loadDisabledIds,
  packageDir,
  packagePresent,
  parseBundleInserts,
  readJson,
  readProfileRegistry,
  saveDisabledIds,
} from './plugin-store.ts'
import type { PluginInfo } from './plugin-store.ts'

export type { PluginInfo } from './plugin-store.ts'

export function listPlugins(): PluginInfo[] {
  const profile = readActiveProfile()
  const safe = profile === SAFE_PROFILE
  const root = pluginsRoot()
  const cat = catalog()
  const disabled = loadDisabledIds(profileDir(profile))
  const registry = readProfileRegistry(profileDir(profile))

  const rows: Array<{ id: string; name: string }> = parseBundleInserts()
  if (root) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const manifestPath = join(root, entry.name, 'package.json')
        const manifest = readJson<{ name?: string }>(manifestPath)
        const name = manifest?.name
        if (!name?.startsWith('@diver/') || name === '@diver/bundle-companion') continue
        const short = entry.name
        const meta = [...cat.values()].find((c) => c.packageName === name)
        const id = meta?.id ?? short
        if (!rows.some((r) => r.id === id || r.name === name)) {
          rows.push({ id, name })
        }
      }
    } catch {
      /* unreadable root */
    }
  }

  const seen = new Set<string>()
  const out: PluginInfo[] = []

  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const meta = cat.get(row.id)
    const packageName =
      row.name ||
      meta?.packageName ||
      `@diver/${row.id}`
    const present = packagePresent(root, packageName)
    const enabled = present && !disabled.has(row.id) && (!safe || row.id === 'backend')
    out.push({
      id: row.id,
      packageName,
      displayName: meta?.displayName ?? row.id,
      description: meta?.description ?? '',
      kind: 'internal',
      enabled,
      toggleable: meta?.toggleable ?? true,
      source: packageDir(root, packageName),
      present,
      advisory: meta?.advisory ?? null,
    })
  }

  for (const rec of registry) {
    const pkgDir = packageDir(join(profileDir(profile), 'node_modules'), rec.packageName)
    // packageDir for scoped names under profile node_modules
    const exists = existsSync(
      rec.packageName.startsWith('@')
        ? join(profileDir(profile), 'node_modules', ...rec.packageName.split('/'))
        : join(profileDir(profile), 'node_modules', rec.packageName, 'package.json'),
    )
    const enabled = exists && !disabled.has(rec.id) && !safe
    const info: PluginInfo = {
      id: rec.id,
      packageName: rec.packageName,
      displayName: rec.insertName ?? rec.packageName,
      description: `profile 安装 · spec: ${rec.spec}${rec.bundle ? ' · bundle' : ' · insert'}`,
      kind: 'profile',
      enabled,
      toggleable: true,
      source: exists
        ? rec.packageName.startsWith('@')
          ? join(profileDir(profile), 'node_modules', ...rec.packageName.split('/'))
          : join(profileDir(profile), 'node_modules', rec.packageName)
        : pkgDir,
      present: exists,
      advisory: null,
    }
    const idx = out.findIndex((p) => p.id === info.id)
    if (idx >= 0) out[idx] = info
    else out.push(info)
  }

  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

export function setPluginEnabled(id: string, enabled: boolean): PluginInfo[] {
  const profile = profileDir()
  ensureProfile(profile)
  const cat = catalog()
  const current = loadDisabledIds(profile)
  const pkg = cat.get(id)?.packageName ?? `@diver/${id}`

  const next = new Map<string, string>()
  for (const [existingId, existingPkg] of current) {
    if (existingId === id) continue
    next.set(existingId, existingPkg)
  }
  if (!enabled) next.set(id, pkg)
  saveDisabledIds(next, profile)
  return listPlugins()
}

export function ensureProfile(profile = profileDir()): void {
  mkdirSync(profile, { recursive: true })
  const patch = join(profile, 'cordis.patch.yml')
  if (!existsSync(patch)) {
    writeFileSync(
      patch,
      '# Diver shell-managed profile patch (enable/disable plugin rows).\n[]\n',
      'utf8',
    )
  }
  const manifest = join(profile, 'package.json')
  if (!existsSync(manifest)) {
    writeFileSync(
      manifest,
      JSON.stringify(
        {
          name: `cos-profile-${readActiveProfile()}`,
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: [] } },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
  }
}

export async function getProfile(): Promise<{
  activeProfile: string
  bundleDir?: string
  pluginsRoot?: string
  profileDir: string
}> {
  return {
    activeProfile: readActiveProfile(),
    bundleDir: bundleDir(),
    pluginsRoot: pluginsRoot(),
    profileDir: profileDir(),
  }
}

export async function setProfile(name: string): Promise<{ activeProfile: string }> {
  const n = name.trim()
  if (n !== COMPANION_PROFILE && n !== SAFE_PROFILE) {
    throw new Error(`未知 profile: ${name}`)
  }
  const { writeActiveProfile } = await import('./paths.ts')
  writeActiveProfile(n)
  ensureProfile(profileDir(n))
  return { activeProfile: n }
}

export async function nativeStatus(): Promise<unknown> {
  const url = nativeRpcUrl()
  const probes = []
  if (url) {
    for (const entry of NATIVE_RPC_METHODS) {
      // 有副作用的方法（如 notify::show）禁止真调探测——否则设置页会弹出
      // 真实桌面通知。连通性由同通道的 notify::ping 覆盖。
      if (entry.probeSafe === false) {
        probes.push({
          method: entry.method,
          ok: true,
          detail: 'skipped (side effect; see notify::ping)',
        })
        continue
      }
      const params =
        entry.method === 'grep::search'
          ? { pattern: '__diver_native_probe__', path: '.', maxMatches: 1 }
          : {}
      probes.push(await probeNativeRpc(entry.method, params))
    }
  }
  return {
    configured: url !== null,
    url,
    methods: NATIVE_RPC_METHODS,
    probes,
    activeProfile: readActiveProfile(),
  }
}

/** 启停并同步缓存 + SSE 广播（routes 层入口）。 */
export function toggleWithBroadcast(
  id: string,
  enabled: boolean,
  state: WebState,
  broadcast: (e: unknown) => void,
): PluginInfo[] {
  const plugins = setPluginEnabled(id, enabled)
  broadcastPlugins(state, broadcast, plugins)
  return plugins
}
