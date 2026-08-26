/**
 * Build the sidecar as a Node Single Executable Application. Steps:
 *   1. esbuild bundles the SEA entry (all @cos/* plugins via the in-process
 *      registry, plus — when `--profile <name>` is given — the profile's
 *      third-party plugins, compiled into the SAME module graph so they share
 *      one cordis instance) into one CJS file dist/sea.cjs.
 *   2. node --experimental-sea-config produces the SEA blob dist/sea-prep.blob.
 *   3. postject injects the blob into a copy of the running node.exe,
 *      producing dist/cos-sidecar.exe.
 *
 * Why third-party plugins are baked at build time: the SEA runtime (embedded
 * CJS) cannot type-strip TypeScript under node_modules
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so `@diver/backend` and
 * `@diver/memory` from a profile's pnpm-managed node_modules cannot be
 * import()'d at runtime. Baking them into the same esbuild graph compiles
 * their TS once and registers them in the in-process plugin registry — the
 * profile's bundle LAYERS (dsh.profile.bundles + cordis.patch.yml) are still
 * read from disk at runtime, so mounting follows the profile; new plugin
 * packages require a rebuild.
 *
 * Run: `pnpm build:sea` (core only) or `pnpm build:sea --profile companion
 * --home <cos-home>` (core + the profile's third-party plugins).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { build } from 'esbuild'
import { inject } from 'postject'
import { parse as parseYaml } from 'yaml'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dist = join(root, 'dist')
mkdirSync(dist, { recursive: true })

const OUT = join(dist, 'sea.cjs')
const ENTRY = join(dist, 'sea-entry.ts')
const BLOB = join(dist, 'sea-prep.blob')
const SEA_CONFIG = join(dist, 'sea-config.json')
const EXE = join(dist, 'cos-sidecar.exe')
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

/** The in-box core registry names (packages/sidecar/src/plugins.ts) — never re-baked. */
const CORE_PLUGINS = new Set([
  '@cos/llm', '@cos/credentials', '@cos/session', '@cos/persistence', '@cos/system-prompt',
  '@cos/persona', '@cos/tools', '@cos/scope', '@cos/llm-deepseek', '@cos/mock-llm',
  '@cos/agents', '@cos/agent-loop', '@cos/subagents',
])

/** Find a profile's third-party plugin modules (name -> absolute entry). */
function collectProfilePlugins(profile, home) {
  const profileDir = join(home, 'profiles', profile)
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`build:sea: profile ${profile} has no manifest at ${manifestPath}; initialize it first (pnpm setup:companion)`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest?.dsh?.profile?.bundles ?? manifest?.cos?.profile?.bundles ?? []
  const profileRequire = createRequire(join(profileDir, 'package.json'))
  const out = []
  const seen = new Set()
  const collectRowName = (name) => {
    if (typeof name !== 'string') return
    if (CORE_PLUGINS.has(name) || seen.has(name)) return
    seen.add(name)
    let dir
    for (const searchPath of profileRequire.resolve.paths(name) ?? []) {
      const candidate = join(searchPath, name)
      if (existsSync(join(candidate, 'package.json'))) { dir = candidate; break }
    }
    if (dir === undefined) return // not resolvable from the profile — leave to the runtime fallback
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const entry = resolve(dir, pkg.main ?? 'index.js')
    if (!existsSync(entry)) return
    out.push({ name, entry })
  }
  for (const bundleName of bundles) {
    let bundleDir
    for (const searchPath of profileRequire.resolve.paths(bundleName) ?? []) {
      const candidate = join(searchPath, bundleName)
      if (existsSync(join(candidate, 'package.json'))) { bundleDir = candidate; break }
    }
    if (bundleDir === undefined) continue
    const bundleManifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8'))
    const patchRel = bundleManifest?.dsh?.bundle?.patch ?? bundleManifest?.cos?.bundle?.patch
    const patchPath = resolve(bundleDir, patchRel ?? 'cordis.patch.yml')
    if (!existsSync(patchPath)) continue
    const doc = parseYaml(readFileSync(patchPath, 'utf8'))
    if (!Array.isArray(doc)) continue
    for (const item of doc) {
      if (item.insert !== undefined) for (const row of item.insert) collectRowName(row.name)
      collectRowName(item.name)
    }
  }
  return out
}

function parseArgv(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile') { out.profile = argv[index + 1]; index += 1 }
    else if (argv[index] === '--home') { out.home = argv[index + 1]; index += 1 }
    else if (argv[index] === '--bundle') { out.bundle = argv[index + 1]; index += 1 }
    else if (argv[index] === '--plugin-root') { out.pluginRoot = argv[index + 1]; index += 1 }
  }
  return out
}

