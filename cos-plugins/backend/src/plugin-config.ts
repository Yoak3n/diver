// @diver/backend — plugin config for the settings page (Desktop model-config style).
//
// Discovery: each plugin module may `export const configDecl: PluginConfigDecl`.
// Persistence: profile `cordis.patch.yml` row `{ id, name, config }` (same layer
// as enable/disable). Values feed `apply(ctx, config)` after `restart_sidecar`.
//
//   GET  /api/plugins/config          → PluginConfigView[]
//   POST /api/plugins/config          → { ok, plugins }  (merge values, request restart)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { PluginConfigDecl, PluginConfigField } from '@cos/plugin-api'

import { bundleDir, cosHome, profileDir, pluginsRoot } from './paths.ts'

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

export interface PluginConfigFieldView extends PluginConfigField {
  /** Current effective value (stringified for form controls). */
  value?: string
  configured: boolean
}

export interface PluginConfigView {
  id: string
  packageName: string
  title?: string
  hasConfig: boolean
  fields: PluginConfigFieldView[]
}

const declCache = new Map<string, PluginConfigDecl | null>()

function packageNameOf(id: string): string | undefined {
  // Prefer bundle insert name, then plugins.json catalog, then plugin dir name.
  const bundle = bundleDir()
  if (bundle !== undefined) {
    const patch = join(bundle, 'cordis.patch.yml')
    if (existsSync(patch)) {
      try {
        const doc = parseYaml(readFileSync(patch, 'utf8')) as Array<{ insert?: Array<{ id?: string; name?: string }> }>
        for (const row of doc) {
          for (const entry of row.insert ?? []) {
            if (entry.id === id && typeof entry.name === 'string') return entry.name
          }
        }
      } catch {
        // fall through
      }
    }
  }
  const catalogPath = bundle === undefined ? undefined : join(bundle, 'plugins.json')
  if (catalogPath !== undefined && existsSync(catalogPath)) {
    const catalog = readJson<{ plugins?: Array<{ id?: string; packageName?: string }> }>(catalogPath)
    for (const plugin of catalog?.plugins ?? []) {
      if (plugin.id === id && typeof plugin.packageName === 'string') return plugin.packageName
    }
  }
  return `@diver/${id}`
}

async function loadConfigDecl(id: string, packageName: string): Promise<PluginConfigDecl | null> {
  if (declCache.has(id)) return declCache.get(id) ?? null
  let decl: PluginConfigDecl | null = null
  const roots = [pluginsRoot(), join(cosHome(), 'profiles', 'node_modules')]
    .filter((root): root is string => typeof root === 'string')
  for (const root of roots) {
    const main = join(root, ...packageName.split('/'), 'package.json')
    // pluginsRoot is the parent of plugin packages: <pluginsRoot>/<name>/
    // packageName `@diver/memory` → <pluginsRoot>/memory for open plugins dir layout.
    const shortName = packageName.includes('/') ? packageName.split('/').pop()! : packageName
    const candidates = [
      join(root, shortName, 'package.json'),
      join(root, ...packageName.split('/'), 'package.json'),
    ]
    for (const manifestPath of candidates) {
      if (!existsSync(manifestPath)) continue
      try {
        const manifest = readJson<{ main?: string }>(manifestPath)
        const entry = manifest?.main ?? 'src/index.ts'
        const entryPath = join(dirname(manifestPath), entry)
        const mod = (await import(pathToFileURL(entryPath).href)) as {
          configDecl?: PluginConfigDecl
          pluginConfig?: () => PluginConfigDecl
        }
        const found = typeof mod.pluginConfig === 'function' ? mod.pluginConfig() : mod.configDecl
        if (found && Array.isArray(found.fields)) {
          decl = { title: found.title, fields: found.fields }
          break
        }
      } catch {
        // module load failed — treat as no form
      }
    }
    if (decl !== null) break
  }
  declCache.set(id, decl)
  return decl
}

type PatchRow = { id?: string; name?: string; disabled?: boolean; config?: Record<string, unknown> }

function profilePatchPath(): string {
  return join(profileDir(), 'cordis.patch.yml')
}

function readPatchRows(): PatchRow[] {
  const file = profilePatchPath()
  if (!existsSync(file)) return []
  try {
    const doc = parseYaml(readFileSync(file, 'utf8'))
    return Array.isArray(doc) ? (doc as PatchRow[]) : []
  } catch {
    return []
  }
}

function writePatchRows(rows: PatchRow[]): void {
  const file = profilePatchPath()
  mkdirSync(dirname(file), { recursive: true })
  const body = rows.length === 0 ? '[]\n' : stringifyYaml(rows)
  writeFileSync(file, body, 'utf8')
}

/** Effective config for one plugin id from the profile patch layer. */
export function readPluginConfigValues(id: string): Record<string, unknown> {
  const row = readPatchRows().find((r) => r.id === id)
  return { ...(row?.config ?? {}) }
}

/** Merge values into the profile patch row for `id` (creates the row when needed). */
export function writePluginConfigValues(
  id: string,
  packageName: string,
  values: Record<string, string | number | boolean | null>,
): Record<string, unknown> {
  const rows = readPatchRows()
  let row = rows.find((r) => r.id === id)
  if (row === undefined) {
    row = { id, name: packageName, config: {} }
    rows.push(row)
  }
  const config = { ...(row.config ?? {}) }
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === '') {
      delete config[key]
    } else {
      config[key] = value
    }
  }
  row.config = config
  writePatchRows(rows)
  return config
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

export async function listPluginConfigs(): Promise<PluginConfigView[]> {
  const ids = new Set<string>()
  const bundle = bundleDir()
  if (bundle !== undefined) {
    const patch = join(bundle, 'cordis.patch.yml')
    if (existsSync(patch)) {
      try {
        const doc = parseYaml(readFileSync(patch, 'utf8')) as Array<{ insert?: Array<{ id?: string }> }>
        for (const row of doc) {
          for (const entry of row.insert ?? []) {
            if (typeof entry.id === 'string') ids.add(entry.id)
          }
        }
      } catch {
        // ignore
      }
    }
  }
  const root = pluginsRoot()
  if (root !== undefined && existsSync(root)) {
    // open plugin dir layout: <root>/<name>
    try {
      const { readdirSync } = await import('node:fs')
      for (const name of readdirSync(root)) {
        if (name.startsWith('.') || name === 'bundle-companion') continue
        if (existsSync(join(root, name, 'package.json'))) ids.add(name)
      }
    } catch {
      // ignore
    }
  }

  const out: PluginConfigView[] = []
  for (const id of [...ids].sort()) {
    const packageName = packageNameOf(id) ?? id
    const decl = await loadConfigDecl(id, packageName)
    const current = readPluginConfigValues(id)
    const fields = (decl?.fields ?? []).map((field) => {
      const raw = current[field.key] ?? field.default
      return {
        ...field,
        value: field.secret === true ? undefined : stringifyValue(raw),
        configured: current[field.key] !== undefined || field.default !== undefined,
      }
    })
    out.push({
      id,
      packageName,
      title: decl?.title,
      hasConfig: (decl?.fields.length ?? 0) > 0,
      fields,
    })
  }
  return out
}

export async function savePluginConfig(
  id: string,
  values: Record<string, string | number | boolean | null>,
): Promise<{ ok: true; config: Record<string, unknown> }> {
  const packageName = packageNameOf(id) ?? id
  const config = writePluginConfigValues(id, packageName, values)
  return { ok: true, config }
}
