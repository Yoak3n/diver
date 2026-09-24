/**
 * Smoke: boot companion composition and print registered LLM providers.
 * Run from harness/: node --import tsx --expose-internals scripts/provider-boot-smoke.ts
 */
import { boot, bootOptionsFromCli, parseCliArgs } from '@cos/boot'
import { companionBootOptions, resolveCompanionPaths } from '../../cos-plugins/companion/src/companion-boot.ts'

const cli = parseCliArgs([
  '--profile', 'companion',
  '--plugin-root', '../cos-plugins',
  '--bundles', '../cos-plugins/bundle-companion',
  '--harness', '.',
])
const paths = resolveCompanionPaths(cli, {
  root: new URL('../../', import.meta.url).pathname.replace(/\/$/, ''),
  preferCosPlugins: true,
})
const bootOpts = bootOptionsFromCli(cli, companionBootOptions(cli, paths))

console.error('[smoke] booting', {
  bundle: paths.bundleDir,
  plugins: paths.pluginsRoot,
  harness: paths.harnessDir,
})

let ctx
try {
  ctx = await boot(bootOpts)
} catch (error) {
  console.error('[smoke] boot failed:', error)
  process.exit(1)
}

const providers = ctx.llm.listProviders()
console.log('[smoke] providers:', providers.map((p) => `${p.id} (${p.name})`).join(', ') || '(none)')
for (const p of providers) {
  try {
    const decl = ctx.llm.adapterConfig(p.id)
    console.log(`[smoke] config ${p.id}:`, decl?.fields?.map((f) => f.key).join(',') ?? '(no decl)')
  } catch (error) {
    console.log(`[smoke] config ${p.id} ERROR:`, error)
  }
}

const ids = providers.map((p) => p.id)
const ok = ids.includes('volcark') && ids.includes('commandcode') && ids.includes('deepseek-official')
console.log(ok ? '[smoke] OK — volcark registered' : '[smoke] FAIL — volcark missing')

try {
  await ctx.fiber.dispose()
} catch {
  /* ignore */
}
process.exit(ok ? 0 : 1)
