// @diver/mcp — transport 工厂：stdio transport（spawn 子进程 + stdin/stdout JSON-RPC）。
//
// 与 DSH 上游 @deepseek-ai/dsh-mcp-client 的 transport.ts 对齐，但 diver 无
// subprocess seam（无环境清理服务），直接用 SDK 的 StdioClientTransport + 父进程
// 环境 + 显式 env 覆盖。stdin/stdout 由 SDK 的 transport 管理（MCP stdio 协议）。

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { StdioConfig } from './index.ts'

/**
 * 构造 stdio transport：command + args 直接传给 SDK（无 shell 层），env 为父进程
 * 环境 + 显式配置覆盖。cwd 可选（默认继承当前进程）。
 */
export function createTransport(config: StdioConfig): Transport {
  // 父进程环境（剔除 undefined 值）+ 显式配置覆盖。
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, config.env)
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env,
    cwd: config.cwd.length > 0 ? config.cwd : undefined,
  })
}
