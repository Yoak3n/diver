import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { refreshCuriositySources } from './curiosity-sources.ts'
import { curiosityStatePath } from './curiosity-state.ts'
import type { MemoryStore } from './store-rpc.ts'

interface UpsertInput {
  term: string
  source: string
  reason?: string
  priority?: number
}

function fakeStore(entities: Array<{ name: string; mentionCount: number }> = []) {
  const upserts: UpsertInput[] = []
  const store = {
    curiosityUpsert: async (input: UpsertInput) => {
      upserts.push(input)
      return `c-${upserts.length}`
    },
    listEntities: async () => entities,
  } as unknown as MemoryStore
  return { store, upserts }
}

test('群聊缓冲按游标取新词，笔记只扫 owner', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-curiosity-'))
  try {
    const now = 1_800_000_000_000
    mkdirSync(join(home, 'onebot', 'groups'), { recursive: true })
    mkdirSync(join(home, 'notes', 'owner'), { recursive: true })
    mkdirSync(join(home, 'notes', 'private-9'), { recursive: true })
    writeFileSync(
      join(home, 'onebot', 'groups', '123.jsonl'),
      [
        JSON.stringify({ time: now - 2_000, userId: 'u1', text: '最近在看 MXene 的论文' }),
        JSON.stringify({ time: now - 1_000, userId: 'u2', text: 'MXene 是二维材料' }),
      ].join('\n'),
    )
    writeFileSync(join(home, 'notes', 'owner', 'todo.md'), '# 待查：量子退火\n')
    writeFileSync(join(home, 'notes', 'private-9', 'secret.md'), '# 别人的秘密词\n')

    const { store, upserts } = fakeStore([{ name: '吉他', mentionCount: 3 }])
    const added = await refreshCuriositySources(store, { scanLimit: 20 }, { home, now })
    assert.ok(added >= 3)

    const terms = upserts.map((u) => u.term)
    assert.ok(terms.includes('MXene'))
    assert.ok(terms.some((t) => t.includes('量子退火')))
    assert.ok(terms.includes('吉他'))
    assert.equal(terms.some((t) => t.includes('秘密')), false)
    assert.equal(upserts.find((u) => u.term === 'MXene')?.source, 'chat:group:123')

    const state = JSON.parse(readFileSync(curiosityStatePath(home), 'utf8')) as {
      chat: Record<string, number>
      lastScanAt: number
    }
    assert.equal(state.lastScanAt, now)
    assert.ok(Object.values(state.chat)[0] === now - 1_000)

    // 同一批消息 + 节流期内重复调用：不再入队。
    const again = await refreshCuriositySources(store, { scanLimit: 20 }, { home, now: now + 1_000 })
    assert.equal(again, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('总开关关闭时不扫描', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-curiosity-off-'))
  try {
    const { store, upserts } = fakeStore()
    const added = await refreshCuriositySources(
      store,
      { curiosityEnabled: false },
      { home, now: Date.now(), force: true },
    )
    assert.equal(added, 0)
    assert.equal(upserts.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
