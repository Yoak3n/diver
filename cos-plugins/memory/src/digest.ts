// @diver/memory — 记忆"消化"层：把会话末 digest / 压缩摘要内化委托给 harness
// 核心的 subagent 服务（ctx.subagents.run）。worker 通过记忆插件自己的工具
// 直接读写记忆后端（Rust SQLite RPC），不再采用"单次 LLM 调用 + parseJson
// 提取 JSON diff"的方式。
//
// worker 工具面：
//   remember / recall / inventory / demote —— 插件已注册的公共记忆工具
//   memory_update_card —— run 期临时注入的 worker-only 工具（主对话 agent 看不到）
//
// 这些 LLM 调用发生在 worker 自己的会话里（ephemeral，不落盘、不进对话日志），
// 与原来直连 ctx.llm.stream 的语义一致：不污染主对话。worker 是独立的后台线，
// 与主会话并行：调用方（index.ts 的调度器）既不等主 agent 空闲、也不会因用户
// 新消息而取消它。

import type { Context } from 'cordis'
import type { ToolExecutor } from '@cos/plugin-api'

import { readDiverSettings } from './session.ts'
import type { MemoryStore, RelationCard } from './store-rpc.ts'

/** worker 可见的记忆工具全量（含 run 期注入的 memory_update_card）。 */
export const WORKER_TOOLS = ['remember', 'recall', 'inventory', 'demote', 'memory_update_card'] as const

/** 解析 worker 的 provider/model：跟随用户设置在 diver-settings.json 里的选择，
 * 未设置则取当前注册的第一个适配器（与 @diver/backend 的 ensureCompanionAgent 一致）。 */
async function workerRoute(ctx: Context): Promise<{ provider: string; model: string }> {
  const diver = readDiverSettings()
  const provider = diver.provider ?? ctx.llm.listProviders()[0]?.id ?? ''
  const model = diver.model ?? (provider === '' ? '' : (await ctx.llm.listModels(provider))[0] ?? '')
  return { provider, model }
}

/** memory_update_card：关系卡增量更新工具（仅 worker 运行期间注册）。 */
function updateCardTool(store: MemoryStore): { name: string; executor: ToolExecutor; options: Record<string, unknown> } {
  return {
    name: 'memory_update_card',
    executor: async (args: unknown) => {
      const a = (args ?? {}) as { profile?: unknown; agent_model?: unknown; relationship?: unknown }
      const facts: Partial<Pick<RelationCard, 'profile' | 'agent_model' | 'relationship'>> = {}
      const slot: Array<[keyof typeof facts, unknown]> = [
        ['profile', a.profile],
        ['agent_model', a.agent_model],
        ['relationship', a.relationship],
      ]
      for (const [key, value] of slot) {
        if (typeof value === 'string' && value.trim() !== '') facts[key] = value.trim()
      }
      if (Object.keys(facts).length === 0) {
        return { content: '未提供任何字段（profile / agent_model / relationship），未修改身份卡片', isError: true }
      }
      await store.updateCard(facts)
      store.markDirty()
      return { content: `已更新关系卡字段: ${Object.keys(facts).join(', ')}` }
    },
    options: {
      description:
        '增量更新身份卡片（关于用户 / 关于我 / 我们之间的相处模式）——它是 agent 自我认知的长期载体，每次组装提示词时注入。只写证据充分、值得长期保留的结论；每次传需要覆盖的字段。',
      parameters: {
        type: 'object',
        properties: {
          profile: { type: 'string', description: '关于用户的长期模式/事实/认知缺口，如"最近两周在忙项目、Lily 是同事、还不知道他的生日"' },
          agent_model: { type: 'string', description: '关于助手自己的性格/模式/教训——自我认知的身份卡片字段，如"说话简洁直接、喜欢轻松玩笑；被纠正过啰嗦"' },
          relationship: { type: 'string', description: '相处模式，如"报喜不报忧、喜欢轻松玩笑"' },
        },
      },
    },
  }
}

