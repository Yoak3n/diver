// 扫描 sidecar 插件/@cos 源码的裸 import，核对是否都能在 plugins/node_modules 解析
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

const ROOT = 'src-tauri/resources/sidecar'
const PLUGINS = join(ROOT, 'plugins')
const NM = join(PLUGINS, 'node_modules')

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mts|js|mjs|cjs)$/.test(e.name)) out.push(p)
  }
  return out
}

function bareName(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('file:')) return null
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
}

function resolvable(name) {
  if (['fs','path','os','url','util','events','crypto','http','https','stream','child_process','process','buffer','zlib','net','tls','dns','readline','worker_threads','module','assert','timers','string_decoder','querystring','perf_hooks','async_hooks','tty','zlib'].includes(name)) return true
  const p = join(NM, ...name.split('/'))
  return existsSync(join(p, 'package.json')) || existsSync(p)
}

const files = [
  ...walk(join(PLUGINS, 'backend')),
  ...walk(join(PLUGINS, 'basic-tools')),
  ...walk(join(PLUGINS, 'mcp')),
  ...walk(join(PLUGINS, 'memory')),
  ...walk(join(PLUGINS, 'self-prompt')),
  ...walk(join(PLUGINS, 'llm-commandcode')),
  ...walk(join(PLUGINS, 'llm-volcark')),
  ...walk(join(PLUGINS, 'native-bridge')),
  ...walk(join(PLUGINS, 'web-tools')),
  ...walk(join(NM, '@cos')),
  ...walk(join(NM, '@diver')),
]

const missing = new Map()
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]\)?/g)) {
    const name = bareName(m[1])
    if (!name) continue
    if (!resolvable(name)) {
      if (!missing.has(name)) missing.set(name, new Set())
      missing.get(name).add(f)
    }
  }
}

if (missing.size === 0) {
  console.log('OK: all bare imports resolvable in plugins/node_modules')
  process.exit(0)
}
console.log('MISSING packages:')
for (const [name, froms] of missing) {
  console.log(`  ${name}`)
  for (const f of [...froms].slice(0, 5)) console.log(`    <- ${f}`)
}
process.exit(1)
