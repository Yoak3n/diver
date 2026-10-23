// 记忆作用域单测：群/私聊/主人的读写命名空间与召回边界。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  allowsEntities,
  isOtherGroupScope,
  isRawScope,
  recallPolicy,
  scopeFilter,
  writeScope,
} from './turn-scope.ts'

test('写入作用域：本地/主人私聊 owner，群写本群，陌生人私聊写 private', () => {
  assert.equal(writeScope(undefined), 'owner')
  assert.equal(writeScope({ active: true, kind: 'group', groupId: '123', userId: '1' }), 'group:123')
  assert.equal(writeScope({ active: true, kind: 'private', userId: '10001', isOwner: true }), 'owner')
  assert.equal(writeScope({ active: true, kind: 'private', userId: '20002', isOwner: false }), 'private:20002')
})

test('群回合：本群+global 原文，其他群模糊，owner/private 排除', () => {
  const policy = recallPolicy({ active: true, kind: 'group', groupId: '123', userId: '1' })
  assert.deepEqual(policy, { mode: 'group', groupId: '123' })
  assert.equal(isRawScope('global', policy), true)
  assert.equal(isRawScope('group:123', policy), true)
  assert.equal(isRawScope('group:999', policy), false)
  assert.equal(isRawScope('owner', policy), false)
  assert.equal(isRawScope('private:9', policy), false)

  assert.equal(isOtherGroupScope('group:999', policy), true)
  assert.equal(isOtherGroupScope('group:123', policy), false)
  assert.equal(isOtherGroupScope('owner', policy), false)
  assert.equal(allowsEntities(policy), false)
})

test('陌生人私聊：只读 global + 自己的 private，不碰 owner/其他群', () => {
  const policy = recallPolicy({ active: true, kind: 'private', userId: '20002', isOwner: false })
  assert.deepEqual(policy, { mode: 'private', userId: '20002' })
  assert.equal(isRawScope('global', policy), true)
  assert.equal(isRawScope('private:20002', policy), true)
  assert.equal(isRawScope('owner', policy), false)
  assert.equal(isRawScope('group:123', policy), false)
  assert.equal(allowsEntities(policy), false)
})

test('主人私聊/本地：全量原文，实体可用', () => {
  const owner = recallPolicy({ active: true, kind: 'private', userId: '10001', isOwner: true })
  assert.deepEqual(owner, { mode: 'owner' })
  assert.equal(isRawScope('owner', owner), true)
  assert.equal(isRawScope('group:123', owner), true)
  assert.equal(allowsEntities(owner), true)
  assert.equal(allowsEntities(recallPolicy(undefined)), true)
})

test('Rust 过滤参数：群排除 owner/private 前缀，私聊只 include 允许项', () => {
  const group = scopeFilter({ mode: 'group', groupId: '123' })
  assert.deepEqual(group.excludeScopes, ['owner'])
  assert.deepEqual(group.excludeScopePrefixes, ['private:'])
  assert.equal(group.scopes, undefined)

  const priv = scopeFilter({ mode: 'private', userId: '20002' })
  assert.deepEqual(priv.scopes, ['global', 'private:20002'])
  assert.equal(priv.excludeScopes, undefined)
})
