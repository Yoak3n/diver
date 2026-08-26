// @diver/basic-tools — 纯逻辑冒烟测试（不 boot harness，直接测 fsio/read-render/
// observation/grep 模块）。避免沙箱下 tsx/boot 的加载器限制。
//
// 构建（在 harness 目录）：
//   node_modules/.bin/esbuild.cmd ../cos-plugins/basic-tools/scripts/smoke.ts --bundle --platform=node --format=esm --tsconfig=../cos-plugins/basic-tools/tsconfig.json --outfile=smoke.bundle.mjs
// 运行：
//   $env:DIVER_REPO_ROOT = "E:\Project\RustProject\diver"
//   node smoke.bundle.mjs

import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  DiverFsError,
  applyLiteralEdit,
  normalizeLineEndings,
  probe,
  readForEdit,
  resolveLocalTarget,
  restoreLineEndings,
  writeFileAtomic,
} from '../src/fsio.ts'
import { buildWindow, formatReadOutput } from '../src/read-render.ts'
import { ObservationTable } from '../src/observation.ts'
import { parseGrepArgs } from '../src/grep.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1
    console.log(`  ok  ${name}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name} ${detail}`)
  }
}

async function expectError(name: string, fn: () => Promise<unknown> | unknown, code?: string): Promise<void> {
  try {
    await fn()
    fail += 1
    console.log(`FAIL  ${name} (no error thrown)`)
  } catch (error) {
    if (code !== undefined && (!(error instanceof DiverFsError) || error.code !== code)) {
      fail += 1
      console.log(`FAIL  ${name} (wrong error: ${String(error)})`)
    } else {
      pass += 1
      console.log(`  ok  ${name} → ${(error as Error).message.slice(0, 80)}`)
    }
  }
}

const dir = mkdtempSync(join(tmpdir(), 'basic-tools-smoke-'))
const fileA = join(dir, 'a.txt')
const fileB = join(dir, 'b.txt')

console.log('\n── fsio: resolve / probe ──')
{
  const target = await resolveLocalTarget(dir, 'a.txt')
  check('resolve missing file returns realpath key', target.targetKey.endsWith('a.txt'), target.targetKey)
}

console.log('\n── fsio: writeFileAtomic ──')
{
  await writeFileAtomic(fileA, 'line one\nline two\n', undefined, undefined)
  check('write creates file', readFileSync(fileA, 'utf8') === 'line one\nline two\n')
  const existing = await probe(fileA)
  check('probe after write', existing !== null && existing.type === 'file' && existing.size === 18)
  await writeFileAtomic(fileA, 'new content', existing?.mode, undefined)
  check('atomic overwrite', readFileSync(fileA, 'utf8') === 'new content')
  // createIfAbsent 撞已存在 → FS_NOT_OBSERVED
  await expectError('createIfAbsent on existing → FS_NOT_OBSERVED', () =>
    writeFileAtomic(fileA, 'x', undefined, undefined, { displayPath: fileA }), 'FS_NOT_OBSERVED')
}

console.log('\n── fsio: edit helpers ──')
{
  check('normalizeLineEndings', normalizeLineEndings('a\r\nb') === 'a\nb')
  check('restoreLineEndings CRLF', restoreLineEndings('a\nb', 'CRLF') === 'a\r\nb')
  writeFileSync(fileB, 'old one\nold two\n', 'utf8')
  const edit = await readForEdit(fileB, fileB)
  const applied = applyLiteralEdit(edit.content, 'old', 'new', true, fileB)
  check('applyLiteralEdit replaceAll', applied.content === 'new one\nnew two\n' && applied.replacements === 2)
  await expectError('applyLiteralEdit not found', () =>
    applyLiteralEdit('abc', 'zzz', 'x', false, 'p'), 'FS_EDIT_NOT_FOUND')
  await expectError('applyLiteralEdit ambiguous', () =>
    applyLiteralEdit('a a a', 'a', 'b', false, 'p'), 'FS_AMBIGUOUS_EDIT')
}

console.log('\n── read-render: buildWindow ──')
{
  const window = await buildWindow(
    ['line one\nline two\nline three\n'],
    { offset: 2, limit: 10, maxLineLength: 2000, maxBytes: 50 * 1024 },
    'a.txt',
  )
  check('window offset/limit', window.lines.length === 2 && window.lines[0].number === 2 && window.totalLines === 3)
  check('window text', window.lines[0].text === 'line two')
  const out = formatReadOutput('a.txt', { offset: 2, lines: window.lines, totalLines: window.totalLines })
  check('envelope format', out.includes('<path>a.txt</path>') && out.includes('(End of file - total 3 lines)'))
  const long = await buildWindow(['x'.repeat(3000) + '\n'], { offset: 1, limit: 1, maxLineLength: 2000, maxBytes: 50 * 1024 }, 'a.txt')
  check('line truncation', long.lines[0].text.endsWith('(line truncated to 2000 chars)'))
  await expectError('offset out of range', () =>
    buildWindow(['a\n'], { offset: 5, limit: 1, maxLineLength: 2000, maxBytes: 1024 }, 'a.txt'), 'FS_NOT_FOUND')
}

console.log('\n── observation: read-first guard ──')
{
  const obs = new ObservationTable(true)
  await writeFileAtomic(fileA, 'v1', undefined, undefined)
  await expectError('edit unobserved → FS_STALE_VERSION', async () => {
    const target = await resolveLocalTarget(dir, 'a.txt')
    const existing = await probe(target.targetKey)
    if (existing === null) throw new DiverFsError('missing', 'FS_STALE_VERSION')
    if (obs.get(target.targetKey) === undefined) throw new DiverFsError('not read', 'FS_STALE_VERSION')
  }, 'FS_STALE_VERSION')
  const target = await resolveLocalTarget(dir, 'a.txt')
  const info = await probe(target.targetKey)
  obs.markObserved(target.targetKey, info!.version)
  check('observed after mark', obs.has(target.targetKey) && obs.get(target.targetKey) === info!.version)
  await expectError('write existing unobserved → FS_NOT_OBSERVED', async () => {
    const t2 = await resolveLocalTarget(dir, 'b.txt')
    const e2 = await probe(t2.targetKey)
    if (e2 !== null && !obs.has(t2.targetKey)) throw new DiverFsError('not read', 'FS_NOT_OBSERVED')
  }, 'FS_NOT_OBSERVED')
}

console.log('\n── grep: arg validation ──')
{
  check('valid args', JSON.stringify(parseGrepArgs({ pattern: 'x', include: '*.{ts,tsx}' })).length > 0)
  let threw = false
  try { parseGrepArgs({ pattern: '' }) } catch { threw = true }
  check('empty pattern rejects', threw)
  threw = false
  try { parseGrepArgs({ pattern: 'x', include: '!*.ts' }) } catch { threw = true }
  check('negated include rejects', threw)
  threw = false
  try { parseGrepArgs({ pattern: 'x', include: '*.ts,*.js' }) } catch { threw = true }
  check('comma include rejects', threw)
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n[smoke] ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
