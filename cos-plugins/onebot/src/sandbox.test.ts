// 回合沙箱单测：来源判定、混合批次保守规则、可见性过滤、执行否决。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TurnSandbox,
  allowedToolNames,
  allowedToolNamesForSource,
  canSteerInto,
  filterToolsForTurn,
  isForbiddenTool,
  isOnebotDetail,
  isOwnerPrivateSource,
  isOwnerTool,
  parseOnebotSource,
  turnToolPolicy,
  vetoIfActive,
} from './sandbox.ts'

test('来源判定：只认 onebot: 前缀', () => {
  assert.equal(isOnebotDetail('onebot:g123:456'), true)
  assert.equal(isOnebotDetail('onebot:u456'), true)
  assert.equal(isOnebotDetail('peer:abc'), false)
  assert.equal(isOnebotDetail('group:g1'), false)
  assert.equal(isOnebotDetail(undefined), false)
  assert.equal(isOnebotDetail('xonebot:g1'), false)
})

test('来源解析：群/私聊/坏格式', () => {
  assert.deepEqual(parseOnebotSource('onebot:g123:456'), { kind: 'group', groupId: '123', userId: '456' })
  assert.deepEqual(parseOnebotSource('onebot:g123:-'), { kind: 'group', groupId: '123', userId: '' })
  assert.deepEqual(parseOnebotSource('onebot:u456'), { kind: 'private', userId: '456' })
  assert.equal(parseOnebotSource('onebot:g'), undefined)
  assert.equal(parseOnebotSource('onebot:x1'), undefined)
  assert.equal(parseOnebotSource('peer:u1'), undefined)
  assert.equal(parseOnebotSource(undefined), undefined)
})

test('回合状态机：OneBot 消息认领后激活，turn/end 清除', () => {
  const sandbox = new TurnSandbox()
  assert.equal(sandbox.isActive(), false)
  const source = sandbox.markClaimed([{ source: { detail: 'onebot:g1:2' } }])
  assert.deepEqual(source, { kind: 'group', groupId: '1', userId: '2' })
  assert.equal(sandbox.isActive(), true)
  assert.deepEqual(sandbox.currentSource(), source)
  // 已激活时不重复返回来源（避免重复广播）
  assert.equal(sandbox.markClaimed([{ source: { detail: 'onebot:g1:3' } }]), undefined)
  sandbox.markTurnEnd()
  assert.equal(sandbox.isActive(), false)
  assert.equal(sandbox.currentSource(), undefined)
})

test('混合批次保守：本地+OneBot 同批 → 整回合受限', () => {
  const sandbox = new TurnSandbox()
  sandbox.markClaimed([
    { source: { detail: 'human' } },
    { source: { detail: 'onebot:g9:8' } },
  ])
  assert.equal(sandbox.isActive(), true)
})

test('纯本地批次不激活', () => {
  const sandbox = new TurnSandbox()
  sandbox.markClaimed([{ source: {} }, { source: { detail: 'group:g1' } }])
  assert.equal(sandbox.isActive(), false)
})

const wireTools = [
  { type: 'function', function: { name: 'send_qq_group' } },
  { type: 'function', function: { name: 'stay_silent' } },
  { type: 'function', function: { name: 'write' } },
  { type: 'function', function: { name: 'read' } },
  { type: 'function', function: { name: 'web_search' } },
]

test('可见性：受限回合只留基座+增量，顺序保持', () => {
  const allowed = allowedToolNames(['web_search'])
  const visible = filterToolsForTurn(wireTools, true, allowed)
  assert.deepEqual(visible.map((t) => t.function.name), ['send_qq_group', 'stay_silent', 'read', 'web_search'])
})

test('可见性：非受限回合原样放行', () => {
  const visible = filterToolsForTurn(wireTools, false, [])
  assert.equal(visible.length, wireTools.length)
})

