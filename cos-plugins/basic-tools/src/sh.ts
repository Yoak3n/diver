// @diver/basic-tools — sh 工具：执行一条 shell 命令（一次新进程）。
// Windows 用 powershell.exe（companion 宿主是 Windows），POSIX 用 sh -c。
// 无持久会话、无沙箱约束；支持 timeoutMs 与 workdir。

import { spawn } from 'node:child_process'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { Context } from 'cordis'

export interface ShCaps {
  workspaceRoot: string
  timeoutMs: number
}

interface ShArgs {
  command: string
  description?: string
  timeoutMs?: number
  workdir?: string
}

const MAX_OUTPUT_CHARS = 40_000

interface RunResult {
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  stdout: string
  stderr: string
}

function truncateTail(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false }
  return { text: `... (output truncated, showing last ${MAX_OUTPUT_CHARS} chars)\n${text.slice(-MAX_OUTPUT_CHARS)}`, truncated: true }
}

/** 执行一条命令，收集 stdout/stderr，支持超时与中止信号。 */
export function runCommand(
  command: string,
  options: { cwd?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<RunResult> {
  return new Promise<RunResult>((resolveResult) => {
    const isWin = process.platform === 'win32'
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
          cwd: options.cwd,
          windowsHide: true,
        })
      : spawn('/bin/sh', ['-c', command], { cwd: options.cwd })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (partial: Partial<RunResult>): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
      resolveResult({
        exitCode: null,
        timedOut: false,
        aborted: false,
        stdout,
        stderr,
        ...partial,
      })
    }

    const onAbort = (): void => {
      child.kill('SIGKILL')
      finish({ aborted: true })
    }
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ timedOut: true })
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error: Error) => finish({ stderr: `${stderr}\n[spawn error: ${error.message}]` }))
    child.on('close', (code) => finish({ exitCode: code }))
  })
}

/** 把一次运行渲染成模型可见文本（DSH 风格的 `[exit code: N]` 标记）。 */
export function formatShResult(result: RunResult): string {
  const stdout = truncateTail(result.stdout.trimEnd())
  const stderr = truncateTail(result.stderr.trimEnd())
  const parts: string[] = []
  if (stdout.text.length > 0) parts.push(stdout.text)
  if (stderr.text.length > 0) parts.push(`[stderr]\n${stderr.text}`)
  if (result.timedOut) {
    parts.push('[timed out]')
  } else if (result.aborted) {
    parts.push('[aborted]')
  } else {
    parts.push(result.exitCode === 0 ? '[exit code: 0]' : `[exit code: ${result.exitCode}]`)
  }
  return parts.join('\n')
}

/** 注册 sh 工具。 */
export function applyShTool(ctx: Context, caps: ShCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:sh',
    order: 103,
    text: 'Use the sh tool to run shell commands. Each call runs in a fresh process: no state (cwd, variables) persists between calls — pass workdir instead of relying on cd. Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on.',
  })

  ctx.tools.register('sh', async (args, signal) => {
    const a = args as ShArgs
    if (typeof a?.command !== 'string' || a.command.trim().length === 0) {
      throw new Error('command must be a non-empty string')
    }
    const timeoutMs = a.timeoutMs === undefined ? caps.timeoutMs : Number(a.timeoutMs)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive number')

    const cwd = a.workdir === undefined
      ? caps.workspaceRoot
      : isAbsolute(a.workdir)
        ? resolvePath(a.workdir)
        : resolvePath(caps.workspaceRoot, a.workdir)

    const result = await runCommand(a.command, { cwd, timeoutMs, signal })
    return { content: formatShResult(result) }
  }, {
    description: 'Execute a shell command and return its stdout/stderr. Each call runs in a fresh process (Windows: powershell.exe, POSIX: sh -c); pass workdir instead of cd. Non-zero exits are reported as `[exit code: N]`.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute.' },
        description: { type: 'string', description: 'Clear, concise description of what this command does in active voice, 5-10 words.' },
        timeoutMs: { type: 'number', description: `Timeout in milliseconds. Defaults to ${caps.timeoutMs}; the process is killed on expiry.` },
        workdir: { type: 'string', description: 'Working directory; relative paths resolve against the workspace root.' },
      },
      required: ['command'],
    },
  })
}
