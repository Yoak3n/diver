// @diver/memory — 存储层领域类型（与 Rust RPC 的 camelCase JSON 同形）。
//
// 单独成文件：store-rpc.ts 只保留 RPC 方法与视图缓存，行类型不再和传输混放。

export const DECAY = {
  episodic: { rate: 0.05, forget: 0.02 },
  trivia: { rate: 0.15, forget: 0.1 },
} as const

export type Tier = keyof typeof DECAY

export interface TopicRow {
  id: string
  canonicalName: string
  aliases: string[]
  stateSummary: string
  weight: number
  tier: Tier
  activationCount: number
  createdAt: number
  lastDiscussedAt: number
  nTimes: number
  uncertain: boolean
  demotedAt?: number
  demotedReason?: string
  /** owner / global / group:<id> / private:<id> */
  scope: string
}

export interface MemoryEvent {
  seq: number
  topicId: string
  statement: string
  ts: number
  episodeId?: string
}

export interface RelationCard {
  /** 名字（可空 = 未命名）：人格卡片是名字权威源，壳层会写回实例清单 */
  name?: string | null
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
  entities: number
}

export interface EntityRow {
  id: string
  name: string
  entityType?: string | null
  mentionCount: number
  createdAt: number
  updatedAt: number
}

export interface EntityAttrRow {
  id: string
  entityId: string
  attrKey: string
  attrValue: string
  validFrom: number
  validUntil?: number | null
  sourceTopicId?: string | null
}

export interface EntityNeighbor {
  relation: string
  direction: 'out' | 'in'
  entity: EntityRow
}

export interface EntityGraph {
  entity: EntityRow
  attrs: EntityAttrRow[]
  neighbors: EntityNeighbor[]
}

export interface EntityRelationSpec {
  to: string
  relation: string
  toType?: string
}

/** blocking_candidates 的作用域过滤（都是可选收窄条件）。 */
export interface ScopeFilter {
  /** 只保留这些作用域。 */
  scopes?: string[]
  /** 排除这些作用域。 */
  excludeScopes?: string[]
  /** 排除这些前缀（如 private:）。 */
  excludeScopePrefixes?: string[]
}
