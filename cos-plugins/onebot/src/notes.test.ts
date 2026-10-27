// 笔记纯逻辑单测：作用域映射、路径校验、来源头、回合预算。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NotePathError,
  NOTE_MAX_TURN_APPENDS,
  NOTE_MAX_TURN_BYTES,
  formatNoteBlock,
  noteBudgetVeto,
  noteScopeDir,
  parseNotePath,
} from './notes.ts'

test('作用域目录：群/私聊/主人私聊与非法 ID', () => {
  assert.equal(noteScopeDir(undefined, []), 'owner')
  assert.equal(noteScopeDir({ kind: 'group', groupId: '123', userId: '456' }, []), 'group-123')
  assert.equal(noteScopeDir({ kind: 'private', userId: '456' }, ['456']), 'owner')
  assert.equal(noteScopeDir({ kind: 'private', userId: '456' }, ['999']), 'private-456')
  // 非数字 ID 走哈希，不能把分隔符/.. 带进目录名。
  const weird = noteScopeDir({ kind: 'private', userId: '../../etc' }, [])
  assert.match(weird, /^private-[0-9a-f]{16}$/)
  assert.notEqual(weird, noteScopeDir({ kind: 'private', userId: '..\\etc' }, []))
})

test('路径校验：允许嵌套/文本扩展名，拒绝绝对路径、..、隐藏名、保留名与非法扩展', () => {
  assert.deepEqual(parseNotePath('diary/2026-10-27.md'), {
    segments: ['diary'],
    file: '2026-10-27.md',
    rel: 'diary/2026-10-27.md',
  })
  assert.deepEqual(parseNotePath('topics\\rust.md'), {
    segments: ['topics'],
    file: 'rust.md',
    rel: 'topics/rust.md',
  })
  assert.equal(parseNotePath('README').file, 'README')
  assert.equal(parseNotePath('log.jsonl').file, 'log.jsonl')
  assert.equal(parseNotePath('a/b/c/x.txt').segments.length, 3)

  for (const bad of ['', ' ', '/etc/passwd', 'C:/x.md', '../x.md', 'a/../x.md', 'a//x.md', 'a/./x.md']) {
    assert.throws(() => parseNotePath(bad), NotePathError, bad)
  }
  for (const bad of ['a/.hidden.md', 'a/b/c/d/x.md', 'x.exe', 'x.md ', 'con.md', 'a:b.md', 'x?y.md']) {
    assert.throws(() => parseNotePath(bad), NotePathError, bad)
  }
  for (const reserved of ['secrets.yml', 'secrets.yaml', 'group-sent.jsonl', 'cos-settings.json', 'instances.json']) {
    assert.throws(() => parseNotePath(reserved), NotePathError, reserved)
  }
  assert.throws(() => parseNotePath(42), NotePathError)
  assert.throws(() => parseNotePath(`${'x'.repeat(49)}.md`), NotePathError)
})

test('来源头：md 注释、txt 方括号、jsonl 不加头；正文保证换行', () => {
  const at = new Date('2026-10-27T00:00:00.000Z')
  const source = { kind: 'group' as const, groupId: '123', userId: '456' }

  const md = formatNoteBlock('hello', { at, source }, 'diary.md')
  assert.match(md, /^<!-- 2026-10-27T00:00:00.000Z \| group:123 -->\nhello\n$/)

  const txt = formatNoteBlock('hello\n', { at, source }, 'note.txt')
  assert.match(txt, /^\[2026-10-27T00:00:00.000Z \| group:123\]\nhello\n$/)

  const jsonl = formatNoteBlock('{"a":1}', { at, source }, 'log.jsonl')
  assert.equal(jsonl, '{"a":1}\n')

  const private_ = formatNoteBlock('x', { at, source: { kind: 'private', userId: '9' } }, 'a.md')
  assert.match(private_, /private:9/)

  // 外部事件里的 id 带控制字符时，来源头不能出现第二行。
  const weird = formatNoteBlock('x', { at, source: { kind: 'group', groupId: '1\n2', userId: '3' } }, 'a.md')
  assert.match(weird.split('\n')[0]!, /group:1\?2/)

  assert.throws(() => formatNoteBlock('a\u0000b', { at, source }, 'a.md'), NotePathError)
})

test('回合预算：次数与字节双上限，边界值放行', () => {
  assert.equal(noteBudgetVeto({ appends: 0, bytes: 0 }, NOTE_MAX_TURN_BYTES), undefined)
  assert.match(noteBudgetVeto({ appends: 0, bytes: 1 }, NOTE_MAX_TURN_BYTES) ?? '', /额度不足/)
  assert.match(noteBudgetVeto({ appends: NOTE_MAX_TURN_APPENDS, bytes: 0 }, 1) ?? '', /次数/)
})
