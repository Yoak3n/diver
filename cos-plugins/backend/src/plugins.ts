// @diver/backend — 插件列表/启停/安装（阶段 1：业务通道收敛到 backend HTTP）。
//
// 与壳端 Rust plugins 模块同一套磁盘语义：
// - mount：bundle cordis.patch.yml insert ∪ plugins 目录 ∪ catalog
// - 启停：profile cordis.patch.yml `disabled: true`（保留 insert 块）
// - profile 安装：diver-plugins.json + package.json + pnpm（可选）
// 变更后通过 SSE `plugin` 事件广播，并可选 requestRestart()。

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WebState } from './state.ts'
import {
  COMPANION_PROFILE,
  SAFE_PROFILE,
  bundleDir,
  gracefulExitForRestart,
  pluginsRoot,
  profileDir,
  readActiveProfile,
} from './paths.ts'
import { NATIVE_RPC_METHODS, nativeRpcUrl, probeNativeRpc } from '@diver/native-bridge/rpc'

export interface PluginInfo {
  id: string
  packageName: string
  displayName: string
  description: string
  kind: 'internal' | 'profile'
  enabled: boolean
  toggleable: boolean
  source: string
  present: boolean
  advisory?: string | null
}

interface CatalogEntry {
  id: string
  packageName?: string
  displayName?: string
  description?: string
  toggleable?: boolean
  defaultEnabled?: boolean
  advisory?: string
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

function catalog(): Map<string, CatalogEntry> {
  const dir = bundleDir()
  const map = new Map<string, CatalogEntry>()
  if (!dir) return map
  const file = readJson<{ plugins?: CatalogEntry[] }>(join(dir, 'plugins.json'))
  for (const entry of file?.plugins ?? []) map.set(entry.id, entry)
  return map
}

function parseBundleInserts(): Array<{ id: string; name: string }> {
  const dir = bundleDir()
  if (!dir) return []
  let content: string
  try {
    content = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  } catch {
    return []
  }
  const rows: Array<{ id: string; name: string }> = []
  let currentId: string | null = null
  let inInsert = false
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#')) continue
    if (line.startsWith('- insert:')) {
      inInsert = true
      continue
    }
    if (!inInsert) continue
    const idMatch = line.match(/^- id:\s*(.+)$/)
    if (idMatch) {
      if (currentId) rows.push({ id: currentId, name: '' })
      currentId = unquote(idMatch[1]!)
      continue
    }
    const nameMatch = line.match(/^name:\s*(.+)$/)
    if (nameMatch && currentId) {
      rows.push({ id: currentId, name: unquote(nameMatch[1]!) })
      currentId = null
    }
  }
  if (currentId) rows.push({ id: currentId, name: '' })
  return rows
}

function unquote(s: string): string {
  return s.trim().replace(/^['"]|['"]$/g, '')
}

function loadDisabledIds(profile = profileDir()): Set<string> {
  let content: string
  try {
    content = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
  } catch {
    return new Set()
  }
  const disabled = new Set<string>()
  let currentId: string | null = null
  let currentDisabled = false
  const flush = () => {
    if (currentId && currentDisabled) disabled.add(currentId)
    currentId = null
    currentDisabled = false
  }
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line === '[]') continue
    const idMatch = line.match(/^(?:- )?id:\s*(.+)$/)
    if (idMatch) {
      flush()
      currentId = unquote(idMatch[1]!)
      continue
    }
    if (line.startsWith('disabled:')) {
      const v = unquote(line.slice('disabled:'.length)).toLowerCase()
      currentDisabled = ['true', '1', 'yes', 'on'].includes(v)
    }
  }
  flush()
  return disabled
}

