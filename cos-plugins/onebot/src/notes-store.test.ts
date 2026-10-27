// 笔记落盘单测：建目录、追加不覆盖、符号链接拒绝、容量闸。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtemp, readFile, realpath, rm, stat, symlink, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatNoteBlock, parseNotePath } from './notes.ts'
import {
  appendNote,
  ensureScopeRoot,
  prepareNotesRoot,
  type NoteStoreCaps,
} from './notes-store.ts'

const SOURCE = { kind: 'group' as const, groupId: '1', userId: '2' }
const AT = new Date('2026-10-27T00:00:00.000Z')
const block = (text: string, file = 'diary.md'): string =>
  formatNoteBlock(text, { at: AT, source: SOURCE }, file)

async function setup(tag: string) {
  const cos = await realpath(await mkdtemp(join(tmpdir(), `diver-notes-${tag}-`)))
  const notesRoot = await prepareNotesRoot(cos)
  const scopeRoot = await ensureScopeRoot(notesRoot, 'group-1')
  return { cos, notesRoot, scopeRoot }
}

test('追加会创建父目录、保留旧内容，并返回真实字节数', async () => {
  const { cos, scopeRoot } = await setup('append')
  try {
    const path = parseNotePath('diary/2026-10-27.md')
    const first = await appendNote(scopeRoot, path, block('hello'))
    assert.equal(first.path, join(scopeRoot, 'diary', '2026-10-27.md'))
    assert.equal(first.scopeEntries, 2) // diary/ + 文件
    assert.equal((await stat(first.path)).size, first.fileBytes)
    assert.match(await readFile(first.path, 'utf8'), /hello/)

    const second = await appendNote(scopeRoot, path, block('world'))
    const text = await readFile(first.path, 'utf8')
    assert.ok(text.indexOf('hello') < text.indexOf('world'))
    assert.match(text, /hello[\s\S]*world/)
    assert.ok(second.appendedBytes > 0)
    assert.equal(second.scopeBytes, first.scopeBytes + second.appendedBytes)
  } finally {
    await rm(cos, { recursive: true, force: true })
  }
})

test('jsonl 不写来源头，保持逐行 JSON', async () => {
  const { cos, scopeRoot } = await setup('jsonl')
  try {
    const path = parseNotePath('log.jsonl')
    await appendNote(scopeRoot, path, block('{"a":1}', 'log.jsonl'))
    const text = await readFile(join(scopeRoot, 'log.jsonl'), 'utf8')
    assert.equal(text, '{"a":1}\n')
  } finally {
    await rm(cos, { recursive: true, force: true })
  }
})

test('已有文件不会被截断；缺少尾换行时自动补分隔', async () => {
  const { cos, scopeRoot } = await setup('existing')
  try {
    const path = parseNotePath('existing.md')
    await writeFile(join(scopeRoot, 'existing.md'), 'original')
    await appendNote(scopeRoot, path, block('added'))
    const text = await readFile(join(scopeRoot, 'existing.md'), 'utf8')
    assert.ok(text.startsWith('original'))
    assert.match(text, /original\n\n<!--/)
    assert.match(text, /added/)
  } finally {
    await rm(cos, { recursive: true, force: true })
  }
})

test('符号链接目录/文件一律拒绝，且不碰链接目标', async () => {
  const { cos, scopeRoot } = await setup('symlink')
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'diver-notes-out-')))
  try {
    await writeFile(join(outside, 'secret.md'), 'x')
    await symlink(outside, join(scopeRoot, 'linkdir'))
    await assert.rejects(
      () => appendNote(scopeRoot, parseNotePath('linkdir/x.md'), block('x')),
      /不是普通目录/,
    )
    await symlink(join(outside, 'secret.md'), join(scopeRoot, 'linkfile.md'))
    await assert.rejects(
      () => appendNote(scopeRoot, parseNotePath('linkfile.md'), block('x')),
      /不是普通文件/,
    )
    assert.equal(await readFile(join(outside, 'secret.md'), 'utf8'), 'x')
  } finally {
    await rm(cos, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('容量闸：单文件、条目数、作用域总字节', async () => {
  const { cos, scopeRoot } = await setup('caps')
  try {
    const fileCaps: NoteStoreCaps = { maxEntries: 10, maxFileBytes: 40, maxScopeBytes: 1_000 }
    await assert.rejects(
      () => appendNote(scopeRoot, parseNotePath('big.md'), block('x'.repeat(60)), fileCaps),
      /文件已满/,
    )

    const entryCaps: NoteStoreCaps = { maxEntries: 1, maxFileBytes: 1_000, maxScopeBytes: 5_000 }
    await appendNote(scopeRoot, parseNotePath('one.md'), block('a'), entryCaps)
    await assert.rejects(
      () => appendNote(scopeRoot, parseNotePath('two.md'), block('b'), entryCaps),
      /条目过多/,
    )

    const scopeCaps: NoteStoreCaps = { maxEntries: 10, maxFileBytes: 1_000, maxScopeBytes: 40 }
    await assert.rejects(
      () => appendNote(scopeRoot, parseNotePath('scope.md'), block('x'.repeat(50)), scopeCaps),
      /作用域已满/,
    )
  } finally {
    await rm(cos, { recursive: true, force: true })
  }
})

test('根与作用域目录的符号链接拒绝', async () => {
  const cos = await realpath(await mkdtemp(join(tmpdir(), 'diver-notes-root-')))
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'diver-notes-root-out-')))
  const scopeSetup = await setup('scope-link')
  try {
    await symlink(outside, join(cos, 'notes'))
    await assert.rejects(() => prepareNotesRoot(cos), /不是普通目录/)

    const { notesRoot } = scopeSetup
    await symlink(outside, join(notesRoot, 'evil'))
    await assert.rejects(() => ensureScopeRoot(notesRoot, 'evil'), /不是普通目录/)
    await assert.rejects(() => ensureScopeRoot(notesRoot, '../x'), /非法笔记作用域/)
  } finally {
    await rm(cos, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    await rm(scopeSetup.cos, { recursive: true, force: true })
  }
})

test('POSIX 下目录 0700、文件 0600', async () => {
  if (process.platform === 'win32') return
  const { cos, scopeRoot } = await setup('mode')
  try {
    const path = parseNotePath('diary/2026-10-27.md')
    const result = await appendNote(scopeRoot, path, block('hello'))
    assert.equal((await stat(join(scopeRoot, 'diary'))).mode & 0o777, 0o700)
    assert.equal((await stat(result.path)).mode & 0o777, 0o600)
  } finally {
    await rm(cos, { recursive: true, force: true })
  }
})
