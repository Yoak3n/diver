// @diver/backend — profile 插件安装/卸载：pnpm 进程 + 安装登记 + 失败回滚。
// 磁盘格式语义见 plugin-store.ts；装配面见 plugins.ts。

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WebState } from './state.ts'
import { SAFE_PROFILE, profileDir, readActiveProfile } from './paths.ts'
import {
  broadcastPlugins,
  readJson,
  readProfileRegistry,
  writeProfileRegistry,
} from './plugin-store.ts'
import type { PluginInfo } from './plugin-store.ts'
import { ensureProfile, listPlugins } from './plugins.ts'

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