/** Diver direct-path mode: collect plugin names mounted by a bundle at a
 * filesystem path, resolved from the plugin root dir (cos-plugins). */
function collectPathPlugins(bundleSpec, pluginRoot) {
  const bundleDir = resolve(bundleSpec)
  let patchPath
  try {
    const bundleManifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8'))
    const rel = bundleManifest?.dsh?.bundle?.patch ?? bundleManifest?.cos?.bundle?.patch
    patchPath = resolve(bundleDir, rel ?? 'cordis.patch.yml')
  } catch {
    patchPath = join(bundleDir, 'cordis.patch.yml')
  }
  if (!existsSync(patchPath)) throw new Error(`build:sea: bundle ${bundleSpec} has no patch at ${patchPath}`)
  const doc = parseYaml(readFileSync(patchPath, 'utf8'))
  const out = []
  const seen = new Set()
  const collectRowName = (name) => {
    if (typeof name !== 'string') return
    if (CORE_PLUGINS.has(name) || seen.has(name)) return
    seen.add(name)
    const slash = name.indexOf('/')
    const pkg = slash >= 0 ? name.slice(slash + 1) : name
    const dir = join(resolve(pluginRoot), pkg)
    if (!existsSync(join(dir, 'package.json'))) return
    const pkgManifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const entry = resolve(dir, pkgManifest.main ?? 'index.js')
    if (!existsSync(entry)) return
    out.push({ name, entry })
  }
  if (!Array.isArray(doc)) return out
  for (const item of doc) {
    if (item.insert !== undefined) for (const row of item.insert) collectRowName(row.name)
    collectRowName(item.name)
  }
  return out
}

const { profile, home: homeArg, bundle, pluginRoot } = parseArgv(process.argv.slice(2))

// 1) Generate the SEA entry: sidecar main + core registry, plus the profile's
// third-party plugins baked into the same graph.
const sidecarMain = join(root, 'packages/sidecar/src/sidecar.ts').replace(/\\\\/g, '/')
const corePlugins = join(root, 'packages/sidecar/src/plugins.ts').replace(/\\\\/g, '/')
let extra = []
let bakeLabel = ''
if (bundle !== undefined) {
  if (pluginRoot === undefined) throw new Error('build:sea: --bundle requires --plugin-root (the directory holding the row-name packages)')
  extra = collectPathPlugins(bundle, pluginRoot)
  bakeLabel = `bundle ${bundle} (${extra.length} third-party plugin(s) baked)`
} else if (profile !== undefined) {
  const home = homeArg === undefined
    ? process.env.COS_HOME || join(homedir(), '.cos')
    : resolve(homeArg)
  extra = collectProfilePlugins(profile, home)
  bakeLabel = `profile ${profile} (${extra.length} third-party plugin(s) baked)`
  if (extra.length === 0) console.log(`build:sea: profile ${profile} exposes no bakeable third-party plugins (bundles resolved: see profile manifest)`)
}
const imports = [
  `import { syncBuiltinESMExports } from 'node:module'`,
  `import { main } from ${JSON.stringify(sidecarMain)}`,
  `import { plugins as corePlugins } from ${JSON.stringify(corePlugins)}`,
  ...extra.map((p, index) => `import * as plugin${index} from ${JSON.stringify(p.entry.replace(/\\/g, '/'))}`),
]
const registry = [
  `const registry = { ...corePlugins`,
  ...extra.map((p, index) => `, ${JSON.stringify(p.name)}: plugin${index}`),
  ` }`,
]
const entrySource = `${imports.join('\n')}

${registry.join('')}

syncBuiltinESMExports()
void main({ watchRoots: [], plugins: registry })
`
writeFileSync(ENTRY, entrySource, 'utf8')

// 2) Bundle the whole graph to a single CJS file — the Node SEA parity
// requires a CJS main. plugin-loader reads `import.meta.url` for
// createRequire, which is undefined in CJS, so shim it to the current file
// URL.
await build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  define: { 'import.meta.url': '"file:///C:/"' },
  outfile: OUT,
  logLevel: 'info',
})

// 3) Generate the SEA blob from the bundled CJS main.
writeFileSync(SEA_CONFIG, JSON.stringify({
  main: OUT,
  output: BLOB,
  disableExperimentalSEAWarning: true,
}, null, 2))
execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONFIG], { cwd: root })

// 4) Inject the blob into a copy of the current node binary (postject API).
copyFileSync(process.execPath, EXE)
await inject(EXE, 'NODE_SEA_BLOB', readFileSync(BLOB), { sentinelFuse: FUSE })

console.log(`\nbuilt ${EXE}${bakeLabel !== '' ? ` (${bakeLabel})` : ''}`)