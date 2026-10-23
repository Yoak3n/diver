// @diver/memory — 回合作用域（QQ 记忆隐私边界）。
//
// onebot 插件在认领消息时广播 `onebot/turn-scope`；这里只保存当前回合来源，
// 由 remember / recall 决定读写命名空间。没有 OneBot 回合时保持本地语义。
//
// 作用域约定：
//   owner       主人私聊 / 本地桌面（默认，旧数据迁移到这一层）
//   global      可跨场景共享的公共事实
//   group:<id>  某个 QQ 群
//   private:<id> 某个非主人的 QQ 私聊
//
// 群回合只读「global + 本群」的原文；其他群只给模糊轮廓；owner/private 不进入群。

import type { Context } from 'cordis'

export interface OnebotTurnScope {
  active: boolean
  kind?: 'group' | 'private'
  groupId?: string
  userId?: string
  isOwner?: boolean
}

declare module 'cordis' {
  interface Events {
    'onebot/turn-scope'(scope: OnebotTurnScope): void
  }
}

let current: OnebotTurnScope | undefined

export function registerTurnScope(ctx: Context): void {
  ctx.on('onebot/turn-scope', (scope) => {
    current = scope.active ? scope : undefined
  })
}

export function currentTurnScope(): OnebotTurnScope | undefined {
  return current
}

/** 写入命名空间：群写本群、主人私聊写 owner、陌生人私聊写 private:<id>。 */
export function writeScope(scope: OnebotTurnScope | undefined = current): string {
  if (scope === undefined) return 'owner'
  if (scope.kind === 'group' && scope.groupId) return `group:${scope.groupId}`
  if (scope.kind === 'private') {
    return scope.isOwner === true ? 'owner' : `private:${scope.userId ?? ''}`
  }
  return 'owner'
}

export type RecallMode = 'local' | 'owner' | 'group' | 'private'

export interface RecallPolicy {
  mode: RecallMode
  groupId?: string
  userId?: string
}

export function recallPolicy(scope: OnebotTurnScope | undefined = current): RecallPolicy {
  if (scope === undefined) return { mode: 'local' }
  if (scope.kind === 'group' && scope.groupId) {
    return { mode: 'group', groupId: scope.groupId }
  }
  if (scope.kind === 'private') {
    return scope.isOwner === true
      ? { mode: 'owner' }
      : { mode: 'private', userId: scope.userId }
  }
  return { mode: 'local' }
}

/** 本回合可按原文返回的作用域。 */
export function isRawScope(scopeName: string, policy: RecallPolicy): boolean {
  switch (policy.mode) {
    case 'local':
    case 'owner':
      return true
    case 'group':
      return scopeName === 'global' || scopeName === `group:${policy.groupId}`
    case 'private':
      return scopeName === 'global' || scopeName === `private:${policy.userId}`
  }
}

/** 群回合里来自其他群的记忆：只给模糊轮廓。 */
export function isOtherGroupScope(scopeName: string, policy: RecallPolicy): boolean {
  return policy.mode === 'group'
    && scopeName.startsWith('group:')
    && scopeName !== `group:${policy.groupId}`
}

/** 是否允许返回实体图谱（外部 QQ 回合一律不返回，避免细节泄漏）。 */
export function allowsEntities(policy: RecallPolicy): boolean {
  return policy.mode === 'local' || policy.mode === 'owner'
}

/** 传给 Rust blocking_candidates 的作用域过滤。 */
export function scopeFilter(policy: RecallPolicy): {
  scopes?: string[]
  excludeScopes?: string[]
  excludeScopePrefixes?: string[]
} {
  if (policy.mode === 'group') {
    return { excludeScopes: ['owner'], excludeScopePrefixes: ['private:'] }
  }
  if (policy.mode === 'private') {
    return { scopes: ['global', `private:${policy.userId}`] }
  }
  return {}
}
