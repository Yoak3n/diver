// @diver/mcp — 连接 supervisor：维护一个 MCP server 的 client/transport 代际，
// 保持 ctx.tools 与当前代际同步，断线时按指数退避重连。
//
// 移植自 DSH 上游 @deepseek-ai/dsh-mcp-client/connection.ts，去掉对
// @deepseek-ai/dsh-timeout 的依赖（直接用常量），其余机制对齐。

import { Client } from '@modelcontextprotocol/sdk/client'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Context } from 'cordis'
import { createTransport } from './transport.ts'
import { syncTools } from './tools.ts'
import type { ToolBridgeOptions, ToolDisposers } from './tools.ts'
import type { StdioConfig } from './index.ts'

/** 重连配置。 */
export interface ReconnectConfig {
  enabled?: boolean
  initialDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
}

export const RECONNECT_DEFAULTS: Required<ReconnectConfig> = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
})

/** 一次断线共享一个尝试预算；超过 maxAttempts 放弃并注销工具。 */
export type ResolvedReconnectPolicy = Readonly<Required<ReconnectConfig>>

export function resolveReconnectPolicy(config: ReconnectConfig | undefined, path: string): ResolvedReconnectPolicy {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) throw new Error(`${path}.${key} is not a reconnect option`)
    }
  }
  const enabled = config?.enabled ?? RECONNECT_DEFAULTS.enabled
  const initialDelayMs = config?.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs
  const maxDelayMs = config?.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs
  const maxAttempts = config?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts
  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0) throw new Error(`${path}.initialDelayMs must be a positive finite number`)
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0) throw new Error(`${path}.maxDelayMs must be a positive finite number`)
  if (initialDelayMs > maxDelayMs) throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error(`${path}.maxAttempts must be a positive integer`)
  return Object.freeze({ enabled, initialDelayMs, maxDelayMs, maxAttempts })
}

/** 启动结果（供 apply 决定是否 failOnStartupError）。 */
export interface ConnectionOutcome {
  error?: unknown
}

/** 一个插件实例的连接句柄。 */
export interface ConnectionHandle {
  ready: Promise<ConnectionOutcome>
  dispose(): Promise<void>
}

/** stdio transport 的关闭宽限期（秒）。 */
const GENERATION_CLOSE_TIMEOUT_MS = 5_000

/**
 * 启动一个 MCP server 的受控连接并保持存活。
 * 初始连接 + 工具同步在 activation 前完成（apply await ready）；
 * 断线按指数退避重连；dispose 停止重连、关闭 client、注销工具。
 */
