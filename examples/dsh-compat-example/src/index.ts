/**
 * dsh-compat-example — sample plugin using the **DSH-aligned** registration syntax.
 * `defineTool` + `ctx.tools.register(definition)` is the canonical cos form;
 * `import { defineTool } from '@deepseek-ai/dsh-tools'` is an equivalent alias.
 */
import type { Context } from 'cordis'
import type {} from '@cos/plugin-api'
import { defineTool } from '@cos/plugin-api'

export const name = 'dsh-compat-example'

export const inject = ['tools', 'systemPrompt']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'dsh_echo',
    description: 'Echo the provided text back to the model (DSH defineTool sample).',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to echo' },
      prefix: { type: 'string', description: 'Optional prefix' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const text = String((args as { text?: unknown }).text ?? '')
      const prefix = (args as { prefix?: unknown }).prefix
      return typeof prefix === 'string' && prefix !== '' ? `${prefix}${text}` : text
    },
  }))

  ctx.systemPrompt.section({
    name: 'dsh:compat-example',
    order: 200,
    text: 'DSH compatibility sample plugin is mounted (defineTool surface).',
  })

  console.log('[dsh-compat-example] ready (defineTool → ctx.tools.register)')
}
