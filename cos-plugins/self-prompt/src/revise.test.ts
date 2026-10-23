// 提示词槽位专用工具单测：参数校验、frontmatter、覆盖层写入、大小上限、路径逃逸。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_PROMPT_BYTES } from './prompts.ts'
import {
  formatPromptFile,
  listPromptSlots,
  parseReviseInput,
  writePromptOverride,
} from './revise.ts'

test('参数校验：slot 白名单、order 整数、body 非空', () => {
  assert.deepEqual(parseReviseInput({ slot: 'style', order: 110, body: '  hello  ' }), {
    slot: 'style',
    order: 110,
    body: 'hello',
  })
  for (const slot of ['', '../x', 'Style', 'a/b', 'a b', 'x'.repeat(65)]) {
    assert.ok('error' in (parseReviseInput({ slot, order: 1, body: 'x' }) as { error: string }), slot)
  }
  assert.ok('error' in (parseReviseInput({ slot: 'style', order: 1.5, body: 'x' }) as { error: string }))
  assert.ok('error' in (parseReviseInput({ slot: 'style', order: 1, body: '   ' }) as { error: string }))
})

test('frontmatter：order/name/正文齐全', () => {
  const raw = formatPromptFile('style', 110, '短句为主。\n')
  assert.match(raw, /^---\norder: 110\nname: style\n---\n/)
  assert.match(raw, /短句为主。/)
})

test('覆盖层写入：list_prompt_slots 标记 override 且同名覆盖 bundled', () => {
  const root = mkdtempSync(join(tmpdir(), 'diver-self-prompt-'))
  const bundled = join(root, 'bundled')
  const overrides = join(root, 'override')
  try {
    mkdirSync(bundled, { recursive: true })
    writeFileSync(join(bundled, 'style.md'), '---\norder: 100\nname: style\n---\n旧风格\n', 'utf8')
    writeFileSync(join(bundled, 'extra.md'), '---\norder: 120\nname: extra\n---\n额外\n', 'utf8')

    const result = writePromptOverride(overrides, { slot: 'style', order: 110, body: '新风格\n' })
    assert.equal(result.ok, true)

    const file = readFileSync(join(overrides, 'style.md'), 'utf8')
    assert.match(file, /order: 110/)
    assert.match(file, /新风格/)

    const listed = listPromptSlots(bundled, overrides)
    assert.deepEqual(listed.errors, [])
    const style = listed.slots.find((s) => s.slot === 'style')
    assert.equal(style?.order, 110)
    assert.equal(style?.source, 'override')
    const extra = listed.slots.find((s) => s.slot === 'extra')
    assert.equal(extra?.source, 'bundled')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('路径逃逸被拒，大小上限生效', () => {
  const root = mkdtempSync(join(tmpdir(), 'diver-self-prompt-'))
  try {
    const escaped = writePromptOverride(root, { slot: '../evil', order: 1, body: 'x' })
    assert.equal(escaped.ok, false)

    const tooLarge = writePromptOverride(root, {
      slot: 'huge',
      order: 1,
      body: 'x'.repeat(MAX_PROMPT_BYTES),
    })
    assert.equal(tooLarge.ok, false)
    if (!tooLarge.ok) assert.match(tooLarge.error, /过大/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
