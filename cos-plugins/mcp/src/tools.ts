// @diver/mcp — 工具桥：发现 MCP server 的工具、以 mcp__<serverName>__<rawName>
// 命名注册进 ctx.tools、转发 tools/call、把 MCP 结果渲染成文本。
//
// 与 DSH 上游 @deepseek-ai/dsh-mcp-client/tools.ts 对齐（publicToolName 命名、
// 分页拉取、两阶段 swap、内容块提取），但适配 @cos/tools 极简注册表：
// executor 返回 { content: string }，无结构化输出/附件投影（diver 单会话文本陪伴）。

import { createHash } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/sdk/client'
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types'
import type { Context } from 'cordis'

/** 每个 MCP 工具的模型面公共名：mcp__<serverName>__<rawName>。 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= 64) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 64 - 12 - 1)}_${hash}`
}

/** 规范的 MCP 结果（保留协议块）。 */
export type McpResult = {
  content: unknown[]
  structuredContent?: unknown
}

/** 一次同步的注册 disposer 集合：publicName → 注销函数。 */
export type ToolDisposers = Map<string, () => void>

/** 桥接选项。 */
export interface ToolBridgeOptions {
  serverName: string
  toolCallTimeoutMs: number
}

/** 宽松的内容块形状：MCP 是网络信任边界，必填字段可能运行时缺失。 */
interface McpContentBlock {
  type?: string
  text?: string
  mimeType?: string
  data?: string
  name?: string
  uri?: string
}

/** 把 MCP content 数组渲染成模型可见文本（text 连接、image/resource 占位）。 */
function extractText(mcpContent: unknown[], toolName: string): string {
  const parts: string[] = []
  let sawBlock = false
  for (const value of mcpContent) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      parts.push('[unsupported MCP content block: expected an object]')
      sawBlock = true
      continue
    }
    const block = value as McpContentBlock
    switch (block.type) {
      case 'text':
        if (block.text !== undefined) { parts.push(block.text); sawBlock = true }
        break
      case 'image':
        parts.push(`[image unavailable: ${block.mimeType ?? 'unknown media type'}; raw image data remains available to programmatic callers]`)
        sawBlock = true
        break
      case 'resource_link':
        parts.push(block.name !== undefined && block.uri !== undefined
          ? `Resource link: ${block.name} (${block.uri})`
          : '[resource link unavailable: the MCP block is missing its name or URI]')
        sawBlock = true
        break
      case 'audio':
        parts.push(`[audio result unsupported: ${block.mimeType ?? 'unknown media type'}]`)
        sawBlock = true
        break
      case 'resource':
        parts.push('[embedded resource unsupported; raw resource data remains available to programmatic callers]')
        sawBlock = true
        break
      default:
        parts.push(`[unsupported MCP content type: ${block.type ?? '(missing)'}]`)
        sawBlock = true
    }
  }
  if (!sawBlock) return `(${toolName} returned no model-visible content)`
  return parts.join('\n')
}

/**
 * 同步 MCP server 的工具列表进 ctx.tools。
 * 两阶段：先分页拉取并构建全部定义（失败不动注册表），再 swap（注销旧代、注册新代）。
 * 注册冲突回滚整个 generation，避免半套工具。
 */
export async function syncTools(
  client: Client,
  ctx: Context,
  opts: ToolBridgeOptions,
  previous: ToolDisposers,
): Promise<ToolDisposers> {
  // Phase 1: 拉取全部工具定义（不触碰注册表）。
  const definitions = new Map<string, { rawName: string; description: string; parameters: Record<string, unknown> }>()
  let cursor: string | undefined
  do {
    const response = await client.request(
      { method: 'tools/list', ...cursor === undefined ? {} : { params: { cursor } } },
      ListToolsResultSchema,
    )
    for (const tool of response.tools) {
      const publicName = publicToolName(opts.serverName, tool.name)
      if (definitions.has(publicName)) {
        throw new Error(
          `mcp(${opts.serverName}): server listed tool "${tool.name}" more than once — invalid tool list`,
        )
      }
      definitions.set(publicName, {
        rawName: tool.name,
        description: tool.description ?? '',
        parameters: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      })
    }
    cursor = response.nextCursor
  } while (cursor)

  // Phase 2: swap——注销旧代，注册新代。
  for (const dispose of previous.values()) dispose()
  const disposers: ToolDisposers = new Map()
  try {
    for (const [publicName, definition] of definitions) {
      const executor = async (args: unknown, signal: AbortSignal) => {
        // 模型参数通常是对象；非对象归一为 {}，让 MCP server 报具体的缺参错误。
        const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
        const result = await client.request(
          { method: 'tools/call', params: { name: definition.rawName, arguments: argsObj } },
          CallToolResultSchema,
          { signal, timeout: opts.toolCallTimeoutMs },
        )
        // 归一化 content 数组。
        const content = Array.isArray(result.content) ? result.content : []
        const text = extractText(content, definition.rawName)
        if (result.isError === true) throw new Error(text)
        return { content: text }
      }
      disposers.set(publicName, ctx.tools.register(publicName, executor, {
        description: definition.description,
        parameters: definition.parameters,
      }))
    }
  } catch (error) {
    // 冲突：回滚整个 generation，模型看到要么全套要么没有。
    for (const dispose of disposers.values()) dispose()
    ctx.logger.error(`mcp(${opts.serverName}): tool registration failed, no tools registered: ${String(error)}`)
    return new Map()
  }
  return disposers
}
