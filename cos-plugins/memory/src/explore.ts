// @diver/memory — Explore 执行面（设计 §7.4）。
//
// 控制面在壳（ExplorePolicy 裁决时机与词）；本模块只做：
// - pickTerms()：从长期记忆只读挑候选词
// - explore(term)：联网检索+摘要（@diver/web-tools）→ 写回记忆卡片
// - job 管理：单飞 + cancel（USER_CHAT 打断经壳调 cancel）
//
// 不在此决定「何时 explore」——那是壳策略的事。

import { randomUUID } from 'node:crypto'
import type { MemoryStore, TopicRow } from './store-rpc.ts'
import {
  DEFAULT_POLICY,
  resolvePolicy,
  type PolicyOverrides,
} from '@diver/web-tools/policy'
import { exploreTerm, type ExploreResult } from '@diver/web-tools/explore'

export interface ExploreCandidate {
  id: string
  term: string
  score: number
  nTimes: number
  stateSummary: string
  reason: 'high_frequency' | 'recent' | 'uncertain'
}

export interface ExploreJobStatus {
  jobId: string
  term: string
  state: 'running' | 'done' | 'error' | 'cancelled'
  startedAt: number
  endedAt?: number
  error?: string
  result?: ExploreResult
  memoryId?: string
}

/** 从记忆挑探索候选：高频 / 近期 / 未确定概念。 */
export async function pickTerms(store: MemoryStore, limit = 5): Promise<ExploreCandidate[]> {
  const rows = await store.listTopics()
  const now = Date.now()
  const scored: ExploreCandidate[] = []
  for (const row of rows) {
    if (row.demotedAt) continue
    const term = (row.canonicalName ?? '').trim()
    if (term.length < 2 || term.length > 40) continue
    // 过滤纯寒暄/元话题
    if (/^(会话|闲聊|日常|寒暄|身份|探索)/.test(term)) continue

    const recency = Math.max(0, 1 - (now - row.lastDiscussedAt) / (30 * 24 * 3600_000))
    let reason: ExploreCandidate['reason'] = 'high_frequency'
    let score = row.weight * (1 + Math.min(row.nTimes, 10) * 0.1) * (0.4 + 0.6 * recency)
    if (row.uncertain) {
      reason = 'uncertain'
      score *= 1.3
    } else if (recency > 0.7) {
      reason = 'recent'
      score *= 1.1
    }
    if (row.nTimes < 2 && !row.uncertain) continue
    scored.push({
      id: row.id,
      term,
      score,
      nTimes: row.nTimes,
      stateSummary: (row.stateSummary ?? '').slice(0, 120),
      reason,
    })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

export class ExploreJobManager {
  private jobs = new Map<string, ExploreJobStatus>()
  private controllers = new Map<string, AbortController>()
  private running: string | null = null

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
    return true
  }

  /** 启动探索 job；同时只允许一个（Solitary 叶语义）。 */
  start(
    store: MemoryStore,
    input: {
      term: string
      reason?: string
      fromMemoryId?: string
      hint?: string
      policy?: PolicyOverrides
    },
  ): ExploreJobStatus {
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
    input: {
      term: string
      reason?: string
      fromMemoryId?: string
      hint?: string
      policy?: PolicyOverrides
    },
  ): Promise<void> {
    try {
      const policy = resolvePolicy(DEFAULT_POLICY, input.policy)
      const result = await exploreTerm(input.term, policy, {
        ...input.policy,
        ...(input.hint ? { hint: input.hint } : {}),
        ...(input.fromMemoryId ? {} : {}),
        signal,
      })
      if (signal.aborted) {
        job.state = 'cancelled'
        job.endedAt = Date.now()
        return
      }
      job.result = result
      // L3 写回：外部视角卡片 + 链到原记忆（设计：探索路径不写，结束时由 memory 写）
      const note = [
        `【外部探索】${result.term}`,
        input.reason ? `触发：${input.reason}` : '',
        input.fromMemoryId ? `关联记忆：${input.fromMemoryId}` : '',
        '',
        result.summary.slice(0, 1500),
      ]
        .filter((s) => s !== '')
        .join('\n')
      const memoryId = await store.remember({
        content: note,
        topic: `探索:${result.term}`.slice(0, 40),
      })
      job.memoryId = memoryId
      job.state = 'done'
      job.endedAt = Date.now()
    } catch (error) {
      if (signal.aborted) {
        job.state = 'cancelled'
      } else {
        job.state = 'error'
        job.error = (error as Error)?.message ?? String(error)
      }
      job.endedAt = Date.now()
    }
  }
}

/** 进程内单例 job 管理器（backend / 壳 RPC 共用）。 */
export const exploreJobs = new ExploreJobManager()

export type { TopicRow, ExploreResult }