test('执行否决：受限回合点名隐藏工具被拒，白名单放行', () => {
  const allowed = allowedToolNames([])
  assert.match(vetoIfActive('write', true, allowed) ?? '', /不可用/)
  assert.equal(vetoIfActive('send_qq_group', true, allowed), undefined)
  assert.equal(vetoIfActive('stay_silent', true, allowed), undefined)
  assert.equal(vetoIfActive('web_search', true, allowed), undefined)
  assert.equal(vetoIfActive('web_explore', true, allowed), undefined)
  assert.equal(vetoIfActive('recall', true, allowed), undefined)
  assert.equal(vetoIfActive('remember', true, allowed), undefined)
  // 非受限回合任何工具都放行
  assert.equal(vetoIfActive('write', false, allowed), undefined)
})

test('硬禁：本机控制/任意 URL 工具即使被配置也不放行', () => {
  // read 已移入「受限可见」层（fs-jail.ts 路径囚笼），不再整类硬禁。
  for (const name of ['sh', 'write', 'edit', 'web_read', 'screenshot', 'restart_agent', 'send_to_peer', 'mcp__x__y']) {
    assert.equal(isForbiddenTool(name), true, name)
  }
  const allowed = allowedToolNames(['sh', 'write', 'web_read', 'mcp__x__y'])
  assert.equal(allowed.includes('sh'), false)
  assert.equal(allowed.includes('write'), false)
  assert.equal(allowed.includes('web_read'), false)
  assert.match(vetoIfActive('sh', true, allowed) ?? '', /永久不可用/)
  assert.match(vetoIfActive('web_read', true, allowed) ?? '', /永久不可用/)
})

test('主人私聊判定：私聊且在 ownerIds 才算；群内主人走基线', () => {
  const owners = ['10086']
  assert.equal(isOwnerPrivateSource({ kind: 'private', userId: '10086' }, owners), true)
  assert.equal(isOwnerPrivateSource({ kind: 'private', userId: '10000' }, owners), false)
  assert.equal(isOwnerPrivateSource({ kind: 'group', groupId: '1', userId: '10086' }, owners), false)
  assert.equal(isOwnerPrivateSource(undefined, owners), false)
})

test('回合工具面：主人私聊不受限，其余来源仍走基座 + 主人专属工具', () => {
  const owners = ['10001']
  const base = allowedToolNames([])
  const ownerPrivate = turnToolPolicy(base, { kind: 'private', userId: '10001' }, owners)
  assert.deepEqual(ownerPrivate, { restricted: false, allowed: [] })

  for (const source of [
    { kind: 'private' as const, userId: '20002' },
    { kind: 'group' as const, groupId: '1', userId: '10001' },
    { kind: 'group' as const, groupId: '1', userId: '20002' },
  ]) {
    const policy = turnToolPolicy(base, source, owners)
    assert.equal(policy.restricted, true)
    assert.ok(policy.allowed.includes('send_qq_group'))
  }
  // 主人群回合仍拿提示词工具（受限但额外放行）；陌生私聊没有。
  assert.ok(
    turnToolPolicy(base, { kind: 'group', groupId: '1', userId: '10001' }, owners)
      .allowed.includes('revise_prompt'),
  )
  assert.equal(
    turnToolPolicy(base, { kind: 'private', userId: '20002' }, owners)
      .allowed.includes('revise_prompt'),
    false,
  )
})

