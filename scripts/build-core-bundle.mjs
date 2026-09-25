/**
 * P1 依赖 vendor 化构建器（V 案）。
 *
 * 把 harness/packages + plugins 源码引用到的**第三方依赖闭包**用 esbuild 打成
 * 少数大文件落在 sidecar/node_modules（唯一共享解析根）：
 *  - npm 包          → vendor 入口（esbuild bundle + splitting 共享 chunk 保单实例）
 *  - @cos/@diver 等  → 映射包：exports 指到 .shim 重导出**源码**（引擎/插件保持明文可读写）
 *  - tsx/esbuild 等 → 白名单物理目录（loader / 运行时转译器 / 原生二进制）
 *
 * 用法：node scripts/build-core-bundle.mjs [--sidecar <dir>]
 * 依赖：harness/node_modules（pnpm install 产物，解析源）+ 仓库 node_modules 里的 esbuild/tsx。
 */
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const SIDE = resolve(arg('--sidecar', join(ROOT, 'src-tauri', 'resources', 'sidecar')))
const NM = join(SIDE, 'node_modules')
const HARNESS = join(SIDE, 'harness')
const PLUGINS = join(SIDE, 'plugins')
const WORK_NM = join(HARNESS, 'node_modules') // pnpm install 产物（解析源，构建后由调用方删除）

const BUILTIN = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'diagnostics_channel', 'dns', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
])
// 物理白名单：Node/tsx loader、运行时转译器、原生二进制 —— 不进 vendor
const WHITELIST = new Set(['tsx', 'esbuild', 'fsevents']) // typescript 不进白名单：tsx 运行时唯一依赖是 esbuild，tsc 无人引用（省 21MB/121 文件）

const step = (s) => console.log(`\n[core-bundle] ${s}`)
const die = (msg) => { console.error(`[core-bundle] FAIL: ${msg}`); process.exit(1) }

// ── 1. 随包源码包清单与裸导入扫描 ────────────────────────────────────────
step('扫描随包源码裸导入')
const { scanPackageDir } = await import('./lib/source-imports.mjs')

