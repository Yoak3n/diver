// Diver companion — 共享类型：与 dsh-compaction-basic 的类型声明对齐。
//
// 框架的 SummarizationInput/SummaryResult 未从包入口导出（仅在
// lib/types/summarizer.d.ts 内部），包 exports 又禁止 deep import，
// 因此这里按框架声明原样复制等价结构（结构类型系统下与框架类型互通）。

import type { ContentBlock, Message, TokenUsage } from '@deepseek-ai/dsh-llm'

/** 压缩引擎交给摘要方的会话前缀（与框架 SummarizationInput 对齐）。 */
export interface SummarizationInput {
  readonly system?: string
  readonly tools?: readonly unknown[]
  readonly messages: readonly Message[]
}

/** 摘要结果（与框架 SummaryResult 逐字段对齐）。 */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & (
  | { rawOutput: ContentBlock[]; llmStreamCall: true }
  | { rawOutput?: ContentBlock[]; llmStreamCall?: never }
)
