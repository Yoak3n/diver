// @diver/memory — 读路径：身份卡片 + Mode B 时间检索的 systemPrompt 常驻注入。
// 卡片成型前只注入行动提示（引导用 identity / set_name 沉淀），不留长期噪音。

import type { Context } from 'cordis'
// Load Cordis Context service-key declarations (ctx.systemPrompt …).
import type {} from '@cos/plugin-api'

import type { MemoryStore } from './store-rpc.ts'
import { humanWhen, timeHm } from './timefmt.ts'

/** 注册 memory:relation-card section（身份卡片 + 近期经历 / 承诺 / 今天）。 */
export function registerRelationCard(ctx: Context, store: MemoryStore): void {
  ctx.systemPrompt.section({
    name: 'memory:relation-card',
    order: 15, // 身份卡片与关系记忆：核心长期上下文，排在 persona(90) 与工具引导(100) 之前
    text: () => {
      const card = store.getCard()
      const myName = (card.name ?? '').trim()
      const profile = (card.profile ?? '').trim()
      const agentModel = (card.agent_model ?? '').trim()
      const relationship = (card.relationship ?? '').trim()
      if (!myName && !profile && !agentModel && !relationship) {
        // 身份卡片尚未形成：只注入行动提示（引导用 identity 工具沉淀），
        // 卡片成型后自动消失，不留长期噪音
        return '【身份卡片 · 我】（尚未形成——当你对"我是什么样的人"有了稳定看法，用 identity 工具沉淀；用户告诉你怎么称呼你时用 set_name 记下名字）'
      }

      const parts = ['【身份卡片 · 我】']
      if (myName) parts.push(`我的名字：${myName}`)
      if (agentModel) parts.push(`我：${agentModel}`)
      if (profile) parts.push(`关于用户：${profile}`)
      if (relationship) parts.push(`我们之间：${relationship}`)

      // Mode B — 时间检索（最近经历 / 未完成承诺 / 今天事件）：主动性燃料
      const episodes = store.recentEpisodes(14, 3)
      if (episodes.length > 0) {
        parts.push('【近期共同经历】' + episodes.map((e) =>
          `- ${humanWhen(e.lastDiscussedAt)}聊过「${e.canonicalName}」（${e.nTimes}次）—— ${(e.stateSummary ?? '').slice(0, 100)}`,
        ).join('\n'))
      }
      const promises = store.listPromises('open').slice(-3)
      if (promises.length > 0) {
        parts.push('【未完成承诺】' + promises.map((p) => `- ${p.content.slice(0, 80)}`).join('\n'))
      }
      const today = store.todayEvents().slice(-3)
      if (today.length > 0) {
        parts.push('【今天】' + today.map((e) => `- ${timeHm(e.ts)} ${e.statement.slice(0, 60)}`).join('\n'))
      }
      return parts.join('\n\n')
    },
  })
}
