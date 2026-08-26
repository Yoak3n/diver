// @diver/mcp — MCP 配置文件（registry 模式）读写与格式校验。
//
// diver 的 MCP server 列表由外层程序（Tauri 壳）直接维护一个 JSON 文件，
// 而不是硬编码在 cordis.patch.yml 里。registry 插件实例从这个文件读取
// server 列表、逐个启动连接；UI 直接编辑同一文件即可增删 MCP server。
//
// 文件路径解析优先级：
//   1. DIVER_MCP_CONFIG_FILE 环境变量（Tauri 壳注入，绝对路径）
//   2. $COS_HOME/mcp-servers.json（sidecar 数据家园，与 diver-settings.json 同目录）
//   3. ./mcp-servers.json（cwd 兜底，e2e / 手动运行）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import type { StdioConfig } from './index.ts'

/** registry 配置文件的 JSON 形状：`{ servers: [ ... StdioConfig ] }`。 */
export interface McpConfigFile {
  servers: StdioConfig[]
}

/** 解析 registry 配置文件路径（相对 cwd / COS_HOME 解析）。 */
export function mcpConfigPath(): string {
  const env = process.env.DIVER_MCP_CONFIG_FILE
  if (env !== undefined && env !== '') return resolve(process.cwd(), env)
  const home = process.env.COS_HOME ?? join(process.cwd(), '.cos-home')
  return join(home, 'mcp-servers.json')
}

/** 读取 registry 配置文件为 server 列表（文件缺失/解析失败返回空列表）。 */
export function readMcpConfigFile(): StdioConfig[] {
  const file = mcpConfigPath()
  try {
    if (!existsSync(file)) return []
    const doc = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (typeof doc !== 'object' || doc === null) return []
    const servers = (doc as { servers?: unknown }).servers
    if (!Array.isArray(servers)) return []
    return servers.filter((s): s is StdioConfig => typeof s === 'object' && s !== null)
  } catch (err) {
    console.error(`[diver/mcp] 读取 MCP 配置文件失败（${file}）:`, err)
    return []
  }
}

/** 写入 registry 配置文件（保持缩进与稳定顺序）。 */
export function writeMcpConfigFile(servers: StdioConfig[]): boolean {
  const file = mcpConfigPath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    const doc: McpConfigFile = { servers }
    writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    return true
  } catch (err) {
    console.error(`[diver/mcp] 写入 MCP 配置文件失败（${file}）:`, err)
    return false
  }
}

/** 校验单个 server 配置（与插件 resolveConfig 对齐的必需字段）。 */
export function validateServerConfig(raw: StdioConfig): string | undefined {
  if (raw.transport !== 'stdio') return `transport 仅支持 "stdio"（实际: ${String(raw.transport)}）`
  if (typeof raw.serverName !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(raw.serverName)) {
    return `serverName "${String(raw.serverName)}" 必须匹配 /^[A-Za-z0-9_-]{1,32}$/`
  }
  if (typeof raw.command !== 'string' || raw.command.trim() === '') return 'command 不能为空'
  return undefined
}
