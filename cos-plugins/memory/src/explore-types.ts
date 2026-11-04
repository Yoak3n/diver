// @diver/memory — Explore 领域类型（选词 / job / 输入）。

import type { ExploreResult } from '@diver/web-tools/explore'
import type { PolicyOverrides } from '@diver/web-tools/policy'

export interface ExploreCandidate {
  /** 关联的 memory topic id（没有则为空串）。 */
  id: string
  term: string
  score: number
  nTimes: number
  stateSummary: string
  reason: 'high_frequency' | 'recent' | 'uncertain' | 'curiosity' | 'subscription'
  /** 来自好奇心队列时的条目 id（壳端透传，侧车 claim 后消费）。 */
  curiosityId?: string
  /** 来源标注（chat:group:<id> / note:<scope> / …），仅日志用。 */
  source?: string
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

export interface ExploreInput {
  term: string
  reason?: string
  fromMemoryId?: string
  /** 好奇心队列条目 id：job 开始时 claim，结束 complete/release。 */
  fromCuriosityId?: string
  hint?: string
  /** 订阅条目的预抓取正文（有则跳过联网搜索/读页）。 */
  payload?: string
  policy?: PolicyOverrides
}

export type { ExploreResult }
