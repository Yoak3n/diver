// @diver/self-prompt — 纯逻辑冒烟：parsePromptFile / mergePromptSlots。
// 运行：pnpm --dir cos-plugins/self-prompt smoke

import { join } from 'node:path'
import { parsePromptFile, mergePromptSlots, collectLiveSlots, sectionNameOf, SECTION_PREFIX, MAX_PROMPT_BYTES } from '../src/prompts.ts'

function assert(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`FAIL ${label}`)
    process.exitCode = 1
  } else {
    console.log(`ok   ${label}`)
  }
}

const good = `---
order: 110
name: style
---
你好呀`

const r1 = parsePromptFile(good, 'fallback')
assert(r1.ok && r1.slot.order === 110 && r1.slot.name === 'style' && r1.slot.text === '你好呀', 'parse ok')

const r2 = parsePromptFile('---\nname: x\n---\nbody', 'x')
assert(!r2.ok && r2.error.includes('order'), 'missing order rejected')

const r3 = parsePromptFile('---\norder: 1.5\n---\nbody', 'x')
assert(!r3.ok && r3.error.includes('整数'), 'non-integer order rejected')

const r4 = parsePromptFile('---\norder: 1\n---\n\n', 'x')
assert(!r4.ok && r4.error.includes('正文'), 'empty body rejected')

const r5 = parsePromptFile('no frontmatter', 'x')
assert(!r5.ok, 'missing frontmatter rejected')

const r6 = parsePromptFile(`---\norder: 1\n---\n${'x'.repeat(MAX_PROMPT_BYTES)}`, 'x')
assert(!r6.ok && r6.error.includes('过大'), 'oversize rejected')

const r7 = parsePromptFile('---\norder: 5\n---\nbody', 'file-name')
assert(r7.ok && r7.slot.name === 'file-name', 'fallback name from filename')

const merged = mergePromptSlots(
  [
    { name: 'a', order: 10, text: 'A1', source: 'a' },
    { name: 'b', order: 20, text: 'B1', source: 'b' },
  ],
  [{ name: 'a', order: 10, text: 'A2', source: 'override-a' }],
)
assert(merged.length === 2, 'merge dedupes by name')
assert(merged[0].name === 'a' && merged[0].text === 'A2', 'override wins')
assert(merged[0].order === 10 && merged[1].order === 20, 'sorted by order')

assert(sectionNameOf('style') === `${SECTION_PREFIX}style`, 'section name prefix')
const live = collectLiveSlots(
  join(import.meta.dirname, '..', 'prompts'),
  join(import.meta.dirname, '..', 'no-such-override'),
)
assert(live.errors.length === 0, 'missing override dir is not an error')
assert(live.slots.length >= 1 && live.slots[0].name === 'style', 'collectLiveSlots reads bundled')
assert(live.slots[0].order === 110, 'bundled style order 110')

console.log(process.exitCode === 1 ? 'smoke FAILED' : 'smoke passed')