export function startConnection(ctx: Context, config: StdioConfig, policy: ResolvedReconnectPolicy): ConnectionHandle {
  const label = `mcp(${config.serverName})`
  const opts: ToolBridgeOptions = {
    serverName: config.serverName,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
  }

  let disposed = false
  let client: Client | undefined
  let clientClosed: Promise<void> | undefined
  let disposers: ToolDisposers = new Map()
  let reconnectTimer: NodeJS.Timeout | undefined
  let failedAttempts = 0
  let connectedAt: number | undefined
  let firstAttemptError: unknown

  const isCurrent = (generation: Client): boolean => !disposed && client === generation

  /** 串行化所有 syncTools 调用，避免两代 sync 交叠（双 dispose/泄漏）。 */
  let syncChain: Promise<void> = Promise.resolve()
  function enqueueSync(generation: Client): Promise<void> {
    const run = syncChain.then(async () => {
      if (!isCurrent(generation)) return
      disposers = await syncTools(generation, ctx, opts, disposers)
    })
    syncChain = run.catch(() => {})
    return run
  }

  function generationDown(generation: Client): void {
    if (!isCurrent(generation)) return
    client = undefined
    clientClosed = undefined
    scheduleReconnect()
  }

  function waitForClose(closed: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { resolve(false) }, GENERATION_CLOSE_TIMEOUT_MS)
      timeout.unref()
      void closed.then(() => {
        clearTimeout(timeout)
        resolve(true)
      })
    })
  }

  function scheduleReconnect(): void {
    const lostEstablishedConnection = connectedAt !== undefined
    if (!policy.enabled) {
      ctx.logger.error(`${label}: ${lostEstablishedConnection
        ? 'connection lost and reconnect is disabled — registered tools will fail until plugin reload or restart'
        : 'connection failed and reconnect is disabled — no tools were registered; reload the plugin or restart to connect'}`)
      return
    }
    if (connectedAt !== undefined && Date.now() - connectedAt >= policy.maxDelayMs) failedAttempts = 0
    connectedAt = undefined
    failedAttempts += 1
    if (failedAttempts > policy.maxAttempts) {
      syncChain = syncChain.then(() => {
        for (const dispose of disposers.values()) dispose()
        disposers = new Map()
      })
      ctx.logger.error(`${label}: giving up after ${policy.maxAttempts} consecutive failed reconnect attempts — tools unregistered; reload the plugin or restart to reconnect`)
      return
    }
    const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1))
    ctx.logger.warn(`${label}: ${lostEstablishedConnection ? 'connection lost; reconnecting' : 'connection failed; retrying'} in ${delayMs}ms (attempt ${failedAttempts}/${policy.maxAttempts})`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      settling = connectGeneration(false)
    }, delayMs)
    reconnectTimer.unref()
  }

  /** 一次连接尝试：新 transport + client，connect，排队初始 sync。永不 reject。 */
  async function connectGeneration(startup: boolean): Promise<void> {
    const generation = new Client(
      { name: 'diver-mcp-client', version: '0.1.0' },
      { capabilities: {} },
    )
    // 手动实现 Promise.withResolvers（兼容 es2022 lib）。
    let resolveClosed!: () => void
    const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
    let attemptSettled = false
    let closeObserved = false
    const hasClosed = (): boolean => closeObserved
    client = generation
    clientClosed = closed
    generation.onclose = () => {
      closeObserved = true
      resolveClosed()
      if (attemptSettled) generationDown(generation)
    }
    generation.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (!isCurrent(generation)) return
      ctx.logger.info(`${label}: tool list changed, re-syncing`)
      try {
        await enqueueSync(generation)
      } catch (error) {
        if (!disposed) ctx.logger.error(`${label}: tool re-sync failed: ${String(error)}`)
      }
    })
    try {
      await generation.connect(createTransport(config))
      if (hasClosed()) {
        attemptSettled = true
        generationDown(generation)
        return
      }
      await enqueueSync(generation)
    } catch (error) {
      if (firstAttemptError === undefined) firstAttemptError = error
      if (isCurrent(generation)) ctx.logger.warn(`${label}: connection attempt failed: ${String(error)}`)
      try { await generation.close() } catch { /* transport already gone */ }
      const quiesced = hasClosed() || await waitForClose(closed)
      attemptSettled = true
      if (!isCurrent(generation)) return
      if (!quiesced) {
        client = undefined
        clientClosed = undefined
        ctx.logger.error(`${label}: failed generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms — reconnect stopped to avoid overlapping server processes; reload the plugin or restart to retry`)
        return
      }
      generationDown(generation)
      return
    }
    attemptSettled = true
    if (hasClosed()) {
      generationDown(generation)
      return
    }
    if (!isCurrent(generation)) return
    connectedAt = Date.now()
    if (failedAttempts > 0) ctx.logger.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${policy.maxAttempts})`)
  }

  let settling = connectGeneration(true)

  const ready: Promise<ConnectionOutcome> = settling.then(() => {
    if (client !== undefined) return {}
    return { error: firstAttemptError ?? new Error(`${label}: initial connection failed`) }
  })

  return {
    ready,
    async dispose(): Promise<void> {
      disposed = true
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      const current = client
      const currentClosed = clientClosed
      client = undefined
      clientClosed = undefined
      if (current !== undefined) {
        try { await current.close() } catch { /* transport already gone */ }
        if (currentClosed !== undefined && !await waitForClose(currentClosed)) {
          ctx.logger.error(`${label}: generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms during disposal — server shutdown may be incomplete`)
        }
      }
      await settling
      await syncChain
      for (const dispose of disposers.values()) dispose()
      disposers = new Map()
    },
  }
}
