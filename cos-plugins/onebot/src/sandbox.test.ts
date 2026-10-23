// 回合沙箱单测：来源判定、混合批次保守规则、可见性过滤、执行否决。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TurnSandbox,
  allowedToolNames,
  filterToolsForTurn,
  isOnebotDetail,
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

test('回合状态机：OneBot 消息认领后激活，turn/end 清除', () => {
  const sandbox = new TurnSandbox()
  assert.equal(sandbox.isActive(), false)
  sandbox.markClaimed([{ source: { detail: 'onebot:g1:2' } }])
  assert.equal(sandbox.isActive(), true)
  sandbox.markTurnEnd()
  assert.equal(sandbox.isActive(), false)
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
  assert.deepEqual(visible.map((t) => t.function.name), ['send_qq_group', 'stay_silent', 'web_search'])
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
  // 非受限回合任何工具都放行
  assert.equal(vetoIfActive('write', false, allowed), undefined)
})

test('拒因文案列出可用工具，便于模型自纠', () => {
  const veto = vetoIfActive('write', true, allowedToolNames([]))
  assert.match(veto ?? '', /send_qq_group/)
  assert.match(veto ?? '', /stay_silent/)
})
