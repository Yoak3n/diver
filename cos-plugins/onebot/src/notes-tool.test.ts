// append_note 工具接线测试：作用域选择、来源头、回合预算、桌面拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'

import { prepareNotesRoot } from './notes-store.ts'
import { applyNotesTool } from './notes-tool.ts'
import { TurnSandbox } from './sandbox.ts'

type Executor = (args: unknown) => Promise<{ content: string }>

function fakeCtx(): { ctx: Context; tools: Map<string, Executor> } {
  const tools = new Map<string, Executor>()
  const ctx = {
    tools: {
      register: (name: string, executor: Executor) => {
        tools.set(name, executor)
        return () => {
          tools.delete(name)
        }
      },
    },
  } as unknown as Context
  return { ctx, tools }
}

test('append_note：群/私聊/主人作用域、来源头、预算与桌面拒绝', async () => {
  const cos = await realpath(await mkdtemp(join(tmpdir(), 'diver-notes-tool-')))
  try {
    const notesRoot = await prepareNotesRoot(cos)
    const { ctx, tools } = fakeCtx()
    const sandbox = new TurnSandbox()
    const budget = { appends: 0, bytes: 0 }
    applyNotesTool(ctx, {
      sandbox,
      ownerIds: ['456'],
      notesRoot: async () => notesRoot,
      budget,
    })
    const append = tools.get('append_note')
    assert.ok(append)

    // 桌面/未激活：拒绝。
    let out = JSON.parse((await append({ path: 'a.md', content: 'x' })).content)
    assert.match(out.error, /只在 OneBot 回合/)

    // 群聊：写到 group-123，来源头带群号。
    sandbox.markClaimed([{ source: { detail: 'onebot:g123:789' } }])
    out = JSON.parse((await append({ path: 'diary/a.md', content: 'hello' })).content)
    assert.equal(out.ok, true)
    assert.equal(out.path, join(notesRoot, 'group-123', 'diary', 'a.md'))
    assert.equal(budget.appends, 1)
    assert.match(await readFile(out.path, 'utf8'), /group:123/)

    // 第二次允许，第三次超回合次数。
    out = JSON.parse((await append({ path: 'diary/a.md', content: 'world' })).content)
    assert.equal(out.ok, true)
    assert.equal(budget.appends, 2)
    out = JSON.parse((await append({ path: 'b.md', content: 'nope' })).content)
    assert.match(out.error, /次数/)

    // 回合结束重置；陌生私聊写 private-789，主人私聊写 owner。
    sandbox.markTurnEnd()
    budget.appends = 0
    budget.bytes = 0
    sandbox.markClaimed([{ source: { detail: 'onebot:u789' } }])
    out = JSON.parse((await append({ path: 'p.md', content: 'hi' })).content)
    assert.equal(out.path, join(notesRoot, 'private-789', 'p.md'))
    assert.match(await readFile(out.path, 'utf8'), /private:789/)

    sandbox.markTurnEnd()
    budget.appends = 0
    budget.bytes = 0
    sandbox.markClaimed([{ source: { detail: 'onebot:u456' } }])
    out = JSON.parse((await append({ path: 'owner.md', content: 'hi' })).content)
    assert.equal(out.path, join(notesRoot, 'owner', 'owner.md'))
  } finally {
    await rm(cos, { recursive: true, force: true })
  }
})