/** 运行时会被加载的源码包目录（与 bundle-release 的复制面一致）。 */
function shippedPackageDirs() {
  const dirs = []
  const pkgs = join(HARNESS, 'packages')
  for (const e of readdirSync(pkgs, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    if (e.name === 'dsh') {
      for (const d of readdirSync(join(pkgs, 'dsh'), { withFileTypes: true })) {
        if (d.isDirectory()) dirs.push(join(pkgs, 'dsh', d.name))
      }
      continue
    }
    dirs.push(join(pkgs, e.name))
  }
  for (const e of readdirSync(PLUGINS, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      dirs.push(join(PLUGINS, e.name))
    }
  }
  return dirs
}

const specFiles = new Map()
for (const dir of shippedPackageDirs()) {
  for (const [spec, files] of scanPackageDir(dir)) {
    if (!specFiles.has(spec)) specFiles.set(spec, new Set())
    for (const f of files) specFiles.get(spec).add(f)
  }
}
let refCount = 0
for (const s of specFiles.values()) refCount += s.size
console.log(`  ✓ ${specFiles.size} 个裸说明符（${refCount} 处引用）`)

// ── 2. 分类：builtin / 白名单 / 源码映射 / vendor ─────────────────────────
step('解析分类')
const pkgNameOf = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
// 解析锚点：harness 安装树（lockfile 干净闭包）→ 仓库根 → 插件开发目录（插件私有依赖）。
// 不用 sidecar/plugins/*：组装副本无 node_modules，walk-up 会误入构建中的 node_modules。
const anchors = [join(HARNESS, 'package.json'), join(ROOT, 'package.json')]
for (const e of readdirSync(join(ROOT, 'cos-plugins'), { withFileTypes: true })) {
  if (e.isDirectory()) anchors.push(join(ROOT, 'cos-plugins', e.name, 'package.json'))
}
const reqs = anchors.filter((a) => existsSync(a)).map((a) => createRequire(a))
const resolveSpec = (spec) => {
  for (const req of reqs) {
    try {
      return req.resolve(spec)
    } catch { /* 下一候选 */ }
  }
  return null
}
/** 工作区包兜底：@cos/@diver/@deepseek-ai/dsh-* 直接对源码目录取 exports/main。 */
function workspaceFallback(spec) {
  const pkgName = pkgNameOf(spec)
  const sub = spec.slice(pkgName.length).replace(/^\//, '')
  const cands = pkgName.startsWith('@diver/')
    ? [join(PLUGINS, pkgName.slice('@diver/'.length))]
    : pkgName.startsWith('@cos/')
      ? [join(HARNESS, 'packages', pkgName.slice('@cos/'.length))]
      : pkgName.startsWith('@deepseek-ai/dsh-')
        ? [join(HARNESS, 'packages', 'dsh', pkgName.slice('@deepseek-ai/dsh-'.length))]
        : []
  for (const dir of cands) {
    const pjPath = join(dir, 'package.json')
    if (!existsSync(pjPath)) continue
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
    const exp = typeof pj.exports === 'object' && pj.exports !== null ? pj.exports : {}
    const t = !sub ? (exp['.'] ?? pj.main) : exp[`./${sub}`]
    if (typeof t === 'string') return resolve(dir, t)
    for (const c of [join(dir, sub), join(dir, `${sub}.ts`), join(dir, 'src', `${sub}.ts`)]) {
      if (sub && existsSync(c)) return c
    }
  }
  return null
}
const pkgRootOf = (file) => {
  let dir = dirname(file)
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return dirname(file)
}

const builtin = [], whitelisted = [], mapping = new Map(), vendor = new Map()
for (const spec of specFiles.keys()) {
  const base = pkgNameOf(spec)
  if (spec.startsWith('node:') || BUILTIN.has(base)) { builtin.push(spec); continue }
  if (WHITELIST.has(base) || base.startsWith('@esbuild/')) { whitelisted.push(spec); continue }
  const fb = workspaceFallback(spec)
  const real = fb ?? resolveSpec(spec)
  if (!real) die(`无法解析 ${spec}（来自 ${[...specFiles.get(spec)][0]}）`)
  const realN = resolve(real)
  // 映射 = 随包源码（workspace 回退命中，或解析落点在随包树内且非 node_modules）。
  // 注意：harness/node_modules（.pnpm 真路径）在 HARNESS 前缀下但**不是**源码，
  // 误判会生成指向构建期 .pnpm 的 shim（删树后失效）。
  const inWorkspace = fb !== null
    || ((realN.startsWith(HARNESS + '\\') || realN.startsWith(HARNESS + '/') || realN.startsWith(PLUGINS + '\\') || realN.startsWith(PLUGINS + '/'))
      && !/[\\/]node_modules[\\/]/.test(realN))
  if (inWorkspace) mapping.set(spec, realN)
  else vendor.set(spec, realN)
}
console.log(`  ✓ builtin ${builtin.length} / 白名单 ${whitelisted.length} / 源码映射 ${mapping.size} / vendor ${vendor.size}`)

// ── 3. 预生成源码映射（探测期源码的裸导入须经映射解析；default 行探测后补）──
step('预生成源码映射')
rmSync(NM, { recursive: true, force: true }) // 清历史产物，防陈旧 shim/exports 混入
mkdirSync(NM, { recursive: true })
const ensurePkg = (pkgName) => {
  const dir = join(NM, ...pkgName.split('/'))
  const pj = join(dir, 'package.json')
  if (!existsSync(pj)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(pj, JSON.stringify({
      name: pkgName, type: 'module', version: '0.0.0-p1',
      exports: { './package.json': './package.json' },
    }, null, 2) + '\n')
  }
  return { dir, j: JSON.parse(readFileSync(pj, 'utf8')), pj }
}
const setExport = (pkgName, sub, target) => {
  const { dir, j, pj } = ensurePkg(pkgName)
  j.exports[sub ? `./${sub}` : '.'] = target
  writeFileSync(pj, JSON.stringify(j, null, 2) + '\n')
  return dir
}
const writeMappingShim = (spec, file, hasDefault) => {
  const pkgName = pkgNameOf(spec)
  const sub = spec.slice(pkgName.length).replace(/^\//, '')
  const shimName = `${(sub || 'index').replace(/[\\/]/g, '__')}.mjs`
  const dir = setExport(pkgName, sub, `./.shim/${shimName}`)
  const rel = relative(join(dir, '.shim'), file).replace(/\\/g, '/')
  const target = JSON.stringify(rel.startsWith('.') ? rel : `./${rel}`)
  const lines = [`export * from ${target};`]
  if (hasDefault) lines.push(`export { default } from ${target};`)
  mkdirSync(join(dir, '.shim'), { recursive: true })
  writeFileSync(join(dir, '.shim', shimName), lines.join('\n') + '\n')
}
for (const [spec, file] of mapping) writeMappingShim(spec, file, false)

// ── 4. 探测 export 面（vendor 原包 + 映射源码）──────────────────────────
step('探测 export 面')
const tsxLoader = (() => {
  const p = resolveSpec('tsx')
  return p ? pathToFileURL(p).href : 'tsx'
})()
const tmpDir = join(ROOT, 'node_modules', '.p1-vendor')
rmSync(tmpDir, { recursive: true, force: true })
mkdirSync(tmpDir, { recursive: true })

const probeScript = (entries) =>
  `import { pathToFileURL } from 'node:url'\nconst out = {}\n` +
  entries.map(([spec, file]) =>
    `try { const ns = await import(pathToFileURL(${JSON.stringify(file)}).href); out[${JSON.stringify(spec)}] = { names: Object.keys(ns).filter((k) => k !== 'default'), hasDefault: 'default' in ns } } catch (e) { out[${JSON.stringify(spec)}] = { error: String(e).slice(0, 300) } }`
  ).join('\n') +
  `\nconsole.log(JSON.stringify(out))\n`
const runProbe = (entries, name) => {
  const p = join(tmpDir, name)
  writeFileSync(p, probeScript(entries))
  return JSON.parse(execFileSync(process.execPath, ['--import', tsxLoader, p], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: ROOT,
  }))
}
const vendorFaces = runProbe([...vendor], 'probe-vendor.mjs')
const mappingFaces = runProbe([...mapping], 'probe-mapping.mjs')
for (const [spec, face] of [...Object.entries(vendorFaces), ...Object.entries(mappingFaces)]) {
  if (face.error) die(`探测失败 ${spec}: ${face.error}`)
}
console.log(`  ✓ vendor ${Object.keys(vendorFaces).length} + mapping ${Object.keys(mappingFaces).length}`)

// ── 5. vendor 包装入口 + esbuild 打包 ────────────────────────────────────
step('esbuild 打包 vendor 闭包')
const wrapDir = join(tmpDir, 'wraps')
mkdirSync(wrapDir, { recursive: true })
const RESERVED = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield await'.split(' '))
const identOk = (n) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n) && !RESERVED.has(n)
const relImport = (file) => {
  const f = file.replace(/\\/g, '/')
  return JSON.stringify(/^[a-zA-Z]:/.test(f) ? f : `./${f}`)
}

/**
 * 包装入口：显式命名导出（`export *` 对 CJS 包无效）+ 条件 default。
 * 命名导出按探测面生成；简单标识符用解构，非常规名用别名导出。
 */
function wrapperFor(file, face, idx) {
  const target = relImport(file)
  const lines = [`import * as __ns from ${target};`]
  const simple = face.names.filter(identOk)
  const odd = face.names.filter((n) => !identOk(n))
  if (simple.length) lines.push(`export const { ${simple.join(', ')} } = __ns;`)
  odd.forEach((n, i) => {
    lines.push(`const __odd${i} = __ns[${JSON.stringify(n)}];`)
    lines.push(`export { __odd${i} as ${JSON.stringify(n)} };`)
  })
  if (face.hasDefault) lines.push('export default __ns.default;')
  const p = join(wrapDir, `w${idx}.mjs`)
  writeFileSync(p, lines.join('\n') + '\n')
  return p
}

const entryPoints = {}
const entryMeta = new Map() // key → { spec, pkgName, outFile }
let n = 0
for (const [spec, file] of vendor) {
  const pkgName = pkgNameOf(spec)
  const key = `${pkgName}/.e${n}`
  entryPoints[key] = wrapperFor(file, vendorFaces[spec], n)
  entryMeta.set(key, { spec, pkgName, outFile: `./.e${n}.js` })
  n++
}

const esbuildPath = resolveSpec('esbuild') ?? createRequire(join(ROOT, 'package.json')).resolve('esbuild')
const { build } = await import(pathToFileURL(esbuildPath).href)
await build({
  entryPoints,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  splitting: true,
  outdir: NM,
  chunkNames: '.vendor/[hash]',
  // CJS 打进 ESM 后 __require 解析不了内建模块；别名防与被打包代码的导入撞名
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  external: ['fsevents', 'tsx', 'esbuild', 'typescript', '@esbuild/*'],
  logLevel: 'warning',
})
console.log(`  ✓ vendor 入口 ${entryMeta.size} 个 → node_modules/`)

// ── 6. 落位：vendor 包 exports（精确寻址）+ 映射 shim 补 default 行 ──────
step('生成包元数据与映射补全')

for (const [key, meta] of entryMeta) setExport(meta.pkgName, meta.spec.slice(meta.pkgName.length).replace(/^\//, ''), meta.outFile)

for (const [spec, file] of mapping) writeMappingShim(spec, file, mappingFaces[spec].hasDefault)
console.log(`  ✓ vendor ${entryMeta.size} 项 / 映射 ${mapping.size} 项`)

// ── 7. 白名单物理复制（含声明依赖闭包）──────────────────────────────────
step('白名单物理复制')
const copied = new Set()
function copyPhysical(pkgName) {
  if (copied.has(pkgName)) return
  copied.add(pkgName)
  let entry = null
  try { entry = resolveSpec(pkgName) } catch { /* */ }
  if (!entry) return
  const src = pkgRootOf(entry)
  const dst = join(NM, ...pkgName.split('/'))
  if (existsSync(dst)) return
  mkdirSync(dirname(dst), { recursive: true })
  // 解引用符号链接（.pnpm 真实目录），并只裁掉根以下的嵌套 node_modules
  let real = src
  try { real = realpathSync.native(src) } catch { /* */ }
  const srcRoot = real.replace(/[\\/]+$/, '')
  cpSync(real, dst, {
    recursive: true,
    filter: (p) => !/[\\/]node_modules([\\/]|$)/.test(p.slice(srcRoot.length)),
  })
  let deps = {}
  try { deps = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).dependencies ?? {} } catch { /* */ }
  console.log(`  ✓ ${pkgName}`)
  for (const d of Object.keys(deps)) copyPhysical(d)
}
for (const name of ['tsx', 'esbuild']) copyPhysical(name) // typescript 不随包：tsx 运行时只需 esbuild
// esbuild 的平台二进制（optionalDependencies，pnpm 放 .pnpm store）：
// 必须与 esbuild JS 同版本落进 NM/@esbuild，否则解析上爬会捡到别的版本（宿主/二进制失配）。
{
  const store = join(WORK_NM, '.pnpm')
  const entries = existsSync(store)
    ? readdirSync(store, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('@esbuild+'))
    : []
  for (const e of entries) {
    const scopeDir = join(store, e.name, 'node_modules', '@esbuild')
    if (!existsSync(scopeDir)) continue
    for (const plat of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!plat.isDirectory()) continue
      const dst = join(NM, '@esbuild', plat.name)
      if (existsSync(dst)) continue
      mkdirSync(join(NM, '@esbuild'), { recursive: true })
      cpSync(join(scopeDir, plat.name), dst, { recursive: true })
      console.log(`  ✓ @esbuild/${plat.name} (${e.name.split('@').pop()})`)
    }
  }
}

// ── 8. 产物自校验：按 Node 解析逐 spec import，与探测面对比 ───────────────
step('产物自校验')
{
  const verify = join(SIDE, '.p1-verify.mjs') // 位置使 walk-up 命中 node_modules/
  const specs = [...vendor.keys(), ...mapping.keys()]
  writeFileSync(verify,
    `const out = {}\n` +
    specs.map((s) =>
      `try { const ns = await import(${JSON.stringify(s)}); out[${JSON.stringify(s)}] = { names: Object.keys(ns).filter((k) => k !== 'default'), hasDefault: 'default' in ns } } catch (e) { out[${JSON.stringify(s)}] = { error: String(e).slice(0, 300) } }`
    ).join('\n') + `\nconsole.log(JSON.stringify(out))\n`)
  const seen = JSON.parse(execFileSync(process.execPath, ['--import', tsxLoader, verify], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: SIDE,
  }))
  rmSync(verify, { force: true })
  let bad = 0
  for (const [spec, want] of Object.entries({ ...vendorFaces, ...mappingFaces })) {
    const got = seen[spec]
    const ok = got && !got.error && got.hasDefault === want.hasDefault
      && JSON.stringify([...got.names].sort()) === JSON.stringify([...want.names].sort())
    if (!ok) {
      bad++
      const missing = want.names.filter((x) => !got?.names?.includes(x))
      console.error(`  ✗ ${spec}: ${got?.error ?? `缺 ${missing.join(',') || '(default 面不一致)'}`}`)
    }
  }
  if (bad) die(`${bad} 个说明符产物面与探测面不一致`)
  console.log(`  ✓ ${Object.keys(seen).length} 个说明符 export 面一致`)
}

rmSync(tmpDir, { recursive: true, force: true })
console.log('\n[core-bundle] 完成')
