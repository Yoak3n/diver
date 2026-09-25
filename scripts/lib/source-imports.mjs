/**
 * 源码裸导入扫描（build-core-bundle 与 check-plugin-closure 共用）。
 * 只扫随包源码（各包 src/ 与包根 *.ts）；收集**完整**裸说明符（含子路径）。
 * 排除：node: 前缀、相对路径、file:、data: 等非裸说明符。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CODE_RE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/
// 三类来源：① from '…' 从句（长度无关，覆盖多行 import/export；排除 Array.from 等成员调用）
// ② 裸 import '…' ③ require()/import()
const FROM_RE = /(?<![\w.$])from\s*['"]([^'"]+)['"]/g
const BARE_RE = /\bimport\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g
// 说明符形态：包名/子路径（@scope/name/sub、name/sub、含版本或 URL 片段）
const SPEC_SHAPE_RE = /^[@a-zA-Z0-9][\w@.~:%/+-]*$/

/** 裸说明符判定（返回 null 表示无需解析）。 */
export function bareSpec(spec) {
  if (!spec) return null
  if (spec.startsWith('.') || spec.startsWith('/') || /^[a-zA-Z]:/.test(spec)) return null
  if (spec.startsWith('node:') || spec.startsWith('file:') || spec.startsWith('data:')) return null
  if (spec.startsWith('http:') || spec.startsWith('https:')) return null
  return spec
}

/** 说明符所属包名（@scope/name 或 name）。 */
export function pkgNameOf(spec) {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
}

function walkCodeFiles(dir, out, skipDirs, depth) {
  if (depth > 12) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    if (e.isDirectory()) {
      if (skipDirs.has(e.name)) continue
      walkCodeFiles(join(dir, e.name), out, skipDirs, depth + 1)
    } else if (CODE_RE.test(e.name)) {
      out.push(join(dir, e.name))
    }
  }
  return out
}

/**
 * 扫一个包目录：src/** 与包根 *.ts（运行时真实会被加载的面）。
 * 返回 Map<spec, Set<file>>。
 */
export function scanPackageDir(pkgDir, opts = {}) {
  const skipDirs = new Set(['scripts', 'test', 'tests', '__tests__', 'fixtures', 'dist', ...(opts.skipDirs ?? [])])
  const files = []
  walkCodeFiles(join(pkgDir, 'src'), files, skipDirs, 0)
  for (const e of safeReaddir(pkgDir)) {
    if (e.isFile() && CODE_RE.test(e.name)) files.push(join(pkgDir, e.name))
  }
  return scanFiles(files)
}

/** 剥掉块注释与整行注释（保留行内字符串中的 //，避免误伤 URL）。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\n)[ \t]*\/\/[^\n]*/g, '$1')
}

/** 扫一批文件的裸导入。返回 Map<spec, Set<file>>。 */
export function scanFiles(files) {
  const found = new Map()
  for (const f of files) {
    let text
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    text = stripComments(text)
    for (const re of [FROM_RE, BARE_RE]) {
      for (const m of text.matchAll(re)) {
        const spec = bareSpec(m[1] || m[2] || m[3])
        if (!spec || !SPEC_SHAPE_RE.test(spec)) continue
        if (!found.has(spec)) found.set(spec, new Set())
        found.get(spec).add(f)
      }
    }
  }
  return found
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}
