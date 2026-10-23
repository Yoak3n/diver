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
  assert.equal(cfg.privateMaxPerHour, 30)
  assert.equal(cfg.sendIntervalMs, 1500)
  // 语音默认关闭（配了才开）
  assert.equal(cfg.voice.mode, 'off')
  assert.equal(cfg.voice.maxChars, 100)
  assert.equal(cfg.voice.cooldownMinutes, 10)
})

test('语音配置：非法 mode 回退 off，数值夹紧', () => {
  assert.equal(resolveConfig({ voiceMode: 'always' }).voice.mode, 'off')
  assert.equal(resolveConfig({ voiceMode: 'ask' }).voice.mode, 'ask')
  assert.equal(resolveConfig({ voiceMode: 'auto', voiceRate: 3 }).voice.rate, 1)
  assert.equal(resolveConfig({ voiceMaxChars: 1 }).voice.maxChars, 10)
  assert.equal(resolveConfig({ voiceTimeoutMs: 999_999 }).voice.timeoutMs, 60_000)
})

test('数值越界被夹紧（而非拒绝）', () => {
  const cfg = resolveConfig({ maxMessages: 9999, ratePlain: 7, cooldownMinutes: -3, sendIntervalMs: 1 })
  assert.equal(cfg.context.maxMessages, 200)
  assert.equal(cfg.rate.plain, 1)
  assert.equal(cfg.cooldownMinutes, 0)
  assert.equal(cfg.sendIntervalMs, 200)
  // 私聊限频：上限 600，负数落 0 = 不限制
  assert.equal(resolveConfig({ privateMaxPerHour: 9_999 }).privateMaxPerHour, 600)
  assert.equal(resolveConfig({ privateMaxPerHour: -1 }).privateMaxPerHour, 0)
})

test('非数值输入回退默认', () => {
  const cfg = resolveConfig({ maxMessages: 'abc' as unknown as number, rateMention: NaN })
  assert.equal(cfg.context.maxMessages, 40)
  assert.equal(cfg.rate.mention, 0.9)
})

test('列表字段按分隔符拆分并去空', () => {
  const cfg = resolveConfig({
    ownerIds: ' 10001, 10002 ,',
    groups: ' 123, 456 ,',
    aliases: '小麦,,麦麦',
    allowedTools: 'web_search, web_read',
    maskTerms: '张三, 李四',
    extraPatterns: '\\d{5};[a-z]+;',
  })
  assert.deepEqual(cfg.ownerIds, ['10001', '10002'])
  // 非数字条目不是 QQ 号，直接丢弃（避免误判主人）
  assert.deepEqual(resolveConfig({ ownerIds: '10001, 小麦, 20002' }).ownerIds, ['10001', '20002'])
  assert.deepEqual(cfg.groups, ['123', '456'])
  assert.deepEqual(cfg.aliases, ['小麦', '麦麦'])
  assert.deepEqual(cfg.sandbox.allowedTools, ['web_search', 'web_read'])
  assert.deepEqual(cfg.privacy.maskTerms, ['张三', '李四'])
  assert.deepEqual(cfg.privacy.extraPatterns, ['\\d{5}', '[a-z]+'])
})

test('放行名单 = 固定基座 + 增量去重，硬禁项被剔除', () => {
  assert.deepEqual(allowedToolNames([]), [...BASELINE_TOOLS])
  const allowed = allowedToolNames(['web_search', 'send_qq_group', 'sh', 'web_read', 'mcp__demo__run'])
  assert.deepEqual(allowed, [...BASELINE_TOOLS] as string[])
  assert.equal(allowed.includes('sh'), false)
  assert.equal(allowed.includes('web_read'), false)
  assert.equal(allowed.includes('mcp__demo__run'), false)
})
