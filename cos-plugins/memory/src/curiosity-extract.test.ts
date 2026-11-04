import { test } from 'node:test'
import assert from 'node:assert/strict'

import { cleanChatText, extractChatTerms, extractNoteTerms, normalizeTerm } from './curiosity-extract.ts'

test('normalizeTerm 统一大小写/空白/尾部标点', () => {
  assert.equal(normalizeTerm('  DeepSeek   V3 '), 'deepseek v3')
  assert.equal(normalizeTerm('MXene。'), 'mxene')
  assert.equal(normalizeTerm('  '), '')
})

test('cleanChatText 去掉占位符/URL/@/命令', () => {
  assert.equal(cleanChatText('[图片] @小明 看 https://example.com/a 这个'), '看 这个')
  assert.equal(cleanChatText('/help 查一下'), '查一下')
})

test('群聊：引号内容与 Latin 专名入队', () => {
  const terms = extractChatTerms([
    { text: '最近在看「量子退火」的资料', userId: 'u1' },
    { text: 'MiMo 和 DeepSeek 都更新了', userId: 'u2' },
    { text: 'v0.2.13 修了 IME', userId: 'u1' },
  ])
  const byTerm = new Map(terms.map((t) => [normalizeTerm(t.term), t]))
  assert.ok(byTerm.has('量子退火'))
  assert.ok(byTerm.has('mimo'))
  assert.ok(byTerm.has('deepseek'))
  assert.ok(byTerm.has('v0.2.13'))
  assert.equal(byTerm.get('量子退火')?.priority, 2.2)
})

test('群聊：中文 n-gram 必须重复出现', () => {
  const once = extractChatTerms([{ text: '今天聊到了拓扑绝缘体', userId: 'u1' }])
  assert.equal(once.some((t) => t.term.includes('拓扑绝缘体')), false)

  const twice = extractChatTerms([
    { text: '拓扑绝缘体挺有意思', userId: 'u1' },
    { text: '拓扑绝缘体是什么', userId: 'u2' },
  ])
  assert.ok(twice.some((t) => t.term === '拓扑绝缘体'))
})

test('群聊：寒暄与虚词边界不进候选', () => {
  const terms = extractChatTerms([
    { text: '哈哈哈哈这个真的很不错', userId: 'u1' },
    { text: '哈哈哈哈这个真的很不错', userId: 'u2' },
    { text: '我们的项目', userId: 'u1' },
    { text: '我们的项目', userId: 'u2' },
  ])
  assert.equal(terms.some((t) => t.term.includes('哈哈')), false)
  assert.equal(terms.some((t) => t.term.startsWith('我们')), false)
})

test('群聊：全小写 Latin 需要重复出现', () => {
  const once = extractChatTerms([{ text: '看看 tauri 的文档', userId: 'u1' }])
  assert.equal(once.some((t) => normalizeTerm(t.term) === 'tauri'), false)

  const twice = extractChatTerms([
    { text: '看看 tauri 的文档', userId: 'u1' },
    { text: 'tauri 打包有点慢', userId: 'u2' },
  ])
  assert.ok(twice.some((t) => normalizeTerm(t.term) === 'tauri'))
})

test('笔记：标题/列表/待查行直接取词', () => {
  const terms = extractNoteTerms(
    ['# 待研究的方向', '- 量子退火：周末查一下', '- 普通记录：Rust 所有权', '## 想查：MXene 的制备'].join('\n'),
  )
  const byTerm = new Map(terms.map((t) => [normalizeTerm(t.term), t]))
  assert.ok(byTerm.has('待研究的方向'))
  assert.ok(byTerm.has('量子退火'))
  assert.equal(byTerm.get('量子退火')?.reason, 'note_pending')
  assert.ok(byTerm.has('mxene'))
  assert.ok(byTerm.has('rust'))
})
