// @diver/backend — active profile + restart flag（通道收敛：状态在 COS_HOME）。
//
// 阶段 1 约定（docs/channels.md）：
// - 业务状态写在 $COS_HOME，壳与 sidecar 共读同一份文件
// - 重启：写 restart.requested → SIGTERM → 壳监控见标志后自动 spawn

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const COMPANION_PROFILE = 'companion'
export const SAFE_PROFILE = 'safe'

export function cosHome(): string {
  return process.env.COS_HOME ?? join(process.cwd(), '.cos-home')
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

/** `$COS_HOME/active-profile.json` */
export function activeProfilePath(): string {
  return join(cosHome(), 'active-profile.json')
}

export function readActiveProfile(): string {
  try {
    const raw = readFileSync(activeProfilePath(), 'utf8')
    const json = JSON.parse(raw) as { activeProfile?: string }
    const name = (json.activeProfile ?? '').trim()
    if (name === COMPANION_PROFILE || name === SAFE_PROFILE) return name
  } catch {
    /* missing/corrupt → default */
  }
  return COMPANION_PROFILE
}

export function writeActiveProfile(name: string): void {
  const n = name.trim()
  if (n !== COMPANION_PROFILE && n !== SAFE_PROFILE) {
    throw new Error(`未知 profile: ${name}（仅支持 companion / safe）`)
  }
  ensureDir(cosHome())
  writeFileSync(
    activeProfilePath(),
    JSON.stringify({ activeProfile: n }, null, 2) + '\n',
    'utf8',
  )
}

/** `$COS_HOME/restart.requested` — 壳监控到 sidecar 退出后读取并自动再启动。 */
export function restartFlagPath(): string {
  return join(cosHome(), 'restart.requested')
}

export function requestRestart(): void {
  ensureDir(cosHome())
  writeFileSync(
    restartFlagPath(),
    JSON.stringify({ at: new Date().toISOString(), reason: 'backend-api' }, null, 2) + '\n',
    'utf8',
  )
}

export function hasRestartFlag(): boolean {
  return existsSync(restartFlagPath())
}

export function clearRestartFlag(): void {
  try {
    rmSync(restartFlagPath(), { force: true })
  } catch {
    /* ignore */
  }
}

/** 发起本进程优雅退出（壳侧见 restart 标志后重新 spawn）。 */
export async function gracefulExitForRestart(): Promise<void> {
  requestRestart()
  // 先让 HTTP 响应写出，再走 companion settle() 的 SIGTERM 路径。
  setTimeout(() => {
    process.kill(process.pid, 'SIGTERM')
  }, 80)
}

export function bundleDir(): string | undefined {
  const env = process.env.DIVER_BUNDLE_DIR?.trim()
  if (env) return env
  // dev: cwd=harness → cos-plugins/bundle-companion；release: cwd=sidecar → bundles/…
  const candidates = [
    join(process.cwd(), 'cos-plugins', 'bundle-companion'),
    join(process.cwd(), '..', 'cos-plugins', 'bundle-companion'),
    join(process.cwd(), 'bundles', 'bundle-companion'),
    join(process.cwd(), '..', 'cos-plugins', 'bundle-companion'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'cordis.patch.yml'))) return dir
  }
  return undefined
}

export function pluginsRoot(): string | undefined {
  const env = process.env.DIVER_PLUGINS_ROOT?.trim()
  if (env) return env
  const candidates = [
    join(process.cwd(), 'cos-plugins'),
    join(process.cwd(), '..', 'cos-plugins'),
    join(process.cwd(), 'plugins'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'backend', 'package.json'))) return dir
  }
  return undefined
}

export function profileDir(name = readActiveProfile()): string {
  return join(cosHome(), 'profiles', name)
}
