/**
 * 打包前闭包预检：扫描 plugins + @cos 源码裸 import，核对能否解析。
 * 用法：node scripts/check-plugin-closure.mjs
 * 退出码 0=通过，1=有缺失。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SIDE = join(ROOT, 'src-tauri', 'resources', 'sidecar')
const PLUGINS = join(SIDE, 'plugins')
const NM = join(PLUGINS, 'node_modules')
const HARNESS_NM = join(SIDE, 'harness', 'node_modules')

const BUILTIN = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'diagnostics_channel', 'dns', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])

function loadTarPackages(...tarPaths) {
  const set = new Set()
  // 兼容 .tar.zst（bsdtar -tf 自动识别 zstd）与旧 .tar
  for (const tarPath of tarPaths) {
    if (!existsSync(tarPath)) continue
    try {
      const listing = execFileSync('tar', ['-tf', tarPath], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      for (const line of listing.split(/\r?\n/)) {
        const m = line.replace(/^\.\/?/, '').match(/^((@[^/]+\/[^/]+)|([^/@][^/]+))\//)
        if (m) set.add(m[1])
      }
    } catch {
      /* ignore */
    }
  }
  return set
}

const tarPkgs = loadTarPackages(join(PLUGINS, 'node_modules.tar.zst'), join(PLUGINS, 'node_modules.tar'))

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, out)
    else if (/\.(ts|tsx|mts|js|mjs|cjs)$/.test(e.name)) out.push(p)
  }
  return out
}

function bareName(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('file:')) return null
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/')
  return spec.split('/')[0]
}

function canResolve(name) {
  if (!name) return true
  const baseName = name.split('/')[0]
  if (BUILTIN.has(name) || BUILTIN.has(baseName)) return true
  for (const root of [NM, HARNESS_NM, join(SIDE, 'node_modules')]) {
    const p = join(root, ...name.split('/'))
    if (existsSync(join(p, 'package.json')) || existsSync(join(p, 'index.ts')) || existsSync(join(p, 'index.js'))) {
      return true
    }
  }
  if (name.startsWith('@cos/')) {
    const leaf = name.slice('@cos/'.length)
    if (existsSync(join(SIDE, 'harness', 'packages', leaf, 'package.json'))) return true
    if (existsSync(join(NM, '@cos', leaf, 'package.json'))) return true
  }
  return tarPkgs.has(name)
}

const roots = [PLUGINS, join(NM, '@cos'), join(NM, '@diver')]
const files = roots.flatMap((r) => walkFiles(r))
const missing = new Map()

for (const f of files) {
  let text
  try {
    text = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  const re =
    /(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const m of text.matchAll(re)) {
    const name = bareName(m[1] || m[2] || m[3])
    if (!name || canResolve(name)) continue
    if (!missing.has(name)) missing.set(name, new Set())
    missing.get(name).add(f.replace(ROOT + '\\', '').replace(ROOT + '/', ''))
  }
}

if (missing.size === 0) {
  console.log(`OK: ${files.length} files, all bare imports resolvable`)
  process.exit(0)
}

console.error(`FAIL: ${missing.size} unresolved package(s) in ${files.length} files`)
for (const [name, froms] of [...missing.entries()].sort()) {
  console.error(`  - ${name}`)
  for (const f of [...froms].slice(0, 6)) console.error(`      from ${f}`)
  if (froms.size > 6) console.error(`      ... +${froms.size - 6} more`)
}
process.exit(1)