const DIGEST_SYSTEM = `你是陪伴助手的记忆消化员。你的职责：读入一段会话摘要，把其中值得长期记住的内容写进记忆。

必须通过工具操作记忆（不要输出 JSON，也不要复述摘要）：
1. 先盘点：用 inventory / recall 看看记忆里已有什么，避免重复写入。
2. 有价值的新事实用 remember 沉淀为话题记忆，一句话一条。
3. 关于用户 / 自己 / 相处模式的长期结论，用 memory_update_card 增量更新身份卡片
   （agent_model 是"我是什么样的人"——性格、说话方式、价值观；助手在相处中逐渐形成的
   自我认知都沉淀在这里，让性格跨会话保持稳定、持续完善）。
4. 高门槛保守：证据不足不下结论，寒暄与一次性信息不写；不确定就不写。

结束时只用一句话简短中文总结你做了什么；没有值得记的就直说。`

/** 会话末 digest：模式 / 关系 / 缺口 → 由 worker 直接写入记忆（返回 void）。 */
export async function digestSession(
  ctx: Context,
  store: MemoryStore,
  card: { profile: string; agent_model: string; relationship: string },
  stats: Record<string, any>,
  transcript: string,
): Promise<void> {
  const { provider, model } = await workerRoute(ctx)
  const task = [
    '请消化下面的会话摘要，把值得长期记住的内容写入记忆。',
    '',
    '【当前关系卡】',
    `关于用户：${card.profile || '（空）'}`,
    `关于我：${card.agent_model || '（空）'}`,
    `我们之间：${card.relationship || '（空）'}`,
    '',
    `【记忆统计】${JSON.stringify(stats)}`,
    '',
    '【本会话摘要】',
    transcript.slice(0, 2500),
  ].join('\n')
  const result = await ctx.subagents.run({
    label: 'memory-digest',
    system: DIGEST_SYSTEM,
    task,
    toolNames: [...WORKER_TOOLS],
    tools: [updateCardTool(store)],
    provider,
    model,
    maxTokens: 900,
  })
  console.log(
    `[memory] 会话消化完成（worker=${result.sessionId} 工具=${result.toolCalls.join(',') || '无'} 说明=${result.text.slice(0, 120)}）`,
  )
}

const COMPACTION_SYSTEM = `你是持续记忆消化员。输入是一段"压缩后的会话历史摘要"，请把它消化成长期记忆。

必须通过工具操作记忆（不要输出 JSON）：
1. 用 recall / inventory 看看"会话历史回顾"等话题里已有什么。
2. 把摘要里值得长期保留的事实 / 承诺 / 偏好用 remember 沉淀，话题传"会话历史回顾"或更贴切的话题。
3. 若有跨会话稳定的自我认知或相处模式，可用 memory_update_card 更新身份卡片（agent_model=我是什么样的人）。
4. 只保留有信息量的内容，压缩摘要里的过程性细节不必全记。

结束时只用一句话简短中文总结你做了什么。`

/** 压缩摘要内化：把被压缩的历史消化为长期记忆（worker 直写）。 */
export async function digestCompactionSummary(ctx: Context, store: MemoryStore, text: string): Promise<void> {
  if (!text || text.trim().length < 20) return
  const { provider, model } = await workerRoute(ctx)
  const result = await ctx.subagents.run({
    label: 'memory-compaction',
    system: COMPACTION_SYSTEM,
    task: `压缩后的会话历史摘要（上下文压缩产生）：\n\n${text.slice(0, 3000)}`,
    toolNames: [...WORKER_TOOLS],
    tools: [updateCardTool(store)],
    provider,
    model,
    maxTokens: 600,
  })
  console.log(`[memory] 压缩摘要已消化（worker=${result.sessionId} 工具=${result.toolCalls.join(',') || '无'}）`)
}