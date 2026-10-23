// parseModelsPayload 纯函数单测（node:test，仓库 cos-plugin 惯例）。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseModelsPayload } from './catalog'

describe('parseModelsPayload', () => {
  it('解析标准 {data:[{id}]} 载荷', () => {
    assert.deepEqual(
      parseModelsPayload({ data: [{ id: 'glm-5.3' }, { id: 'kimi-k3' }] }),
      ['glm-5.3', 'kimi-k3'],
    )
  })

  it('丢弃非字符串与空 id 条目，保留其余', () => {
    assert.deepEqual(
      parseModelsPayload({ data: [{ id: 'glm-5.3' }, { id: '' }, { id: 42 }, null, 'not-an-object'] }),
      ['glm-5.3'],
    )
  })

  it('全无效 / 空 data / 缺 data → null（调用方退回静态兜底）', () => {
    assert.equal(parseModelsPayload({ data: [{ id: '' }] }), null)
    assert.equal(parseModelsPayload({ data: [] }), null)
    assert.equal(parseModelsPayload({}), null)
  })

  it('非对象载荷（null / 数组 / 字符串）→ null', () => {
    assert.equal(parseModelsPayload(null), null)
    assert.equal(parseModelsPayload([1, 2]), null)
    assert.equal(parseModelsPayload('oops'), null)
  })
})