test('主人发起的回合专属工具：普通群友/陌生私聊不可通过配置放行', () => {
  const base = allowedToolNames(['revise_prompt', 'list_prompt_slots'])
  assert.equal(base.includes('revise_prompt'), false)
  assert.equal(base.includes('list_prompt_slots'), false)
  assert.equal(isOwnerTool('revise_prompt'), true)

  // 主人在群里发起、主人私聊发起：都放行
  for (const source of [
    { kind: 'group' as const, groupId: '1', userId: '10001' },
    { kind: 'private' as const, userId: '10001' },
  ]) {
    const allowed = allowedToolNamesForSource(base, source, ['10001'])
    assert.equal(allowed.includes('revise_prompt'), true)
    assert.equal(allowed.includes('list_prompt_slots'), true)
  }

  // 群友发起、陌生人私聊、无具体发送者的群背景唤醒：都不放行
  for (const source of [
    { kind: 'group' as const, groupId: '1', userId: '20002' },
    { kind: 'private' as const, userId: '20002' },
    { kind: 'group' as const, groupId: '1', userId: '' },
  ]) {
    const allowed = allowedToolNamesForSource(base, source, ['10001'])
    assert.equal(allowed.includes('revise_prompt'), false)
    assert.equal(allowed.includes('list_prompt_slots'), false)
  }
})

test('主人发起时可见并可执行提示词工具；群友发起时隐藏且被拒', () => {
  const base = allowedToolNames([])
  const tools = [
    { type: 'function', function: { name: 'revise_prompt' } },
    { type: 'function', function: { name: 'send_qq_group' } },
  ]
  const ownerGroupAllowed = allowedToolNamesForSource(
    base,
    { kind: 'group', groupId: '1', userId: '10001' },
    ['10001'],
  )
  assert.deepEqual(
    filterToolsForTurn(tools, true, ownerGroupAllowed).map((t) => t.function.name),
    ['revise_prompt', 'send_qq_group'],
  )
  assert.equal(vetoIfActive('revise_prompt', true, ownerGroupAllowed), undefined)

  const strangerGroupAllowed = allowedToolNamesForSource(
    base,
    { kind: 'group', groupId: '1', userId: '20002' },
    ['10001'],
  )
  assert.deepEqual(
    filterToolsForTurn(tools, true, strangerGroupAllowed).map((t) => t.function.name),
    ['send_qq_group'],
  )
  assert.match(vetoIfActive('revise_prompt', true, strangerGroupAllowed) ?? '', /不可用/)
})

test('拒因文案列出可用工具，便于模型自纠', () => {
  const veto = vetoIfActive('write', true, allowedToolNames([]))
  assert.match(veto ?? '', /send_qq_group/)
  assert.match(veto ?? '', /stay_silent/)
})

test('忙时插话准入：来源域一致（同群+同主人属性 / 同一私聊用户）才允许 steer', () => {
  const owners = ['10001']
  const groupA = { kind: 'group' as const, groupId: '1', userId: '20002' }
  const groupAOther = { kind: 'group' as const, groupId: '1', userId: '30003' }
  const groupAOwner = { kind: 'group' as const, groupId: '1', userId: '10001' }
  const groupB = { kind: 'group' as const, groupId: '2', userId: '20002' }
  const privateA = { kind: 'private' as const, userId: '20002' }
  const privateAOwner = { kind: 'private' as const, userId: '10001' }
  const privateB = { kind: 'private' as const, userId: '30003' }

  // 无活动回合（本地桌面）：不插话
  assert.equal(canSteerInto(groupA, undefined, owners), false)
  // 同群且主人属性一致：放行（同群不同群友合批，命名空间与工具面一致）
  assert.equal(canSteerInto(groupAOther, groupA, owners), true)
  // 跨群：命名空间不同，排队
  assert.equal(canSteerInto(groupB, groupA, owners), false)
  // 同群但主人属性不同：主人工具面不同，排队
  assert.equal(canSteerInto(groupAOwner, groupA, owners), false)
  assert.equal(canSteerInto(groupA, groupAOwner, owners), false)
  // 私聊：同一用户放行；不同用户 / 群私跨类型排队
  assert.equal(canSteerInto(privateA, privateA, owners), true)
  assert.equal(canSteerInto(privateAOwner, privateAOwner, owners), true)
  assert.equal(canSteerInto(privateB, privateA, owners), false)
  assert.equal(canSteerInto(privateA, groupA, owners), false)
  assert.equal(canSteerInto(groupA, privateA, owners), false)
})
