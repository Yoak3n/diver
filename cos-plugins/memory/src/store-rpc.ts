// @diver/memory — 存储层客户端（Rust SQLite 后端）。
//
// 数据源是 crates/diver-memory 暴露的本地 HTTP RPC：
// - 读取/确定性逻辑：blocking candidates、decay、stats 等由 Rust 按需执行
// - 本模块维护一份视图缓存，供 system prompt section 的同步 provider 使用
//   （section text 只允许同步返回字符串）

import { nativeRpc } from '@diver/native-bridge/rpc'

export const DECAY = {
  episodic: { rate: 0.05, forget: 0.02 },
  trivia: { rate: 0.15, forget: 0.1 },
} as const

export interface TopicRow {
  id: string
  canonicalName: string
  aliases: string[]
  stateSummary: string
  weight: number
  tier: 'episodic' | 'trivia'
  activationCount: number
  createdAt: number
  lastDiscussedAt: number
  nTimes: number
  uncertain: boolean
  demotedAt?: number
  demotedReason?: string
}

export interface MemoryEvent {
  seq: number
  topicId: string
  statement: string
  ts: number
  episodeId?: string
}

export interface RelationCard {
  profile: string
  agent_model: string
  relationship: string
  updatedAt: number
}

export interface PromiseRow {
  id: string
  content: string
  status: 'open' | 'done' | 'expired'
  createdAt: number
  dueAt?: number
  updatedAt?: number
}

export interface SelfAction {
  id: string
  kind: string
  content: string
  topicId?: string
  ts: number
}

export type Tier = keyof typeof DECAY

export interface Snapshot {
  card: RelationCard
  topics: TopicRow[]
  promises: PromiseRow[]
  events: MemoryEvent[]
}

export interface MemoryStats {
  total: number
  byTier: Record<string, number>
  top: Array<{ name: string; nTimes: number }>
  events: number
  openPromises: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const SNAPSHOT_LIMIT = 200

async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return nativeRpc<T>(method, params, { label: `memory:${method}` })
}

const EMPTY_CARD: RelationCard = { profile: '', agent_model: '', relationship: '', updatedAt: 0 }

export class MemoryStore {
  readonly dirty = false

  private view: Snapshot = { card: { ...EMPTY_CARD }, topics: [], promises: [], events: [] }

  constructor(_root: string) {
    void this.refresh()
  }

  /** 拉取分页快照，刷新同步视图缓存（topics/events 只取最近 N 条）。 */
  async refresh(): Promise<void> {
    try {
      this.view = await rpc<Snapshot>('snapshot', { limit: SNAPSHOT_LIMIT })
    } catch (err) {
      console.warn(`[memory] 拉取快照失败: ${(err as Error)?.message ?? err}`)
    }
  }

  // 之前 JSON 文件版的节流持久化已由 Rust 后端接管。
  save(): void { }
  markDirty(): void { }

  // 衰减/遗忘由 Rust 在读取 topics 相关数据时懒执行。
  decayAll(): void { }

  // ───────────────────────── 同步视图（section / stats 用） ─────────────────────────

  getCard(): RelationCard {
    return this.view.card
  }

  listPromises(status?: PromiseRow['status']): PromiseRow[] {
    return this.view.promises.filter((p) => !status || p.status === status)
  }

  todayEvents(): MemoryEvent[] {
    const start = Date.now() - DAY_MS
    return this.view.events.filter((e) => e.ts >= start)
  }

  recentEpisodes(days = 14, limit = 4): TopicRow[] {
    const cutoff = Date.now() - days * DAY_MS
    return this.view.topics
      .filter((t) => t.tier === 'episodic' && t.lastDiscussedAt >= cutoff)
      .sort((a, b) => b.lastDiscussedAt - a.lastDiscussedAt)
      .slice(0, limit)
  }

  async stats(): Promise<MemoryStats> {
    try {
      return await rpc<MemoryStats>('stats')
    } catch (err) {
      console.warn(`[memory] 拉取 stats 失败，回退视图缓存: ${(err as Error)?.message ?? err}`)
    }
    const rows = this.view.topics
    const byTier: Record<string, number> = { episodic: 0, trivia: 0 }
    for (const r of rows) byTier[r.tier] = (byTier[r.tier] ?? 0) + 1
    const top = [...rows].sort((a, b) => b.nTimes - a.nTimes).slice(0, 5)
      .map((r) => ({ name: r.canonicalName, nTimes: r.nTimes }))
    return { total: rows.length, byTier, top, events: this.view.events.length, openPromises: this.listPromises('open').length }
  }

  // ───────────────────────── topics（RPC） ─────────────────────────

  async listTopics(): Promise<TopicRow[]> {
    return rpc<TopicRow[]>('list_topics')
  }

  async getTopic(id: string): Promise<TopicRow | undefined> {
    const row = await rpc<TopicRow | null>('get_topic', { id })
    return row ?? undefined
  }

  async blockingCandidates(text: string, limit = 5): Promise<Array<TopicRow & { matched: string }>> {
    return rpc<Array<TopicRow & { matched: string }>>('blocking_candidates', { text, limit })
  }

  async createTopic(input: { canonicalName: string; stateSummary: string; tier?: Tier; uncertain?: boolean }): Promise<string> {
    const id = await rpc<string>('create_topic', input)
    await this.refresh()
    return id
  }

  async mergeTopic(id: string, patch: { stateSummary?: string; alias?: string; action?: string }): Promise<void> {
    await rpc('merge_topic', { id, stateSummary: patch.stateSummary, alias: patch.alias, action: patch.action })
    await this.refresh()
  }

  async deleteTopic(id: string): Promise<void> {
    await rpc('delete_topic', { id })
    await this.refresh()
  }

  async activate(id: string): Promise<void> {
    await rpc('activate', { id })
    await this.refresh()
  }

  async activateByText(text: string): Promise<void> {
    await rpc('activate_by_text', { text })
    await this.refresh()
  }

  async demote(id: string, reason?: string): Promise<boolean> {
    const ok = await rpc<boolean>('demote', { id, reason })
    await this.refresh()
    return ok
  }

  async remember(input: { content: string; topic?: string }): Promise<string> {
    const id = await rpc<string>('remember', input)
    await this.refresh()
    return id
  }

  // ───────────────────────── events / card / promises / self-history（RPC） ─────────────────────────

  async appendEvent(input: { topicId: string; statement: string; ts?: number; episodeId?: string }): Promise<void> {
    await rpc('append_event', input)
    await this.refresh()
  }

  async updateCard(facts: Partial<Pick<RelationCard, 'profile' | 'agent_model' | 'relationship'>>): Promise<void> {
    await rpc('update_card', { facts })
    await this.refresh()
  }

  async upsertPromise(input: { content: string; status?: PromiseRow['status']; dueAt?: number }): Promise<void> {
    await rpc('upsert_promise', input)
    await this.refresh()
  }

  async appendSelfAction(input: { kind: string; content: string; topicId?: string; ts?: number }): Promise<void> {
    await rpc('append_self_action', input)
    await this.refresh()
  }

  async recentSelfActions(kind?: string, limit = 5): Promise<SelfAction[]> {
    return rpc<SelfAction[]>('recent_self_actions', { kind, limit })
  }
}