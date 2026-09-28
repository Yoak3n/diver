// @diver/memory — 工具面（身份卡片）：set_name / identity。
// 设计理念：不预设身份。agent 在对话中逐渐形成"我是什么样的人"的自我认知，
// 通过 identity 把有证据的结论写进身份卡片（关系卡 agent_model 等字段），
// 系统每次组装提示词时把卡片常驻注入（见 relation-card.ts），
// 让性格在后续对话中保持稳定、持续演进。

import type { Context } from 'cordis'
// Load Cordis Context service-key declarations (ctx.tools …).
import type {} from '@cos/plugin-api'

import type { MemoryStore, RelationCard } from './store-rpc.ts'

/** 注册身份卡片工具：set_name（命名回填，定名即撤）+ identity。 */
export function registerIdentityTools(ctx: Context, store: MemoryStore): void {
  // ───────────────────────── 命名回填：极低频，定名即撤 ─────────────────────────
  // 名字一次定妥（写进身份卡片 name，壳层同步实例名），之后基本用不到——
  // 不让它长期占工具列表：名字没定才挂，写入成功立即自撤；启动 refresh 到账后
  // 发现已有名字也立即撤下（store 构造时 refresh 是异步的，启动瞬间读到的可能是空卡）。
  let retractName: (() => void) | undefined
  retractName = ctx.tools.register('set_name', async (args) => {
    const a = (args ?? {}) as { name?: unknown }
    const name = typeof a.name === 'string' ? a.name.trim() : ''
    if (!name) return { content: '缺少 name（用户对你的称呼），未写入', isError: true }
    await store.updateCard({ name })
    store.markDirty()
    retractName?.()
    retractName = undefined
    return { content: `已记下我的名字：「${name}」（实例名已同步更新）` }
  }, {
    description: '设置我的名字（用户对你的称呼）。仅当用户明确告诉你怎么称呼你、或给你起名字时使用；定名后本工具自动撤下，无需重复调用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '我的名字（用户对你的称呼），如"小潜"' },
      },
      required: ['name'],
    },
  })
  if ((store.getCard().name ?? '').trim()) {
    retractName()
    retractName = undefined
  }
  void store.refresh().then(() => {
    if ((store.getCard().name ?? '').trim()) {
      retractName?.()
      retractName = undefined
    }
  })

  // ───────────────────────── 身份卡片：agent 主动完善自我认知 ─────────────────────────
  ctx.tools.register('identity', async (args) => {
    const a = (args ?? {}) as {
      name?: unknown // 我的名字：改名用（首次命名走 set_name）
      self?: unknown // 关于我自己：性格、喜好、说话方式、价值观
      relationship?: unknown // 与用户的相处模式
      reason?: unknown // 为什么这样认为（可选，增强可信度）
    }
    const facts: Partial<Pick<RelationCard, 'name' | 'agent_model' | 'relationship'>> = {}
    const name = typeof a.name === 'string' ? a.name.trim() : ''
    const self = typeof a.self === 'string' ? a.self.trim() : ''
    const relationship = typeof a.relationship === 'string' ? a.relationship.trim() : ''
    if (name) facts.name = name
    if (self) facts.agent_model = self
    if (relationship) facts.relationship = relationship
    if (Object.keys(facts).length === 0) {
      return { content: '未提供 name / self / relationship 任一字段，未修改身份卡片', isError: true }
    }
    await store.updateCard(facts)
    store.markDirty()
    const reason = typeof a.reason === 'string' && a.reason.trim() ? `（依据：${a.reason.trim()}）` : ''
    return { content: `已更新身份卡片：${Object.entries(facts).map(([k, v]) => `${k}=「${v}」`).join('；')}${reason}` }
  }, {
    description: '完善你的身份卡片：把对"我是什么样的人"的自我认知沉淀下来（性格、喜好、说话方式、价值观），或记录与用户的相处模式。name 改的是你自己（agent 本体）的名字，不是聊天昵称或别的标签——改名会同步成实例显示名，侧栏与群聊里对你的称呼都跟着变，因此应慎重使用：名字是对外身份，用户没有明确要求时不要主动改，更不要反复改。只写你有把握、值得长期稳定的结论；一次调用可同时更新多个字段。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '我自己的名字：改的是 agent 本体的名字（会同步实例显示名，侧栏/群聊跟着变），慎重使用——用户没要求不改，定名后不反复改。首次命名优先用 set_name；此处用于之后确需改名时' },
        self: { type: 'string', description: '关于我自己：性格/喜好/说话方式/价值观，如"喜欢轻松真诚的对话，不爱绕弯子；对技术话题有热情"' },
        relationship: { type: 'string', description: '与用户的相处模式，如"他工作忙时会简短安慰，闲聊时放开聊"' },
        reason: { type: 'string', description: '为什么这样认为（依据，可选）' },
      },
    },
  })
}
