// @diver/mcp — registry 插件：从 MCP 配置文件读取 server 列表，为每个 server
// 动态挂载一个 mcp 插件实例；文件变更时热重载（停掉旧的、启动新的）。
//
// 与单实例模式（index.ts 的 apply，由 cordis.patch.yml 挂载）的区别：
// registry 模式的 server 列表不在 cordis 配置里，而在外层程序维护的
// mcp-servers.json（见 ./config-file.ts），因此 UI 编辑文件即生效。
//
// 挂载方式：对每个 server 用 ctx.plugin(apply, config) 动态挂载
// @diver/mcp 插件的单实例 apply（对象/函数插件，自带 inject: ['tools']），
// dispose 时逐个卸载。

import { mkdirSync } from 'node:fs'
import { watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { Context, Plugin } from 'cordis'

import { mcpConfigPath, readMcpConfigFile, validateServerConfig } from './config-file.ts'
import type { RegistryConfig, StdioConfig } from './index.ts'

export interface RegistryState {
  /** 当前已挂载的 serverName → 卸载函数。 */
  mounted: Map<string, () => Promise<void>>
  /** 最近一次配置变更/重载的状态（供 UI/日志诊断）。 */
  lastReloadAt: number
  lastError: string | undefined
}

/** 启动 registry：读取配置文件并挂载全部 server，监听文件变更热重载。 */
export function startRegistry(
  ctx: Context,
  apply: (ctx: Context, rawConfig: StdioConfig) => void,
  config?: RegistryConfig,
): RegistryState {
  const reloadDelayMs = config?.reloadDelayMs ?? 300
  const state: RegistryState = {
    mounted: new Map(),
    lastReloadAt: 0,
    lastError: undefined,
  }

  /** 单实例插件的对象形态（必须带 inject: ['tools']，裸函数会丢失注入）。 */
  const mountPlugin: Plugin.Object<StdioConfig> = {
    name: 'mcp',
    inject: ['tools'],
    apply,
  }

  // 串行化 sync：避免热重载期间并发 diff 竞态（in-flight 时新触发并入下一次）。
  let syncing = false
  let resyncRequested = false

  async function sync(): Promise<void> {
    if (syncing) {
      resyncRequested = true
      return
    }
    syncing = true
    try {
      await doSync()
      if (resyncRequested) {
        resyncRequested = false
        await doSync()
      }
    } finally {
      syncing = false
    }
  }

  async function doSync(): Promise<void> {
    const servers = readMcpConfigFile()

    // 校验：非法配置整批拒绝（保留现状），避免部分挂载造成歧义。
    for (const server of servers) {
      const err = validateServerConfig(server)
      if (err !== undefined) {
        state.lastError = `server "${String(server.serverName)}": ${err}`
        ctx.logger.error(`[diver/mcp] registry 配置校验失败: ${state.lastError}`)
        return
      }
    }

    // 计算差异：卸载已消失的，挂载新增的，跳过不变的。
    const next = new Set(servers.map((s) => s.serverName))
    for (const [name, dispose] of [...state.mounted]) {
      if (!next.has(name)) {
        state.mounted.delete(name)
        try {
          await dispose()
          ctx.logger.info(`[diver/mcp] 已卸载 server "${name}"`)
        } catch (err) {
          ctx.logger.error(`[diver/mcp] 卸载 server "${name}" 失败: ${String(err)}`)
        }
      }
    }

    for (const server of servers) {
      if (state.mounted.has(server.serverName)) continue
      try {
        const fiber = ctx.plugin(mountPlugin, { ...server })
        state.mounted.set(server.serverName, async () => {
          await fiber.dispose()
        })
        ctx.logger.info(`[diver/mcp] 已挂载 server "${server.serverName}" (${server.command})`)
      } catch (err) {
        ctx.logger.error(`[diver/mcp] 挂载 server "${server.serverName}" 失败: ${String(err)}`)
      }
    }

    state.lastReloadAt = Date.now()
    state.lastError = undefined
  }

  // 初始同步（不阻塞插件 activation：diver cordis 不等 async apply）。
  void sync().catch((err) => {
    ctx.logger.error(`[diver/mcp] registry 初始同步失败: ${String(err)}`)
  })

  // 监听配置文件所在目录（文件名过滤），文件不存在/被替换也能感知。
  // 防抖 300ms，避免编辑器多次保存触发多次重载。
  const dir = dirname(mcpConfigPath())
  const base = basename(mcpConfigPath())
  try {
    mkdirSync(dir, { recursive: true })
  } catch { /* 目录创建失败由 watch 兜底 */ }
  let timer: NodeJS.Timeout | undefined
  const watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
    if (filename !== base && filename !== null) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void sync().catch((err) => {
        ctx.logger.error(`[diver/mcp] registry 热重载失败: ${String(err)}`)
      })
    }, reloadDelayMs)
  })
  watcher.on('error', (err) => {
    ctx.logger.error(`[diver/mcp] registry 文件监听失败: ${String(err)}`)
  })

  // 插件卸载时：关 watcher、卸载全部 server。
  ctx.effect(() => {
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      watcher.close()
      for (const [name, dispose] of [...state.mounted]) {
        state.mounted.delete(name)
        void dispose().catch(() => {})
      }
    }
  }, 'mcp.registry')

  return state
}
