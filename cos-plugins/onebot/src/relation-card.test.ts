// QQ 安全卡片单测：只保留主人标识与浅层边界，并正确替换记忆插件 section。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MEMORY_RELATION_CARD,
  SAFE_RELATION_CARD,
  replaceRelationCard,
  safeRelationCard,
} from './relation-card.ts'

test('群回合：保留群号/主人判定，不携带画像，也不暴露主人号码', () => {
  const text = safeRelationCard({ kind: 'group', groupId: '123', userId: '10001' }, ['10001'])
  assert.match(text, /QQ 群 123/)
  // 主人本人触发：判定行如实，但卡片不出现任何主人 QQ 号
  assert.match(text, /本条消息来自主人/)
  assert.doesNotMatch(text, /10001/)
  assert.match(text, /其他群的记忆只给模糊轮廓/)
  assert.doesNotMatch(text, /关于用户：|【近期共同经历】|【未完成承诺】/)
})

test('浅层字段：只保留名字，性格/说话方式交给 self-prompt', () => {
  const text = safeRelationCard(
    { kind: 'group', groupId: '123', userId: '1' },
    ['10001'],
    { name: '小潜' },
  )
  assert.match(text, /你的名字：小潜/)
  // 性格与说话方式由 prompts/*.md 注入，安全卡片不重复
  assert.doesNotMatch(text, /性格与说话方式|话少|关于用户：|【近期共同经历】|【未完成承诺】/)
})

test('非主人私聊：不冒充主人，也不暴露群信息与主人号码', () => {
  const text = safeRelationCard({ kind: 'private', userId: '20002' }, ['10001'])
  assert.match(text, /QQ 用户 20002 私聊/)
  assert.match(text, /本条消息不是主人发的/)
  assert.doesNotMatch(text, /10001/)
  assert.doesNotMatch(text, /QQ 群/)
})

test('无具体发送者（群背景唤醒）：不误判为主人或非主人', () => {
  const text = safeRelationCard({ kind: 'group', groupId: '123', userId: '' }, ['10001'])
  assert.match(text, /本回合由群聊背景触发/)
  assert.doesNotMatch(text, /本条消息不是主人发的/)
})

test('未配置主人：明确要求不要猜测', () => {
  const text = safeRelationCard({ kind: 'private', userId: '20002' }, [])
  assert.match(text, /主人 QQ 号尚未配置/)
})

test('替换 relation-card：移除原卡、追加安全卡并保持顺序', () => {
  const sections = [
    { name: 'persona', text: 'persona', order: 90 },
    { name: MEMORY_RELATION_CARD, text: '私有画像：主人住在某地', order: 15 },
    { name: 'tool:web', text: 'web', order: 110 },
  ]
  const out = replaceRelationCard(sections, 'safe')
  assert.equal(out.some((s) => s.name === MEMORY_RELATION_CARD), false)
  assert.deepEqual(out.map((s) => s.name), [SAFE_RELATION_CARD, 'persona', 'tool:web'])
  assert.equal(out[0].text, 'safe')
})
