// @diver/onebot — 回合文件作用域：囚笼策略 + 笔记根（IO 只做一次，按 scope 缓存）。
//
// 基线把整个笔记根设为 denied，只对当前来源自己的 scope 开 allowedSubtrees
// 例外；主人私聊不额外 deny。策略对象按 scope 缓存，避免每回合重建。

import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { buildFsPolicy, type FsPolicy } from './fs-jail.ts'
import { noteScopeDir } from './notes.ts'
import { prepareNotesRoot } from './notes-store.ts'
import { isOwnerPrivateSource, type OnebotSource } from './sandbox.ts'

export interface FsScope {
  /** 按回合来源取囚笼策略（主人私聊近全开；基线 + 自己的笔记 scope）。 */
  policyFor(source: OnebotSource | undefined, ownerIds: readonly string[]): Promise<FsPolicy>
  /** 相对路径解析基准（basic-tools 未覆写 workspaceRoot 时的默认）。 */
  workspaceBase(): Promise<string>
  /** 笔记根 realpath；undefined = 初始化失败，append_note 关闭。 */
  notesRoot(): Promise<string | undefined>
}

export interface FsScopeOptions {
  cosHome: string
  extraRoots: readonly string[]
}

const realRoot = (p: string): Promise<string> =>
  realpath(p).catch(() => Promise.resolve(resolve(p)))

export function createFsScope(options: FsScopeOptions): FsScope {
  const ready = (async () => {
    const cosHome = await realRoot(options.cosHome)
    const extraRoots = await Promise.all(options.extraRoots.map(realRoot))
    let notesRoot: string | undefined
    let notesDeny: string[] = []
    try {
      notesRoot = await prepareNotesRoot(cosHome)
    } catch (error: unknown) {
      // 建不出根/根被换成链接：关闭 append_note，并把已知路径整棵锁死（fail-closed）。
      const lexical = join(cosHome, 'notes')
      notesDeny = [...new Set([lexical, await realRoot(lexical)])]
      console.warn(
        `[onebot] 笔记根不可用，append_note 关闭：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return {
      baseline: buildFsPolicy(cosHome, extraRoots, false, {
        extraDeniedSubtrees: notesRoot !== undefined ? [notesRoot] : notesDeny,
      }),
      ownerPrivate: buildFsPolicy(cosHome, extraRoots, true),
      workspaceBase: join(cosHome, 'workspace'),
      notesRoot,
    }
  })()

  const scoped = new Map<string, FsPolicy>()

  return {
    async policyFor(source, ownerIds) {
      const { baseline, ownerPrivate, notesRoot } = await ready
      if (isOwnerPrivateSource(source, ownerIds)) return ownerPrivate
      if (notesRoot === undefined || source === undefined) return baseline
      const scope = noteScopeDir(source, ownerIds)
      let policy = scoped.get(scope)
      if (policy === undefined) {
        policy = { ...baseline, allowedSubtrees: [join(notesRoot, scope)] }
        scoped.set(scope, policy)
      }
      return policy
    },
    async workspaceBase() {
      return (await ready).workspaceBase
    },
    async notesRoot() {
      return (await ready).notesRoot
    },
  }
}
