// @diver/memory — 好奇心运行时：取词调度 + 按需补货钩子。
//
// 调度很轻：首扫 30s（等 sidecar/记忆 RPC 就绪），之后每 30 分钟补一次货。
// 壳端 ExplorePolicy 每 45s 要候选；队列空时 pickTerms 会经 setCuriosityRefresh
// 触发一次 force 扫描（有 2 分钟地板），所以正常不会出现「无候选」空转。

import type { Context } from 'cordis'
// Load Cordis Context service-key declarations.
import type {} from '@cos/plugin-api'

import { setCuriosityRefresh } from './explore.ts'
import { refreshCuriositySources, type CuriositySourceConfig } from './curiosity-sources.ts'
import { refreshSubscriptions } from './curiosity-subscriptions.ts'
import { refreshPlatformFeeds } from './curiosity-platform.ts'
import type { PlatformRuntimeConfig } from './curiosity-platform-config.ts'
import { maybeReport } from './curiosity-report.ts'
import type { MemoryStore } from './store-rpc.ts'

export interface CuriosityRuntimeConfig extends CuriositySourceConfig, PlatformRuntimeConfig {
  /** 固定源订阅（GitHub releases；页面源可在 sources.json 自配）。 */
  subscriptions?: boolean
  extraRepos?: string
  /** 每两天主动汇报一次小发现。 */
  reportEnabled?: boolean
  reportEveryDays?: number
  reportMinItems?: number
}

const FIRST_SCAN_DELAY_MS = 30_000
const SCAN_INTERVAL_MS = 30 * 60_000

/** 挂载取词调度；关闭时只解绑钩子，不装定时器。 */
export function startCuriosity(ctx: Context, store: MemoryStore, config: CuriosityRuntimeConfig = {}): void {
  if (config.curiosityEnabled === false) {
    setCuriosityRefresh(null)
    console.log('[curiosity] 已关闭（设置 → 插件 → 记忆）')
    return
  }

  const scan = (force: boolean): Promise<number> =>
    refreshCuriositySources(store, config, force ? { force: true } : {})

  setCuriosityRefresh(async () => {
    await scan(true)
  })

  const run = () => {
    void (async () => {
      await scan(false)
      await refreshSubscriptions(store, config)
      await refreshPlatformFeeds(store, config)
      await maybeReport(store, config)
    })().catch((err: unknown) => {
      console.warn(`[curiosity] 取词/订阅/平台失败: ${(err as Error)?.message ?? String(err)}`)
    })
  }
  const first = setTimeout(run, FIRST_SCAN_DELAY_MS)
  const timer = setInterval(run, SCAN_INTERVAL_MS)

  ctx.effect(() => () => {
    clearTimeout(first)
    clearInterval(timer)
    setCuriosityRefresh(null)
  }, 'memory:curiosity')

  console.log(`[curiosity] 取词调度启动（首扫 ${FIRST_SCAN_DELAY_MS / 1000}s，之后 ${SCAN_INTERVAL_MS / 60_000}min）`)
}
