// @diver/backend — 插件磁盘语义：catalog / bundle insert / profile patch / 安装登记。
//
// 与壳端 Rust plugins 模块同一套磁盘语义：
// - mount：bundle cordis.patch.yml insert ∪ plugins 目录 ∪ catalog
// - 启停：profile cordis.patch.yml `disabled: true`（保留 insert 块）
// - profile 安装：diver-plugins.json + package.json + pnpm（见 plugin-install.ts）

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WebState } from './state.ts'
import { bundleDir, profileDir } from './paths.ts'

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

export interface CatalogEntry {
  id: string
  packageName?: string
  displayName?: string
  description?: string
  toggleable?: boolean
  defaultEnabled?: boolean
  advisory?: string
}

export interface ProfileRecord {
  id: string
  packageName: string
  spec: string
  kind: 'profile'
  bundle: boolean
  insertName?: string
}

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

export function catalog(): Map<string, CatalogEntry> {
  const dir = bundleDir()
  const map = new Map<string, CatalogEntry>()
  if (!dir) return map
  const file = readJson<{ plugins?: CatalogEntry[] }>(join(dir, 'plugins.json'))
  for (const entry of file?.plugins ?? []) map.set(entry.id, entry)
  return map
}

export function parseBundleInserts(): Array<{ id: string; name: string }> {
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

export function loadDisabledIds(profile = profileDir()): Set<string> {
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
export function saveDisabledIds(disabled: Map<string, string>, profile = profileDir()): void {
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

export function packagePresent(root: string | undefined, packageName: string): boolean {
  if (!root) return false
  const slash = packageName.lastIndexOf('/')
  const pkg = slash >= 0 ? packageName.slice(slash + 1) : packageName
  return existsSync(join(root, pkg, 'package.json'))
}

export function packageDir(root: string | undefined, packageName: string): string {
  if (!root) return packageName
  const slash = packageName.lastIndexOf('/')
  const pkg = slash >= 0 ? packageName.slice(slash + 1) : packageName
  return join(root, pkg)
}

export function readProfileRegistry(profile = profileDir()): ProfileRecord[] {
  return readJson<{ installed?: ProfileRecord[] }>(join(profile, 'diver-plugins.json'))?.installed ?? []
}

export function writeProfileRegistry(records: ProfileRecord[], profile = profileDir()): void {
  mkdirSync(profile, { recursive: true })
  writeFileSync(
    join(profile, 'diver-plugins.json'),
    JSON.stringify({ schemaVersion: 1, installed: records }, null, 2) + '\n',
    'utf8',
  )
}

/** 更新 WebState 插件缓存并经 SSE 广播变更。 */
export function broadcastPlugins(state: WebState, broadcast: (e: unknown) => void, plugins: PluginInfo[]): void {
  state.plugins = plugins
  broadcast({ type: 'plugin', action: 'changed', plugins })
}
