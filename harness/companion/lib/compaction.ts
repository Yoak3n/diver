// Diver companion — 压缩引擎：摘要生成通过事件委托给 memory 插件。
//
// 子类化 dsh-compaction-basic 的 BasicCompactionEngine，override 唯一定制
// hook `summarize()`：广播 `compaction/summarize` 事件（ctx.bail，等待第一个
// 处理者返回摘要结果）。事件**只传 agent 与取消信号**——数据准备（读取会话、
// 序列化被压缩内容）完全由 memory 插件在监听器内自行完成，compaction 不
// 向外传递任何会话数据，两者只有事件契约、零数据耦合。
//
// 参数来源（框架调用契约）：input 由框架在 compactSurfaceRegion 里用
// buildSummarizationInput(session, shadowedSeqs) 构造，本引擎不消费它
// （_input 忽略），memory 插件从 agent.session 自行读取等价数据。
//
// 接线（cordis.patch.yml）：base 的 compaction-basic 行 disabled，由 insert 的
// compaction-diver 行加载本模块（服务 key "compaction" 同名替换），配置项
// 语义与 base 一致。

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SummarizationInput, SummaryResult } from './types.ts'

export const name = 'diver-companion-compaction'

/** 压缩摘要事件名：compaction 广播（参数：agent, signal），memory 插件监听。 */
export const COMPACTION_SUMMARIZE_EVENT = 'compaction/summarize'

// 事件类型声明：bail 事件的返回值即摘要结果（cordis 事件表扩展）
declare module '@deepseek-ai/cordis' {
  interface Events {
    'compaction/summarize'(agent: Agent, signal?: AbortSignal): SummaryResult
  }
}

export class DiverCompactionEngine extends BasicCompactionEngine {
  /** 唯一定制 hook：广播事件，由 memory 插件自行准备数据并返回摘要结果。 */
  async summarize(_input: SummarizationInput, agent: Agent, signal?: AbortSignal): Promise<SummaryResult> {
    const result = await this.ctx.bail(COMPACTION_SUMMARIZE_EVENT, agent, signal)
    if (!result) {
      throw new Error(`no listener for ${COMPACTION_SUMMARIZE_EVENT}; memory plugin not loaded?`)
    }
    return result
  }
}

export default DiverCompactionEngine
