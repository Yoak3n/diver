// 出站遮蔽单测：各类规则命中、误报控制、自定义词条/正则、幂等。
import test from 'node:test'
import assert from 'node:assert/strict'

import { maskOutbound } from './mask.ts'
import { resolveConfig } from './config.ts'

const empty = resolveConfig().privacy

function kinds(text: string, privacy = empty): string[] {
  return maskOutbound(text, privacy).masked.map((hit) => hit.kind)
}

test('本地路径遮蔽：Unix 常见根 / Windows 盘符 / ~', () => {
  assert.deepEqual(kinds('配置在 /home/yoa/.cos/diver-settings.json 里'), ['path'])
  assert.deepEqual(kinds('日志在 C:\\Users\\me\\AppData\\diver.log'), ['path'])
  assert.deepEqual(kinds('看 ~/.cos/workspace 目录'), ['path'])
  assert.match(maskOutbound('配置在 /home/yoa/.cos/x.json 里', empty).text, /\[路径\]/)
})

test('凭据遮蔽：前缀 token / 长 hex / Bearer', () => {
  assert.deepEqual(kinds('key 是 sk-abcdefgh12345678'), ['credential'])
  assert.deepEqual(kinds(`token=${'a1'.repeat(20)}`), ['credential'])
  assert.deepEqual(kinds('Authorization: Bearer abcdefghijklmnop'), ['credential'])
})

test('联系方式遮蔽：邮箱 / 手机号 / 身份证', () => {
  assert.deepEqual(kinds('联系 yoa@example.com'), ['email'])
  assert.deepEqual(kinds('电话 13800138000'), ['phone'])
  assert.deepEqual(kinds('身份证 110101199001011234'), ['idcard'])
})

test('误报控制：短数字、普通英文、日期不误伤', () => {
  assert.deepEqual(kinds('今天 2026 年，只有 3 条消息'), [])
  assert.deepEqual(kinds('Hello world, 早啊'), [])
  assert.equal(maskOutbound('第 1380013800 号', empty).text, '第 1380013800 号')
})

test('自定义词条：字面量遮蔽（含正则特殊字符）', () => {
  const privacy = resolveConfig({ maskTerms: '张三,a.b' }).privacy
  const result = maskOutbound('张三住 a.b 小区', privacy)
  assert.equal(result.text, '[已遮蔽]住 [已遮蔽] 小区')
  assert.deepEqual(result.masked, [{ kind: 'term', count: 2 }])
})

test('自定义正则：命中遮蔽，坏正则跳过不抛', () => {
  const privacy = resolveConfig({ extraPatterns: '\\d{5};([bad' }).privacy
  const result = maskOutbound('工号 12345', privacy)
  assert.equal(result.text, '工号 [已遮蔽]')
  // 坏正则被跳过，正文原样
  assert.equal(maskOutbound('工号 ([bad', privacy).text, '工号 ([bad')
})

test('多规则同现：统计分类正确', () => {
  const result = maskOutbound('/home/u/secret.txt 联系 a@b.com 或 13900139000', empty)
  assert.deepEqual(result.masked.sort((a, b) => a.kind.localeCompare(b.kind)), [
    { kind: 'path', count: 1 },
    { kind: 'email', count: 1 },
    { kind: 'phone', count: 1 },
  ].sort((a, b) => a.kind.localeCompare(b.kind)))
})

test('幂等：遮蔽结果再过一遍不变、不再命中', () => {
  const once = maskOutbound('/home/u/x 13800138000 a@b.com', empty)
  const twice = maskOutbound(once.text, empty)
  assert.equal(twice.text, once.text)
  assert.deepEqual(twice.masked, [])
})
