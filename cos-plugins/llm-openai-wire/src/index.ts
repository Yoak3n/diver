// @diver/llm-openai-wire — OpenAI 兼容 wire 翻译共享层（chat/completions 载荷 + SSE 解析）。
//
// @diver/llm-volcark / @diver/llm-custom / @diver/llm-commandcode 三个适配器的
// wire 层完全同构，收敛到此：模型可见历史（ModelMessage）→ OpenAI chat 格式
// （ChatMessage），外加流式 SSE `data:` 载荷解析。本包是纯函数库，不是 cordis 插件。
//
// 两条硬保证（2026-09-27 方舟 400 事故的修复与兜底）：
//  1. 工具结果里的图片不再「紧随该条 tool 消息」注入 user 消息 —— 那会把 user
//     插进两条 tool 中间；方舟等 OpenAI 兼容端要求 assistant(tool_calls) 之后
//     **连续**跟满全部 tool 结果，多调用轮次会 400（insufficient tool messages
//     following tool_calls message）。图片缓冲到本轮 tool 序列闭合（下一条非
//     tool 消息到来）后统一注入，任何工具返回图片都成立。
//  2. translate() 出口必过 sanitizeToolSequence()：无论输入历史多破（调用中断
//     丢结果、孤儿结果、序列被打断），返回的载荷都满足序列约束。会话没有清空
//     功能，一条坏历史会永久卡死对话 —— 兜底必须常开且永不抛错。
// @module @diver/llm-openai-wire

import type { MessageContent, ModelMessage } from '@cos/plugin-api'

/** OpenAI chat/completions 的一条 wire 消息。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

/** 把我们的内容块压成文本（text 块拼接；tool-call 块忽略）。 */
export function contentToText(content: MessageContent): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** 用户消息含图片时走 OpenAI 多模态 parts；否则纯文本。 */
export function userWireContent(content: MessageContent): ChatMessage['content'] {
  const text = contentToText(content)
  const images = content.filter((block) => block.type === 'image')
  if (images.length === 0) return text
  const parts: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> =
    images.map((img) => ({
      type: 'image_url',
      image_url: { url: `data:${img.mime};base64,${img.data}` },
    }))
  parts.push({ type: 'text', text: text === '' ? '（图片）' : text })
  return parts
}

/**
 * 工具序列兜底：就地修复任何违反 OpenAI 兼容端硬约束的 wire 序列 ——
 * assistant(tool_calls) 之后必须**连续**跟满其全部 tool 结果，期间不得插入其他角色。
 *
 * 修复规则（信息只保不丢，永不抛错）：
 *  - run 未闭合就来了其他角色（user / 普通 assistant）→ 扣下缓冲，等闭合后放行；
 *  - run 闭合时仍有 call 没等到结果（调用被中断）→ 补占位 tool 结果，诚实告知模型；
 *  - 孤儿 tool 结果（call_id 对不上任何未闭合 run）→ 转 user 文本消息保留信息。
 */
export function sanitizeToolSequence(wire: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  let pending: string[] = [] // 当前 run 尚未收到结果的 tool_call_id
  let buffered: ChatMessage[] = [] // run 闭合前扣下的打断者消息

  const flushBuffered = () => {
    out.push(...buffered)
    buffered = []
  }
  const closeRun = () => {
    for (const id of pending) {
      out.push({
        role: 'tool',
        tool_call_id: id,
        content: '[tool result missing — the call was interrupted before any result was recorded]',
      })
    }
    pending = []
    flushBuffered()
  }

  for (const message of wire) {
    if (message.role === 'tool') {
      const id = message.tool_call_id ?? ''
      if (pending.includes(id)) {
        pending = pending.filter((x) => x !== id)
        out.push(message)
      } else {
        // call_id 对不上当前 run（重复、迟到或前面没有 run）：转 user 保信息。
        const note: ChatMessage = {
          role: 'user',
          content: `[orphan tool result (call ${id || 'unknown'})] ${wireText(message)}`,
        }
        if (pending.length > 0) buffered.push(note)
        else {
          flushBuffered()
          out.push(note)
        }
      }
    } else if (message.role === 'assistant' && message.tool_calls !== undefined && message.tool_calls.length > 0) {
      closeRun() // 前一个 run 若还悬着，补占位闭合后再开新 run
      pending = message.tool_calls.map((call) => call.id)
      out.push(message)
    } else if (pending.length > 0) {
      buffered.push(message) // 打断者：run 闭合后放行
    } else {
      flushBuffered()
      out.push(message)
    }
  }
  closeRun()
  return out
}

/** wire 消息压成纯文本（string 直返；parts 取 text，图片位置留占位）。 */
function wireText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .map((part) => (part.type === 'text' ? part.text : '[image]'))
    .join('')
}

/** 当前 tool run 闭合待注入的图片（缓冲在 translate 内部）。 */
interface PendingImages {
  images: Array<{ mime: string; data: string }>
  names: string[]
}

/**
 * 把模型可见历史翻译成 wire 格式（system 提示放最前）。
 *
 * 工具结果带图时：tool 行只留文本摘要；图片缓冲到本轮 tool 序列闭合后以 user
 * 消息统一注入（OpenAI 兼容 tool 角色通常只收文本；user 的 image_url 视觉模型
 * 才能「看见」）。注入点必须在**全部** tool 结果之后，多调用轮次才不破序列。
 * 出口必过 sanitizeToolSequence：返回的载荷永远满足
 * 「assistant(tool_calls) 后连续跟满全部 tool 结果」。
 */
export function translate(messages: readonly ModelMessage[], system?: string): ChatMessage[] {
  const wire: ChatMessage[] = system === undefined ? [] : [{ role: 'system', content: system }]
  let pendingImages: PendingImages | null = null

  const flushImages = () => {
    if (pendingImages === null) return
    const names = [...new Set(pendingImages.names)].join(', ')
    wire.push({
      role: 'user',
      content: [
        ...pendingImages.images.map((img) => ({
          type: 'image_url' as const,
          image_url: { url: `data:${img.mime};base64,${img.data}` },
        })),
        {
          type: 'text' as const,
          text: `[tool result image: ${names}] — inspect this image visually and describe what you see.`,
        },
      ],
    })
    pendingImages = null
  }

  for (const message of messages) {
    const text = contentToText(message.content)
    if (message.role === 'user') {
      flushImages()
      wire.push({ role: 'user', content: userWireContent(message.content) })
    } else if (message.role === 'tool') {
      const images = message.content.filter((block) => block.type === 'image')
      if (images.length > 0) {
        pendingImages ??= { images: [], names: [] }
        for (const img of images) {
          pendingImages.images.push({ mime: img.mime, data: img.data })
          pendingImages.names.push(img.name ?? 'image')
        }
      }
      wire.push({ role: 'tool', tool_call_id: message.callId ?? '', content: text })
    } else {
      flushImages()
      const toolCalls = message.content
        .filter((block) => block.type === 'tool-call')
        .map((block) => ({
          id: block.id,
          type: 'function' as const,
          function: { name: block.name, arguments: block.arguments },
        }))
      wire.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      })
    }
  }
  flushImages()
  return sanitizeToolSequence(wire)
}

/** 解析一行 SSE `data:` 载荷；keep-alive 与 [DONE] 返回 null。 */
export function parseSseData(line: string): unknown | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return null
  return JSON.parse(payload) as unknown
}
