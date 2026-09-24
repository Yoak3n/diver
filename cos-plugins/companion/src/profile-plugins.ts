/**
 * Profile-installed plugin records (P4).
 *
 * Path: `$COS_HOME/profiles/<profile>/diver-plugins.json`
 * Bundled packages mount via `dsh.profile.bundles`; plain packages mount as
 * loader insert rows generated at boot from this file.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
export interface ProfilePluginRecord {
  /** Loader row id (insert id). */
  id: string
  /** npm package name (resolved after install). */
  packageName: string
  /** Original install spec (file: / git / registry). */
  spec: string
  /** Always `profile` (internal plugins are not listed here). */
  kind: 'profile'
  /** True when package.json declares dsh.bundle — mounts via profile bundles. */
  bundle: boolean
  /** Insert name when bundle=false (defaults to packageName). */
  insertName?: string
}

export interface ProfilePluginsFile {
  schemaVersion: number
  installed: ProfilePluginRecord[]
}

export function profilePluginsPath(profileDir: string): string {
  return join(profileDir, 'diver-plugins.json')
}

/** Read `$COS_HOME/profiles/<profile>/diver-plugins.json`. */
export function readProfilePlugins(profileDir: string): ProfilePluginsFile {
  const path = profilePluginsPath(profileDir)
  if (!existsSync(path)) return { schemaVersion: 1, installed: [] }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProfilePluginsFile>
    return {
      schemaVersion: raw.schemaVersion ?? 1,
      installed: Array.isArray(raw.installed) ? raw.installed : [],
    }
  } catch {
    return { schemaVersion: 1, installed: [] }
  }
}

/** Insert rows for non-bundle profile plugins (boot extraPatches). */
export function profilePluginInserts(profileDir: string): Array<{ id: string; name: string }> {
  return readProfilePlugins(profileDir)
    .installed
    .filter((p) => !p.bundle)
    .map((p) => ({ id: p.id, name: p.insertName ?? p.packageName }))
}