/** 写 profile 补丁：保留 insert 与非 shell 块，只重写 disabled 集合。 */
function saveDisabledIds(disabled: Map<string, string>, profile = profileDir()): void {
  mkdirSync(profile, { recursive: true })
  const path = join(profile, 'cordis.patch.yml')
  let existing = ''
  try {
    existing = readFileSync(path, 'utf8')
  } catch {
    existing = ''
  }
  const preserved: string[] = []
  let block: string[] = []
  const flush = () => {
    if (!block.length) return
    const text = block.join('\n')
    const isInsert = block.some((l) => l.trimStart().startsWith('- insert:') || l.trim() === '- insert:')
    const hasId = block.some((l) => l.trimStart().startsWith('- id:') || l.trimStart().startsWith('id:'))
    const hasDisable = block.some((l) => {
      const t = l.trim()
      if (!t.startsWith('disabled:')) return false
      return ['true', '1', 'yes', 'on'].includes(unquote(t.slice('disabled:'.length)).toLowerCase())
    })
    if (isInsert || !(hasId && hasDisable)) preserved.push(text)
    block = []
  }
  for (const line of existing.split(/\r?\n/)) {
    const top = line.startsWith('- ') || line === '-'
    if (top && block.length) flush()
    const t = line.trim()
    if (!t || t.startsWith('#')) {
      if (block.length) block.push(line)
      continue
    }
    block.push(line)
  }
  flush()

  let out = '# Diver shell-managed profile patch (enable/disable plugin rows).\n'
  for (const chunk of preserved) {
    out += chunk + '\n'
  }
  for (const [id, pkg] of [...disabled.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out += `- id: ${id}\n`
    if (pkg) out += `  name: '${pkg}'\n`
    out += '  disabled: true\n'
  }
  if (!preserved.length && !disabled.size) out += '[]\n'
  writeFileSync(path, out, 'utf8')
}

function packagePresent(root: string | undefined, packageName: string): boolean {
  if (!root) return false
  const slash = packageName.lastIndexOf('/')
  const pkg = slash >= 0 ? packageName.slice(slash + 1) : packageName
  return existsSync(join(root, pkg, 'package.json'))
}

function packageDir(root: string | undefined, packageName: string): string {
  if (!root) return packageName
  const slash = packageName.lastIndexOf('/')
  const pkg = slash >= 0 ? packageName.slice(slash + 1) : packageName
  return join(root, pkg)
}

interface ProfileRecord {
  id: string
  packageName: string
  spec: string
  kind: 'profile'
  bundle: boolean
  insertName?: string
}

function readProfileRegistry(profile = profileDir()): ProfileRecord[] {
  return readJson<{ installed?: ProfileRecord[] }>(join(profile, 'diver-plugins.json'))?.installed ?? []
}

function writeProfileRegistry(records: ProfileRecord[], profile = profileDir()): void {
  mkdirSync(profile, { recursive: true })
  writeFileSync(
    join(profile, 'diver-plugins.json'),
    JSON.stringify({ schemaVersion: 1, installed: records }, null, 2) + '\n',
    'utf8',
  )
}

function broadcastPlugins(state: WebState, broadcast: (e: unknown) => void, plugins: PluginInfo[]): void {
  state.plugins = plugins
  broadcast({ type: 'plugin', action: 'changed', plugins })
}

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

function runPnpm(profile: string, args: string[]): Promise<string> {
  const bin = process.env.DIVER_PNPM ?? 'pnpm'
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: profile,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', npm_config_yes: 'true' },
    })
    let out = ''
    child.stdout.on('data', (c) => (out += String(c)))
    child.stderr.on('data', (c) => (out += String(c)))
    child.on('error', (e) => reject(new Error(`${bin} 不可用: ${e}`)))
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`pnpm ${args.join(' ')} failed:\n${out.trim()}`))
    })
  })
}

