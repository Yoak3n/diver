// @diver/self-prompt — 专用提示词工具（不暴露通用文件读写）。
//
// revise_prompt / list_prompt_slots 只操作 self-prompt 覆盖层；
// OneBot 侧只对主人发起的回合放行（见 @diver/onebot 的 sandbox）。

import type { Context } from 'cordis'
import type {} from '@cos/plugin-api'

import { bundledPromptDir, overridePromptDir } from './paths.ts'
import { listPromptSlots, parseReviseInput, writePromptOverride } from './revise.ts'

function errorJson(error: string): { content: string; isError: true } {
  return { content: JSON.stringify({ error }), isError: true }
}

export function applyReviseTools(ctx: Context): void {
  ctx.tools.register('list_prompt_slots', async () => {
    const data = listPromptSlots(bundledPromptDir(), overridePromptDir())
    return {
      content: JSON.stringify({
        ...data,
        hint: 'override 层同名覆盖 bundled；常用 order：关系卡 15、persona 90、工具引导 100、表达层 110。',
      }),
    }
  }, {
    description:
      '列出当前提示词槽位（slot / order / 来源 builtin|override / 正文字节数）。' +
      'override 层同名覆盖 bundled；改提示词前先看它，确认槽位名和 order，避免覆盖错位置。' +
      '常用 order：关系卡 15、persona 90、工具引导 100、表达层 110。',
    parameters: { type: 'object', properties: {} },
  })

  ctx.tools.register('revise_prompt', async (args) => {
    const input = parseReviseInput(args)
    if ('error' in input) return errorJson(input.error)
    const result = writePromptOverride(overridePromptDir(), input)
    if (!result.ok) return errorJson(result.error)
    return {
      content: JSON.stringify({
        ...result,
        note: '已写入提示词覆盖层；下一拍组装生效，无需重启。',
      }),
    }
  }, {
    description:
      '修改或新增自己的提示词槽位。只写 self-prompt 的覆盖层（同名覆盖 bundled），' +
      '不改源码、不改本机其他文件。用于调整表达风格/提示词正文；' +
      '身份「我是谁/和用户的关系」请用 memory 的 identity，不在这里。' +
      'body 必须是完整正文（不是 diff）；order 是排序整数（表达层通常 110），' +
      '改已有槽位时先 list_prompt_slots 查当前值。下一拍组装生效，不需要 restart_agent。' +
      'QQ 回合只有主人发起的对话可调用。',
    parameters: {
      type: 'object',
      properties: {
        slot: { type: 'string', description: '槽位名，小写字母/数字/下划线/短横线，如 style' },
        order: { type: 'number', description: 'systemPrompt 排序整数；表达层通常 110' },
        body: { type: 'string', description: '完整提示词正文（不含 frontmatter）' },
      },
      required: ['slot', 'order', 'body'],
    },
  })

  console.log('[self-prompt] 专用工具就绪（list_prompt_slots / revise_prompt）')
}
