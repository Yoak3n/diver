// 配置解析单测：默认值、夹紧、列表拆分、坏输入回退。
import test from 'node:test'
import assert from 'node:assert/strict'

import { BASELINE_TOOLS, resolveConfig } from './config.ts'
import { allowedToolNames } from './sandbox.ts'

test('缺省配置取安全默认：不连接、不监听群', () => {
  const cfg = resolveConfig()
  assert.equal(cfg.wsUrl, '')
  assert.deepEqual(cfg.groups, [])
  assert.deepEqual(cfg.aliases, [])
  assert.equal(cfg.context.maxMessages, 40)
  assert.equal(cfg.context.maxAgeMinutes, 30)
  assert.equal(cfg.context.maxChars, 4000)
  assert.equal(cfg.rate.plain, 0.05)
  assert.equal(cfg.rate.mention, 0.9)
  assert.equal(cfg.rate.quoted, 0.8)
  assert.equal(cfg.cooldownMinutes, 15)
  assert.equal(cfg.sendIntervalMs, 1500)
})

test('数值越界被夹紧（而非拒绝）', () => {
  const cfg = resolveConfig({ maxMessages: 9999, ratePlain: 7, cooldownMinutes: -3, sendIntervalMs: 1 })
  assert.equal(cfg.context.maxMessages, 200)
  assert.equal(cfg.rate.plain, 1)
  assert.equal(cfg.cooldownMinutes, 0)
  assert.equal(cfg.sendIntervalMs, 200)
})

test('非数值输入回退默认', () => {
  const cfg = resolveConfig({ maxMessages: 'abc' as unknown as number, rateMention: NaN })
  assert.equal(cfg.context.maxMessages, 40)
  assert.equal(cfg.rate.mention, 0.9)
})

test('列表字段按分隔符拆分并去空', () => {
  const cfg = resolveConfig({
    groups: ' 123, 456 ,',
    aliases: '小麦,,麦麦',
    allowedTools: 'web_search, web_read',
    maskTerms: '张三, 李四',
    extraPatterns: '\\d{5};[a-z]+;',
  })
  assert.deepEqual(cfg.groups, ['123', '456'])
  assert.deepEqual(cfg.aliases, ['小麦', '麦麦'])
  assert.deepEqual(cfg.sandbox.allowedTools, ['web_search', 'web_read'])
  assert.deepEqual(cfg.privacy.maskTerms, ['张三', '李四'])
  assert.deepEqual(cfg.privacy.extraPatterns, ['\\d{5}', '[a-z]+'])
})

test('放行名单 = 基座三件套 + 增量去重', () => {
  assert.deepEqual(allowedToolNames([]), [...BASELINE_TOOLS])
  const allowed = allowedToolNames(['web_search', 'send_qq_group'])
  assert.deepEqual(allowed, ['send_qq_group', 'send_qq_private', 'stay_silent', 'web_search'])
})
