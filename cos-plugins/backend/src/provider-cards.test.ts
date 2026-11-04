// provider-cards 纯函数单测（node:test，仓库 backend 惯例）。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  appendProviderCard,
  dropProviderCard,
  isDeclConfigured,
  normalizeProviderCards,
  seedProviderCards,
} from './provider-cards.ts'
import type { ProviderDeclView } from './types.ts'

function decl(
  provider: string,
  options: { configured?: boolean; custom?: boolean; noSecret?: boolean } = {},
): ProviderDeclView {
  const fields = options.noSecret
    ? []
    : [{ key: 'apiKey', label: 'API Key', secret: true, required: true, configured: options.configured ?? false }]
  return {
    provider,
    name: provider,
    fields: fields as ProviderDeclView['fields'],
    ...(options.custom === true ? { custom: true } : {}),
  }
}

describe('normalizeProviderCards', () => {
  it('非数组 → undefined（表示未初始化）', () => {
    for (const value of [undefined, null, 'mimo', 42, { a: 1 }]) {
      assert.equal(normalizeProviderCards(value), undefined)
    }
  })

  it('去空、去重、trim，非字符串条目丢弃', () => {
    assert.deepEqual(normalizeProviderCards([' mimo ', '', 'mimo', 42, null, 'volcark']), [
      'mimo',
      'volcark',
    ])
  })

  it('超长 id 被丢弃', () => {
    assert.deepEqual(normalizeProviderCards(['x'.repeat(101), 'ok']), ['ok'])
  })

  it('超出上限截断到 32 个', () => {
    const many = Array.from({ length: 40 }, (_, i) => `p${i}`)
    assert.equal(normalizeProviderCards(many)?.length, 32)
  })

  it('空数组 → 空列表（显式清空）', () => {
    assert.deepEqual(normalizeProviderCards([]), [])
  })
})

describe('isDeclConfigured', () => {
  it('必填 secret 配齐才算已配置', () => {
    assert.equal(isDeclConfigured(decl('mimo', { configured: true })), true)
    assert.equal(isDeclConfigured(decl('mimo', { configured: false })), false)
  })

  it('没有必填 secret 的 provider 不算已配置（如 mock）', () => {
    assert.equal(isDeclConfigured(decl('mock', { noSecret: true })), false)
  })
})

describe('seedProviderCards', () => {
  it('全新安装：只有默认项', () => {
    assert.deepEqual(seedProviderCards([decl('deepseek-official'), decl('mimo')]), [
      'deepseek-official',
    ])
  })

  it('已配置 / 自定义的 provider 一并播种（老用户升级不再丢卡片）', () => {
    const decls = [
      decl('deepseek-official'),
      decl('commandcode'),
      decl('mimo', { configured: true }),
      decl('custom-abcd', { custom: true }),
    ]
    assert.deepEqual(seedProviderCards(decls), ['deepseek-official', 'mimo', 'custom-abcd'])
  })

  it('默认项不在注册表里时仍保留（列表以持久化值为准）', () => {
    assert.deepEqual(seedProviderCards([decl('mimo', { configured: true })]), [
      'deepseek-official',
      'mimo',
    ])
  })
})

describe('appendProviderCard / dropProviderCard', () => {
  it('追加去重并按上限截断', () => {
    assert.deepEqual(appendProviderCard(['mimo'], 'opencode-go'), ['mimo', 'opencode-go'])
    assert.deepEqual(appendProviderCard(['mimo'], 'mimo'), ['mimo'])
  })

  it('移除不存在项时原样返回', () => {
    assert.deepEqual(dropProviderCard(['mimo'], 'volcark'), ['mimo'])
    assert.deepEqual(dropProviderCard(['mimo', 'volcark'], 'mimo'), ['volcark'])
  })
})
