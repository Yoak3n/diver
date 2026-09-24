// @diver/self-prompt — 路径与重启标志（纯路径/IO 助手，不依赖框架服务）。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 当前进程的 cos home（sidecar 启动时由 Rust 注入 COS_HOME）。 */
export function cosHome(): string {
  return process.env.COS_HOME ?? join(process.cwd(), '.cos-home')
}

/** 本插件包根目录（`src/` 的上一级）。 */
export function pluginRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

/** 插件自带默认 prompts（随包分发）。 */
export function bundledPromptDir(): string {
  return join(pluginRoot(), 'prompts')
}

/** 用户/模型可写覆盖层：同名文件覆盖 bundled。 */
export function overridePromptDir(): string {
  return join(cosHome(), 'self-prompt', 'prompts')
}

/** skill 源文件目录。 */
export function skillDir(): string {
  return join(pluginRoot(), 'skills')
}

/** 重启完成后待注入的系统事件标志。 */
export function restartPendingPath(): string {
  return join(cosHome(), 'self-prompt-restart.pending')
}

/** `$COS_HOME/restart.requested` — 壳监控到 sidecar 退出后自动再拉起。 */
export function restartFlagPath(): string {
  return join(cosHome(), 'restart.requested')
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

export interface RestartPending {
  at: string
  reason?: string
}

export function readRestartPending(): RestartPending | null {
  try {
    const raw = readFileSync(restartPendingPath(), 'utf8')
    const json = JSON.parse(raw) as RestartPending
    if (typeof json?.at === 'string') return json
  } catch {
    /* missing/corrupt → none */
  }
  return null
}

export function writeRestartPending(reason?: string): void {
  ensureDir(cosHome())
  writeFileSync(
    restartPendingPath(),
    JSON.stringify({ at: new Date().toISOString(), reason: reason ?? 'self-prompt' }, null, 2) + '\n',
    'utf8',
  )
}

export function clearRestartPending(): void {
  try {
    rmSync(restartPendingPath(), { force: true })
  } catch {
    /* ignore */
  }
}

/** 写壳侧重启标志（与 @diver/backend 的 restart.requested 同契约）。 */
export function writeRestartRequested(reason: string): void {
  ensureDir(cosHome())
  writeFileSync(
    restartFlagPath(),
    JSON.stringify({ at: new Date().toISOString(), reason }, null, 2) + '\n',
    'utf8',
  )
}

/** 发起本进程优雅退出（壳见 restart.requested 后重新 spawn）。 */
export function gracefulExitForRestart(): void {
  // 先让工具响应写出，再走 companion settle() 的 SIGTERM 路径。
  setTimeout(() => {
    process.kill(process.pid, 'SIGTERM')
  }, 80)
}

export function fileExists(path: string): boolean {
  return existsSync(path)
}
