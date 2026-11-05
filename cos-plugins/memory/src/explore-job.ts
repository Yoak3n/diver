// @diver/memory — Explore job 生命周期：单飞、cancel、claim/complete/release、落库。
//
// 控制面在壳；本模块是执行面的状态机：
// - 单飞：同一时刻只允许一个 job（壳 Solitary 叶语义）
// - cancel：USER_CHAT 打断，条目退回队列且不消耗重试次数
// - 失败：条目 release（attempts+1，3 次后 skipped）
// - 成功：LLM 提炼 → append/new topic → curiosity_complete

import { randomUUID } from 'node:crypto'
import type { MemoryStore } from './store-rpc.ts'
import { DEFAULT_POLICY, resolvePolicy } from '@diver/web-tools/policy'
import { exploreTerm, type ExploreResult } from '@diver/web-tools/explore'
import {
  extractiveDistill,
  landExploration,
  type Distilled,
  type ExplorationSummarizer,
} from './explore-land.ts'
import type { ExploreInput, ExploreJobStatus } from './explore-types.ts'

/** 订阅 payload → 与联网结果同形的卡片。 */
function payloadResult(term: string, payload: string): ExploreResult {
  return {
    term,
    query: term,
    hits: [],
    pages: [],
    totalChars: payload.length,
    budgetExhausted: false,
    summary: payload,
  }
}

export class ExploreJobManager {
  private jobs = new Map<string, ExploreJobStatus>()
  private controllers = new Map<string, AbortController>()
  private running: string | null = null
  /** 由插件 apply 注入（跟随当前模型）；null = 只用摘录式兜底。 */
  private summarizer: ExplorationSummarizer | null = null

  setSummarizer(fn: ExplorationSummarizer | null): void {
    this.summarizer = fn
  }

  private async distill(term: string, result: ExploreResult, source?: string): Promise<Distilled> {
    if (this.summarizer !== null) {
      try {
        const distilled = await this.summarizer({ term, result, ...(source ? { source } : {}) })
        if (distilled !== null) return distilled
      } catch (err) {
        console.warn(`[explore] 提炼失败，退回摘录: ${(err as Error)?.message ?? err}`)
      }
    }
    return extractiveDistill(term, result)
  }

  get activeJobId(): string | null {
    return this.running
  }

  status(jobId: string): ExploreJobStatus | undefined {
    return this.jobs.get(jobId)
  }

  list(): ExploreJobStatus[] {
    return [...this.jobs.values()].slice(-10)
  }

  /** 取消进行中任务（壳 USER_CHAT / 用户打断）。 */
  cancel(jobId?: string): boolean {
    const id = jobId ?? this.running
    if (!id) return false
    const ctrl = this.controllers.get(id)
    if (ctrl) ctrl.abort()
    const job = this.jobs.get(id)
    if (job && job.state === 'running') {
      job.state = 'cancelled'
      job.endedAt = Date.now()
    }
    if (this.running === id) this.running = null
    console.warn(`[explore] cancel → job ${id}`)
    return true
  }

  /** 启动探索 job；同时只允许一个（Solitary 叶语义）。 */
  start(store: MemoryStore, input: ExploreInput): ExploreJobStatus {
    if (this.running) {
      throw new Error(`EXPLORE_BUSY: job ${this.running} already running`)
    }
    const jobId = randomUUID()
    const controller = new AbortController()
    const job: ExploreJobStatus = {
      jobId,
      term: input.term,
      state: 'running',
      startedAt: Date.now(),
    }
    this.jobs.set(jobId, job)
    this.controllers.set(jobId, controller)
    this.running = jobId

    void this.run(store, job, controller.signal, input).finally(() => {
      this.controllers.delete(jobId)
      if (this.running === jobId) this.running = null
    })
    return job
  }

