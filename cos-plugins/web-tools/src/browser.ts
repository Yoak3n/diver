/**
 * 可选 bladebro 浏览器读页兜底（CLI，不走 CDP 绑定）。
 *
 * HTTP + findMain/toMd 对百科/专栏类反爬壳页常只剩站名；此时若本机有
 * `bladebro`（参考 E:\GitVault\bladebro / npm i -g bladebro），用
 * `bladebro see content <url> --json` 取 clean markdown。
 *
 * 可控性：
 * - 仅在 HTTP 抽取过薄或 HTTP 失败时启用（policy.browserFallback）
 * - 仍受 timeoutMs / maxCharsPerPage 约束
 * - 无 bladebro 二进制则静默跳过，不拖垮 explore
 */

import { spawn } from 'node:child_process'
import type { WebPolicy } from './policy.ts'

export interface BrowserReadResult {
  title: string
  markdown: string
  via: 'bladebro'
}

function bladebroCommand(): string | null {
  const fromEnv = process.env.BLADEBRO_PATH?.trim()
  if (fromEnv) return fromEnv
  // PATH 上的 bladebro；Windows 下 spawn 会走 PATHEXT。
  return 'bladebro'
}

function runBladebro(args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const cmd = bladebroCommand()
    if (!cmd) {
      resolve({ ok: false, stdout: '', stderr: 'BLADEBRO_PATH empty' })
      return
    }
    // Windows: npm 全局是 bladebro.cmd/.ps1，裸 spawn 找不到，需 shell；
    // shell:true 时必须拼单串命令，避免 DEP0190（args 数组不转义）。
    const useShell = process.platform === 'win32'
    const commandLine = [cmd, ...args.map((a) => (/[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))].join(' ')
    const child = useShell
      ? spawn(commandLine, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          timeout: timeoutMs,
          shell: true,
        })
      : spawn(cmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          timeout: timeoutMs,
        })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (err) => {
      resolve({ ok: false, stdout, stderr: err.message })
    })
    child.on('close', (code) => {
      resolve({ ok: code === 0, stdout, stderr })
    })
  })
}

/** 用 bladebro 读一页正文；失败返回 null（调用方回落 snippet）。 */
export async function bladebroRead(url: string, policy: WebPolicy): Promise<BrowserReadResult | null> {
  try {
    const probe = await runBladebro(['--version'], 3_000)
    if (!probe.ok && /ENOENT|not recognized|not found/i.test(probe.stderr + probe.stdout)) {
      return null
    }
  } catch {
    return null
  }

  // see content：clean markdown；--json 结构 { ok, text, image, is_error }。
  const res = await runBladebro(
    ['see', 'content', url, '--json', '--no-daemon'],
    Math.min(policy.timeoutMs + 20_000, 90_000),
  )
  if (!res.ok && res.stdout.trim().length === 0) return null

  let text = res.stdout
  try {
    const parsed = JSON.parse(res.stdout) as { ok?: boolean; text?: string; is_error?: boolean }
    if (parsed.is_error) return null
    if (typeof parsed.text === 'string') text = parsed.text
  } catch {
    // 非 JSON 时把 stdout 当 markdown。
  }
  const markdown = text.slice(0, policy.maxCharsPerPage)
  if (markdown.replace(/\s+/g, '').length < 40) return null
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? url
  return { title, markdown, via: 'bladebro' }
}

export function bladebroLikelyAvailable(): boolean {
  return Boolean(process.env.BLADEBRO_PATH?.trim()) || true
}
