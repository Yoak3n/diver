// @diver/mcp — MCP client 桥插件：连接一个外部 MCP server（stdio transport），
// 把它的工具以 mcp__<serverName>__<rawName> 注册进 ctx.tools。
//
// 每个插件实例连接一个 server；cordis.yml 里挂多个实例连多个 server。
// 移植自 DSH 上游 @deepseek-ai/dsh-mcp-client（适配 @cos/tools 极简注册表，
// 仅 stdio transport，无附件/结构化输出投影）。

import type { Context, Plugin } from 'cordis'
import { resolveReconnectPolicy, startConnection } from './connection.ts'
import type { ReconnectConfig } from './connection.ts'
import { startRegistry } from './registry.ts'

export type { McpResult } from './tools.ts'
export type { ReconnectConfig, ResolvedReconnectPolicy } from './connection.ts'
export type { McpConfigFile } from './config-file.ts'
export { mcpConfigPath, readMcpConfigFile, writeMcpConfigFile, validateServerConfig } from './config-file.ts'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'mcp'

/** 本插件需要的服务。 */
export const inject = ['tools']

/** 单次 MCP 工具调用的默认超时（ms）。 */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** 合法 serverName（低于公共工具名预算）。 */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** 每个 app 的活 serverName 占用（按 ctx.root 隔离）。 */
const activeServerNames = new WeakMap<Context, Set<string>>()

/** stdio transport 配置。 */
export interface StdioConfig {
  transport: 'stdio'
  serverName: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  toolCallTimeoutMs: number
  reconnect?: ReconnectConfig
}

/** Registry 模式配置：从配置文件读取 server 列表（见 ./config-file.ts）。 */
export interface RegistryConfig {
  registry: true
  /** 热重载防抖（ms），默认 300。 */
  reloadDelayMs?: number
}

export type Config = StdioConfig | RegistryConfig

/** 判断是否 registry 模式（无配置或显式 registry: true）。 */
export function isRegistryConfig(raw: Config | undefined): raw is RegistryConfig {
  return raw === undefined || (typeof raw === 'object' && (raw as { registry?: unknown }).registry === true)
}

/** 校验 + 默认值归一（loader 无 schemastery，apply 里手动做）。 */
export function resolveConfig(raw: StdioConfig): StdioConfig {
  if (raw.transport !== 'stdio') throw new Error(`mcp: unsupported transport "${(raw as { transport?: string }).transport}"`)
  if (!SERVER_NAME_PATTERN.test(raw.serverName)) {
    throw new Error(`mcp: serverName "${raw.serverName}" must match ${SERVER_NAME_PATTERN}`)
  }
  if (raw.command.trim().length === 0) throw new Error('mcp: command must be a non-empty string')
  const toolCallTimeoutMs = raw.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
  if (!Number.isFinite(toolCallTimeoutMs) || toolCallTimeoutMs <= 0) {
    throw new Error('mcp: toolCallTimeoutMs must be a positive number')
  }
  return {
    transport: 'stdio',
    serverName: raw.serverName,
    command: raw.command,
    args: raw.args ?? [],
    env: raw.env ?? {},
    cwd: raw.cwd ?? '',
    toolCallTimeoutMs,
    ...raw.reconnect !== undefined ? { reconnect: raw.reconnect } : {},
  }
}

/**
 * Registry 形态的 MCP 插件：从配置文件（DIVER_MCP_CONFIG_FILE 或
 * $COS_HOME/mcp-servers.json）读取 server 列表并逐个挂载，文件变更时热重载。
 * 外层程序（Tauri 壳）直接维护该文件，UI 编辑即生效。
 * 通过 cordis.patch.yml 挂载：`- id: mcp-registry; name: '@diver/mcp'`
 * （loader 用命名空间的 apply；apply 内按 RegistryConfig 分发）。
 */
export const registry: Plugin.Object<RegistryConfig> = {
  name: 'mcp-registry',
  inject: ['tools'],
  apply(ctx: Context, config: RegistryConfig) {
    startRegistry(ctx, apply, config)
  },
}

export function apply(ctx: Context, rawConfig: Config): void {
  if (isRegistryConfig(rawConfig)) {
    startRegistry(ctx, apply, rawConfig)
    return
  }
  const config = resolveConfig(rawConfig as StdioConfig)
  const reconnect = resolveReconnectPolicy(config.reconnect, `mcp(${config.serverName}): reconnect`)

  // 保留 serverName 命名空间：重复即配置错误，加载即失败。
  ctx.effect(() => {
    let names = activeServerNames.get(ctx.root)
    if (!names) {
      names = new Set()
      activeServerNames.set(ctx.root, names)
    }
    if (names.has(config.serverName)) {
      throw new Error(
        `mcp: serverName "${config.serverName}" is already in use by another mcp instance — pick a unique serverName in cordis.yml`,
      )
    }
    names.add(config.serverName)
    return () => void names.delete(config.serverName)
  }, 'mcp.serverName')

  const connection = startConnection(ctx, config, reconnect)

  ctx.effect(() => {
    return () => connection.dispose()
  }, 'mcp.connection')

  // diver 的 cordis（4.0.0-rc.7）不等待 async apply 的返回值（与上游
  // @deepseek-ai/cordis fork 不同）。因此连接在后台进行：工具在连接 + 同步
  // 完成后自动注册到 ctx.tools，无需阻塞插件激活。
  void connection.ready.then((outcome) => {
    if (outcome.error !== undefined) {
      ctx.logger.error(`mcp(${config.serverName}): initial connection failed: ${String(outcome.error)}`)
    }
  })
}