  private async run(
    store: MemoryStore,
    job: ExploreJobStatus,
    signal: AbortSignal,
    input: ExploreInput,
  ): Promise<void> {
    const started = Date.now()
    console.log(
      `[explore] job ${job.jobId} 开始 term=${input.term} reason=${input.reason ?? '-'}` +
        (input.fromMemoryId ? ` from=${input.fromMemoryId}` : '') +
        (input.fromCuriosityId ? ` curiosity=${input.fromCuriosityId}` : ''),
    )
    if (input.fromCuriosityId) {
      try {
        await store.curiosityClaim(input.fromCuriosityId)
      } catch (err) {
        console.warn(`[explore] claim 好奇心条目失败: ${(err as Error)?.message ?? err}`)
      }
    }
    try {
      // 订阅/平台条目自带已抓取正文：按 id 取回 payload 与 source，直接消费。
      let payload = input.payload
      let curiositySource: string | undefined
      if (input.fromCuriosityId) {
        try {
          const row = await store.curiosityGet(input.fromCuriosityId)
          curiositySource = row?.source
          if (payload === undefined || payload === '') payload = row?.payload || undefined
        } catch (err) {
          console.warn(`[explore] 读取条目 payload 失败: ${(err as Error)?.message ?? err}`)
        }
      }
      const result =
        payload !== undefined && payload !== ''
          ? payloadResult(input.term, payload)
          : await exploreTerm(input.term, resolvePolicy(DEFAULT_POLICY, input.policy), {
              ...input.policy,
              ...(input.hint ? { hint: input.hint } : {}),
              signal,
            })
      if (signal.aborted) {
        job.state = 'cancelled'
        job.endedAt = Date.now()
        await releaseCuriosity(store, input.fromCuriosityId, true)
        console.warn(`[explore] job ${job.jobId} 已取消（${Date.now() - started}ms）`)
        return
      }
      job.result = result
      console.log(
        `[explore] job ${job.jobId} 检索完成 hits=${result.hits.length} pages=${result.pages.length}` +
          ` chars=${result.totalChars}${result.budgetExhausted ? ' 预算耗尽' : ''}（${Date.now() - started}ms）`,
      )
      // L3 落地：LLM 提炼（失败退摘录）→ 追加/新建 topic → 标记队列条目完成。
      const distilled = await this.distill(result.term, result, curiositySource)
      const landed = await landExploration(store, {
        term: result.term,
        result,
        ...(input.fromMemoryId ? { fromMemoryId: input.fromMemoryId } : {}),
        ...(curiositySource ? { source: curiositySource } : {}),
        distilled,
      })
      job.memoryId = landed.topicId
      if (input.fromCuriosityId) {
        try {
          await store.curiosityComplete(input.fromCuriosityId, {
            topicId: landed.topicId,
            note: landed.oneLine,
            clearPayload: true,
          })
        } catch (err) {
          console.warn(`[explore] complete 好奇心条目失败: ${(err as Error)?.message ?? err}`)
        }
      }
      job.state = 'done'
      job.endedAt = Date.now()
      console.log(
        `[explore] job ${job.jobId} 落地 topic ${landed.topicId}：${landed.oneLine.slice(0, 40)}` +
          ` → done（总耗时 ${Date.now() - started}ms）`,
      )
    } catch (error) {
      await releaseCuriosity(store, input.fromCuriosityId)
      if (signal.aborted) {
        job.state = 'cancelled'
        console.warn(`[explore] job ${job.jobId} 已取消（${Date.now() - started}ms）`)
      } else {
        job.state = 'error'
        job.error = (error as Error)?.message ?? String(error)
        console.error(`[explore] job ${job.jobId} 失败: ${job.error}（${Date.now() - started}ms）`)
      }
      job.endedAt = Date.now()
    }
  }
}

async function releaseCuriosity(
  store: MemoryStore,
  id: string | undefined,
  resetAttempts = false,
): Promise<void> {
  if (!id) return
  try {
    await store.curiosityRelease(id, resetAttempts)
  } catch (err) {
    console.warn(`[explore] release 好奇心条目失败: ${(err as Error)?.message ?? err}`)
  }
}

/** 进程内单例 job 管理器（backend / 壳 RPC 共用）。 */
export const exploreJobs = new ExploreJobManager()
