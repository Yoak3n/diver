/**
 * DSH compatibility smoke: defineTool → ctx.tools.register (dual shape) → execute.
 * Run: pnpm tsx scripts/dsh-compat-test.ts
 */
import { Context } from 'cordis'
import ToolsService from '../packages/tools/src/index.ts'
import { defineTool, parameterSchemaSpecToJsonSchema, ToolArgsError } from '../packages/dsh-tools/src/index.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`  ok — ${message}`)
}

async function main() {
  console.log('T1 defineTool schema compile')
  const parameters = parameterSchemaSpecToJsonSchema({
    text: { type: 'string', required: true, description: 'Text to echo' },
    prefix: { type: 'string' },
    count: { type: 'integer' },
  })
  assert(parameters.type === 'object', 'parameters root is object')
  const props = parameters.properties as Record<string, { type?: string }>
  assert(props.text?.type === 'string', 'text → string')
  assert(props.count?.type === 'integer', 'count → integer')
  assert((parameters.required as string[] | undefined)?.[0] === 'text', 'text is required')

  console.log('T2 defineTool + dual-shape register + execute')
  const ctx = new Context()
  const tools = new ToolsService(ctx)
  ctx.set('tools', tools)

  const dispose = tools.register(defineTool({
    name: 'dsh_echo',
    description: 'Echo text',
    parameters: {
      text: { type: 'string', required: true },
      prefix: { type: 'string' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const { text, prefix } = args as { text: string; prefix?: string }
      return prefix ? `${prefix}${text}` : text
    },
  }))
  assert(typeof dispose === 'function', 'register returns disposer')

  const listed = tools.listDefinitions()
  assert(listed.length === 1 && listed[0].name === 'dsh_echo', 'tool listed as dsh_echo')
  assert(listed[0].schema.description === 'Echo text', 'description mapped')
  assert(typeof listed[0].schema.parameters === 'object', 'parameters mapped to wire schema')

  const ok = await tools.execute('dsh_echo', { text: 'hi', prefix: '»' }, new AbortController().signal)
  assert(ok.content === '»hi' && ok.isError !== true, `execute renders output (got ${JSON.stringify(ok)})`)

  const bad = await tools.execute('dsh_echo', { prefix: 'x' }, new AbortController().signal)
  assert(bad.isError === true, 'invalid args surface as error result')

  console.log('T3 cos-shape register still works')
  tools.register('cos_ping', async () => ({ content: 'pong' }), { description: 'ping' })
  const pong = await tools.execute('cos_ping', {}, new AbortController().signal)
  assert(pong.content === 'pong', 'cos triple register still works')

  console.log('T4 schemas()/get() DSH aliases')
  const schemas = tools.schemas()
  assert(schemas.some((s) => s.name === 'dsh_echo'), 'schemas() lists dsh_echo')
  assert(tools.get('cos_ping')?.description === 'ping', 'get() resolves cos tool')

  dispose()
  assert(!tools.listDefinitions().some((t) => t.name === 'dsh_echo'), 'dispose removes DSH tool')

  // ToolArgsError is thrown inside execute and mapped to isError — already covered by T2.
  assert(typeof ToolArgsError === 'function', 'ToolArgsError exported')

  console.log('\nDSH compat smoke: all passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