export async function installProfilePlugin(
  spec: string,
  state: WebState,
  broadcast: (e: unknown) => void,
): Promise<PluginInfo[]> {
  const profile = readActiveProfile()
  if (profile === SAFE_PROFILE) throw new Error('safe 模式不可安装插件')
  ensureProfile(profileDir(profile))
  const dir = profileDir(profile)
  const pkgPath = join(dir, 'package.json')
  const lockPath = join(dir, 'pnpm-lock.yaml')
  const pkgBackup = existsSync(pkgPath) ? readFileSync(pkgPath) : undefined
  const lockBackup = existsSync(lockPath) ? readFileSync(lockPath) : undefined

  try {
    await runPnpm(dir, ['add', spec])
  } catch (e) {
    if (pkgBackup) writeFileSync(pkgPath, pkgBackup)
    if (lockBackup) writeFileSync(lockPath, lockBackup)
    throw e
  }

  // Resolve package name from file: or spec
  let packageName = spec
  if (spec.startsWith('file:')) {
    const raw = spec.slice('file:'.length).replace(/^\.\//, '')
    const abs = raw.startsWith('/') || /^[A-Za-z]:/.test(raw) ? raw : join(dir, raw)
    packageName = readJson<{ name?: string }>(join(abs, 'package.json'))?.name ?? packageName
  } else if (spec.startsWith('@')) {
    packageName = spec.replace(/@[^/]+$/, '').startsWith('@')
      ? spec.split('@')[0] === ''
        ? spec
        : spec.slice(0, spec.lastIndexOf('@')) || spec
      : packageName
    // scoped: @scope/name@version
    const at = spec.lastIndexOf('@')
    packageName = at > 0 ? spec.slice(0, at) : spec
  } else {
    packageName = spec.split('@')[0]!
  }

  const installedDir = packageName.startsWith('@')
    ? join(dir, 'node_modules', ...packageName.split('/'))
    : join(dir, 'node_modules', packageName)
  if (!existsSync(join(installedDir, 'package.json'))) {
    if (pkgBackup) writeFileSync(pkgPath, pkgBackup)
    if (lockBackup) writeFileSync(lockPath, lockBackup)
    throw new Error(`安装后未找到包体 ${packageName}，已回滚`)
  }

  const manifest = readJson<{ name?: string; dsh?: { bundle?: unknown } }>(
    join(installedDir, 'package.json'),
  )
  const isBundle = !!manifest?.dsh?.bundle
  const id = packageName.includes('/') ? packageName.split('/').pop()! : packageName

  const registry = readProfileRegistry(dir)
  if (!registry.some((r) => r.packageName === packageName || r.id === id)) {
    registry.push({
      id,
      packageName,
      spec,
      kind: 'profile',
      bundle: isBundle,
      insertName: packageName,
    })
    writeProfileRegistry(registry, dir)
  }

  if (isBundle) {
    const p = join(dir, 'package.json')
    const json = JSON.parse(readFileSync(p, 'utf8')) as Record<string, any>
    json.dsh ??= { profile: { bundles: [] } }
    json.dsh.profile ??= { bundles: [] }
    json.dsh.profile.bundles ??= []
    if (!json.dsh.profile.bundles.includes(packageName)) {
      json.dsh.profile.bundles.push(packageName)
    }
    writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf8')
  }

  const plugins = listPlugins()
  broadcastPlugins(state, broadcast, plugins)
  return plugins
}

export async function uninstallProfilePlugin(
  id: string,
  state: WebState,
  broadcast: (e: unknown) => void,
): Promise<PluginInfo[]> {
  const profile = readActiveProfile()
  if (profile === SAFE_PROFILE) throw new Error('safe 模式不可卸载插件')
  const dir = profileDir(profile)
  const registry = readProfileRegistry(dir)
  const idx = registry.findIndex((r) => r.id === id || r.packageName === id)
  if (idx < 0) {
    const list = listPlugins()
    const internal = list.find((p) => p.id === id && p.kind === 'internal')
    if (internal) throw new Error(`${internal.packageName} 是 internal 插件，不可卸载（可禁用）`)
    throw new Error(`未找到 profile 插件: ${id}`)
  }
  const entry = registry[idx]!
  registry.splice(idx, 1)
  writeProfileRegistry(registry, dir)

  try {
    await runPnpm(dir, ['remove', entry.packageName])
  } catch (e) {
    registry.splice(idx, 0, entry)
    writeProfileRegistry(registry, dir)
    throw e
  }

  if (entry.bundle) {
    const p = join(dir, 'package.json')
    try {
      const json = JSON.parse(readFileSync(p, 'utf8')) as Record<string, any>
      if (json.dsh?.profile?.bundles) {
        json.dsh.profile.bundles = (json.dsh.profile.bundles as string[]).filter(
          (b: string) => b !== entry.packageName,
        )
      }
      writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf8')
    } catch {
      /* ignore */
    }
  }

  const plugins = listPlugins()
  broadcastPlugins(state, broadcast, plugins)
  return plugins
}

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

export { gracefulExitForRestart, requestRestart } from './paths.ts'
