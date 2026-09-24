/**
 * Plugin config persistence smoke (settings-page path).
 * Run: pnpm tsx scripts/plugin-config-persist-test.ts
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`  ok — ${message}`)
}

async function main() {
  const home = mkdtempSync(join(tmpdir(), 'cos-cfg-'))
  process.env.COS_HOME = home
  mkdirSync(join(home, 'profiles', 'companion'), { recursive: true })

  const { writePluginConfigValues, readPluginConfigValues } = await import(
    '../../cos-plugins/backend/src/plugin-config.ts'
  )

  console.log('T1 write + read plugin config into profile patch')
  writePluginConfigValues('basic-tools', '@diver/basic-tools', {
    shTimeoutMs: 1234,
    requireObservation: false,
    workspaceRoot: null, // clear
  })
  const values = readPluginConfigValues('basic-tools')
  assert(values.shTimeoutMs === 1234, 'number field persisted')
  assert(values.requireObservation === false, 'boolean field persisted')
  assert(values.workspaceRoot === undefined, 'null clears the key')

  console.log('T2 merge keeps disabled flags')
  const patchPath = join(home, 'profiles', 'companion', 'cordis.patch.yml')
  writeFileSync(
    patchPath,
    `- id: self-prompt\n  name: '@diver/self-prompt'\n  disabled: true\n- id: basic-tools\n  name: '@diver/basic-tools'\n  config:\n    shTimeoutMs: 1\n`,
    'utf8',
  )
  writePluginConfigValues('basic-tools', '@diver/basic-tools', { shTimeoutMs: 99 })
  const raw = readFileSync(patchPath, 'utf8')
  assert(raw.includes('disabled: true'), 'disabled row preserved')
  assert(raw.includes('shTimeoutMs: 99'), 'config merged')
  assert(!raw.includes('shTimeoutMs: 1\n'), 'old config key overwritten')

  rmSync(home, { recursive: true, force: true })
  console.log('\nplugin config persist smoke: all passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
