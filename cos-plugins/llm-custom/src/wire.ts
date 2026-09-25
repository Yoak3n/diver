// @diver/llm-custom — OpenAI 兼容 wire 翻译（chat/completions 载荷与 SSE 解析）。
//
// 与 @diver/llm-volcark 的 wire 层同构：模型可见历史 → OpenAI chat 格式，
// SSE `data:` 载荷解析。自定义提供商面向任意 OpenAI 兼容端点，保持最小公约数。
// @module @diver/llm-custom/wire

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

/** 把模型可见历史翻译成 wire 格式（system 提示放最前）。
 *  工具结果带图时：tool 行只留文本摘要，图片以紧随其后的 user 消息注入
 *  （OpenAI 兼容 tool 角色通常只收文本；user 的 image_url 视觉模型才能「看见」）。 */
export function translate(messages: readonly ModelMessage[], system?: string): ChatMessage[] {
  const wire: ChatMessage[] = system === undefined ? [] : [{ role: 'system', content: system }]
  for (const message of messages) {
    const text = contentToText(message.content)
    if (message.role === 'user') {
      wire.push({ role: 'user', content: userWireContent(message.content) })
    } else if (message.role === 'tool') {
      const images = message.content.filter((block) => block.type === 'image')
      wire.push({ role: 'tool', tool_call_id: message.callId ?? '', content: text })
      if (images.length > 0) {
        const name = images.find((i) => i.name)?.name ?? 'image'
        wire.push({
          role: 'user',
          content: [
            ...images.map((img) => ({
              type: 'image_url' as const,
              image_url: { url: `data:${img.mime};base64,${img.data}` },
            })),
            {
              type: 'text' as const,
              text: `[tool result image: ${name}] — inspect this image visually and describe what you see.`,
            },
          ],
        })
      }
    } else {
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
  return wire
}

/** 解析一行 SSE `data:` 载荷；keep-alive 与 [DONE] 返回 null。 */
export function parseSseData(line: string): unknown | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return null
  return JSON.parse(payload) as unknown
}
