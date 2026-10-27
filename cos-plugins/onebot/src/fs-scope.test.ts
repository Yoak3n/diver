// fs-scope 接线测试：按来源分策略、笔记根创建、主人私聊全开、坏根 fail-closed。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fsVetoReason } from './fs-jail.ts'
import { createFsScope } from './fs-scope.ts'
import { noteScopeDir } from './notes.ts'

test('按来源分策略：群 scope 各自豁免，主人私聊不额外 deny', async () => {
  const cos = await realpath(await mkdtemp(join(tmpdir(), 'diver-fs-scope-')))
  try {
    const scope = createFsScope({ cosHome: cos, extraRoots: [] })
    const notesRoot = await scope.notesRoot()
    assert.ok(notesRoot)
    assert.equal(notesRoot, join(cos, 'notes'))
    assert.equal(await scope.workspaceBase(), join(cos, 'workspace'))

    const groupA = { kind: 'group' as const, groupId: '123', userId: '456' }
    const groupB = { kind: 'group' as const, groupId: '999', userId: '456' }
    const a = await scope.policyFor(groupA, [])
    const b = await scope.policyFor(groupB, [])
    assert.deepEqual(a.allowedSubtrees, [join(notesRoot, noteScopeDir(groupA, []))])
    assert.deepEqual(b.allowedSubtrees, [join(notesRoot, noteScopeDir(groupB, []))])
    assert.equal(await scope.policyFor(groupA, []), a) // 同一 scope 复用对象

    const owner = await scope.policyFor({ kind: 'private', userId: '456' }, ['456'])
    assert.deepEqual(owner.deniedSubtrees, [])
    assert.deepEqual(owner.allowedSubtrees, [])

    const other = join(notesRoot, 'group-999', 'x.md')
    assert.match(fsVetoReason(notesRoot, notesRoot, a) ?? '', /不可读的目录/)
    assert.match(fsVetoReason(other, other, a) ?? '', /不可读的目录/)
    assert.equal(fsVetoReason(other, other, owner), undefined)
  } finally {
    await rm(cos, { recursive: true, force: true })
  }
})

test('notes 根是符号链接时关闭笔记并锁死已知路径', async () => {
  const cos = await realpath(await mkdtemp(join(tmpdir(), 'diver-fs-scope-link-')))
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'diver-fs-scope-link-out-')))
  try {
    await symlink(outside, join(cos, 'notes'))
    const scope = createFsScope({ cosHome: cos, extraRoots: [] })
    assert.equal(await scope.notesRoot(), undefined)

    const policy = await scope.policyFor({ kind: 'group', groupId: '1', userId: '2' }, [])
    assert.deepEqual(policy.allowedSubtrees, [])
    const probe = join(cos, 'notes', 'x.md')
    assert.match(fsVetoReason(probe, probe, policy) ?? '', /不可读的目录/)
  } finally {
    await rm(cos, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
