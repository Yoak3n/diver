// 模型目录快照单测（node:test，仓库 backend 惯例）。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createModelCatalog, type ModelCatalogSource } from './model-catalog.ts'

type CatalogValue = readonly string[] | (() => Promise<readonly string[]>)

function makeSource(providers: Record<string, CatalogValue>): {
  calls: string[]
  source: ModelCatalogSource
} {
  const calls: string[] = []
  return {
    calls,
    source: {
      listProviders: () => Object.keys(providers).map((id) => ({ id })),
      listModels: async (id: string) => {
        calls.push(id)
        const value = providers[id]
        return typeof value === 'function' ? await value() : (value ?? [])
      },
    },
  }
}

describe('createModelCatalog', () => {
  it('刷新前快照为空，刷新后按 provider 拍平', async () => {
    const { source } = makeSource({ a: ['a1', 'a2'], b: ['b1'] })
    const catalog = createModelCatalog(source)
    assert.deepEqual(catalog.snapshot(), [])

    const models = await catalog.refresh()
    assert.deepEqual(models, [
      { provider: 'a', id: 'a1' },
      { provider: 'a', id: 'a2' },
      { provider: 'b', id: 'b1' },
    ])
    assert.deepEqual(catalog.snapshot(), models)
  })

  it('并发刷新共享同一个 in-flight 请求', async () => {
    const { calls, source } = makeSource({ a: ['a1'] })
    const catalog = createModelCatalog(source)
    const [first, second] = await Promise.all([catalog.refresh(), catalog.refresh()])
    assert.deepEqual(first, [{ provider: 'a', id: 'a1' }])
    assert.deepEqual(second, first)
    assert.deepEqual(calls, ['a'])
  })

  it('单个 provider 失败保留其旧条目，不影响其它 provider', async () => {
    let failing = false
    const source: ModelCatalogSource = {
      listProviders: () => [{ id: 'a' }, { id: 'b' }],
      listModels: async (id: string) => {
        if (id === 'b' && failing) throw new Error('upstream down')
        return id === 'a' ? ['a1'] : ['b1']
      },
    }
    const catalog = createModelCatalog(source)
    await catalog.refresh()

    failing = true
    const models = await catalog.refresh({ force: true })
    assert.deepEqual(models, [
      { provider: 'a', id: 'a1' },
      { provider: 'b', id: 'b1' },
    ])
  })

  it('注册表里已移除的 provider 不再出现在快照', async () => {
    const providers = ['a', 'b']
    const source: ModelCatalogSource = {
      listProviders: () => providers.map((id) => ({ id })),
      listModels: async (id: string) => [`${id}1`],
    }
    const catalog = createModelCatalog(source)
    await catalog.refresh()

    providers.pop()
    const models = await catalog.refresh({ force: true })
    assert.deepEqual(models, [{ provider: 'a', id: 'a1' }])
  })

  it('非强制刷新受最短间隔节流，force 跳过节流', async () => {
    const { calls, source } = makeSource({ a: ['a1'] })
    const catalog = createModelCatalog(source, { minIntervalMs: 60_000 })

    await catalog.refresh()
    await catalog.refresh()
    assert.deepEqual(calls, ['a'])

    await catalog.refresh({ force: true })
    assert.deepEqual(calls, ['a', 'a'])
  })

  it('各 provider 并行拉取：慢的一家不挡其它家先发出请求', async () => {
    let release: (() => void) | undefined
    const slow = new Promise<readonly string[]>((resolve) => {
      release = () => resolve(['a1'])
    })
    const calls: string[] = []
    const source: ModelCatalogSource = {
      listProviders: () => [{ id: 'a' }, { id: 'b' }],
      listModels: async (id: string) => {
        calls.push(id)
        return id === 'a' ? await slow : ['b1']
      },
    }
    const catalog = createModelCatalog(source)
    const pending = catalog.refresh()

    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual([...calls].sort(), ['a', 'b'])

    release?.()
    const models = await pending
    assert.deepEqual(models.map((model) => model.provider).sort(), ['a', 'b'])
  })
})
