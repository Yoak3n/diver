// parseModelsPayload / isChatModelId 纯函数单测（node:test，仓库 cos-plugin 惯例）。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { FALLBACK_MODELS, isChatModelId, parseModelsPayload } from './catalog'

describe('isChatModelId', () => {
  it('文本模型通过', () => {
    for (const id of ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed']) {
      assert.equal(isChatModelId(id), true, id)
    }
  })

  it('TTS / ASR 型号被滤掉', () => {
    for (const id of ['mimo-v2.5-tts', 'mimo-v2.5-tts-voiceclone', 'mimo-v2.5-asr']) {
      assert.equal(isChatModelId(id), false, id)
    }
  })

  it('大小写不敏感且空 id 不通过', () => {
    assert.equal(isChatModelId('MIMO-V2.5-TTS'), false)
    assert.equal(isChatModelId(''), false)
  })

  it('名字中间含 tts 的型号不被误杀', () => {
    assert.equal(isChatModelId('mimo-v3-ttsbench-pro'), true)
  })
})

describe('parseModelsPayload', () => {
  it('解析标准 {data:[{id}]} 载荷', () => {
    assert.deepEqual(
      parseModelsPayload({ data: [{ id: 'mimo-v2.6-pro' }, { id: 'mimo-v2.6-flash' }] }),
      ['mimo-v2.6-pro', 'mimo-v2.6-flash'],
    )
  })

  it('滤掉同命名空间里的音频模型', () => {
    assert.deepEqual(
      parseModelsPayload({
        data: [{ id: 'mimo-v2.6-flash' }, { id: 'mimo-v2.5-tts' }, { id: 'mimo-v2.5-asr' }],
      }),
      ['mimo-v2.6-flash'],
    )
  })

  it('丢弃非字符串与空 id 条目，保留其余', () => {
    assert.deepEqual(
      parseModelsPayload({ data: [{ id: 'mimo-v2.6-pro' }, { id: '' }, { id: 42 }, null, 'x'] }),
      ['mimo-v2.6-pro'],
    )
  })

  it('全无效 / 只剩音频模型 / 空 data / 缺 data → null（调用方退回静态兜底）', () => {
    assert.equal(parseModelsPayload({ data: [{ id: '' }] }), null)
    assert.equal(parseModelsPayload({ data: [{ id: 'mimo-v2.5-tts' }] }), null)
    assert.equal(parseModelsPayload({ data: [] }), null)
    assert.equal(parseModelsPayload({}), null)
  })

  it('非对象载荷（null / 数组 / 字符串）→ null', () => {
    assert.equal(parseModelsPayload(null), null)
    assert.equal(parseModelsPayload([1, 2]), null)
    assert.equal(parseModelsPayload('oops'), null)
  })
})

describe('FALLBACK_MODELS', () => {
  it('兜底目录非空且全部是对话模型', () => {
    assert.ok(FALLBACK_MODELS.length > 0)
    for (const id of FALLBACK_MODELS) assert.equal(isChatModelId(id), true, id)
  })
})
