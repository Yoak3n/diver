/**
 * Plugin Config (schemastery / Standard Schema) smoke — DSH-aligned validation.
 * Run: pnpm tsx scripts/plugin-config-test.ts
 */
import { Context } from 'cordis'
import z from '@deepseek-ai/schemastery'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`  ok — ${message}`)
}

/** Mirror cordis resolveConfig: validate via Standard Schema when Config is present. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveConfigLikeCordis(Config: any, config: unknown): any {
  if (!Config) return config
  const result = Config['~standard'].validate(config) as { issues?: readonly unknown[]; value?: unknown }
  if (result.issues && result.issues.length > 0) {
    throw new Error(`config validation failed: ${JSON.stringify(result.issues)}`)
  }
  return result.value
}

async function main() {
  console.log('T1 schemastery Standard Schema validate')
  const Config = z.object({
    text: z.string().required(),
    count: z.number(),
  })
  assert(typeof (Config as { '~standard'?: unknown })['~standard'] === 'object', 'Config exposes ~standard (Standard Schema)')

  const ok = resolveConfigLikeCordis(Config, { text: 'hi', count: 2 })
  assert((ok as { text: string }).text === 'hi', 'valid config passes and normalizes')

  let threw = false
  try {
    resolveConfigLikeCordis(Config, { count: 1 })
  } catch {
    threw = true
  }
  assert(threw, 'missing required field throws (DSH fail-loud)')

  threw = false
  try {
    resolveConfigLikeCordis(Config, { text: 1 })
  } catch {
    threw = true
  }
  assert(threw, 'wrong type throws')

  console.log('T2 function plugin exports Config (cordis plugin.Config path)')
  const plugin = {
    name: 'cfg-sample',
    Config: z.object({ greeting: z.string().default('hello') }),
    apply(_ctx: Context, config: { greeting: string }) {
      assert(config.greeting === 'hello', 'default applied when field omitted')
    },
  }
  // cordis: runtime.Config = plugin.Config; resolveConfig before apply
  const resolved = resolveConfigLikeCordis(plugin.Config as never, {}) as { greeting: string }
  plugin.apply(new Context(), resolved)

  const resolved2 = resolveConfigLikeCordis(plugin.Config as never, { greeting: 'hey' }) as { greeting: string }
  assert(resolved2.greeting === 'hey', 'explicit config wins over default')

  console.log('T3 no Config → passthrough (legacy cos plugins)')
  const raw = { digestIntervalMs: 100 }
  assert(resolveConfigLikeCordis(undefined, raw) === raw, 'undefined Config leaves config untouched')

  console.log('\nplugin Config smoke: all passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
