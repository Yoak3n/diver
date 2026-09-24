// @diver/basic-tools — 纯逻辑冒烟测试（不 boot harness，直接测 fsio/read-render/
// observation/grep 模块）。避免沙箱下 tsx/boot 的加载器限制。
//
// 构建（在 harness 目录）：
//   node_modules/.bin/esbuild.cmd ../cos-plugins/basic-tools/scripts/smoke.ts --bundle --platform=node --format=esm --tsconfig=../cos-plugins/basic-tools/tsconfig.json --outfile=smoke.bundle.mjs
// 运行：
//   $env:DIVER_REPO_ROOT = "E:\Project\RustProject\diver"
//   node smoke.bundle.mjs

import { join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
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
import { globToRegExp, walkGlob } from '../src/find.ts'
import { listDirectory } from '../src/ls.ts'
import { formatSize, truncateHead, truncateTail, truncateLine } from '../src/truncate.ts'
import { createUnifiedDiff, formatDiffOutput } from '../src/diff.ts'
import {
  clampRegionToDisplay,
  DEFAULT_MAX_WIDTH,
  DEFAULT_REGION_MAX_WIDTH,
  displayAtPoint,
  jpegQualityLadder,
  parseScreenshotArgs,
  planEncode,
  scaleToFit,
  SHOT_MAX_BYTES,
  sizeHint,
} from '../src/screenshot-policy.ts'

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

console.log('\n── truncate ──')
{
  const head = truncateHead('l1\nl2\nl3\n', { maxLines: 2, maxBytes: 1024 })
  check('truncateHead keeps first lines', head.content === 'l1\nl2' && head.truncatedBy === 'lines')
  const tail = truncateTail('l1\nl2\nl3\n', { maxLines: 2, maxBytes: 1024 })
  check('truncateTail keeps last lines', tail.content === 'l2\nl3' && tail.truncatedBy === 'lines')
  const line = truncateLine('x'.repeat(20), 10)
  check('truncateLine adds marker', line.wasTruncated && line.text.endsWith('... [truncated]'))
  check('formatSize KB', formatSize(2048) === '2.0KB')
}

console.log('\n── find: globToRegExp ──')
{
  check('glob *', globToRegExp('*.ts').test('a.ts') && !globToRegExp('*.ts').test('src/a.ts'))
  check('glob **/', globToRegExp('**/*.ts').test('src/deep/a.ts'))
  check('glob ?', globToRegExp('a?.ts').test('ab.ts') && !globToRegExp('a?.ts').test('abc.ts'))
}

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
  const ok = parseGrepArgs({ pattern: 'x', include: ['*.{ts,tsx}'], exclude: ['*.min.js'], maxCount: 10 })
  check('include/exclude globs', ok.globs.includes('*.{ts,tsx}') && ok.globs.includes('!*.min.js') && ok.maxCount === 10)
  check('exclude auto-negates', parseGrepArgs({ pattern: 'x', exclude: '!a.js' }).globs.includes('!a.js'))
  let threw = false
  try { parseGrepArgs({ pattern: '' }) } catch { threw = true }
  check('empty pattern rejects', threw)
  threw = false
  try { parseGrepArgs({ pattern: 'x', include: '  ' }) } catch { threw = true }
  check('blank include rejects', threw)
  threw = false
  try { parseGrepArgs({ pattern: 'x', maxCount: 0 }) } catch { threw = true }
  check('maxCount 0 rejects', threw)
  check('negated include allowed', parseGrepArgs({ pattern: 'x', include: '!*.ts' }).globs.includes('!*.ts'))
}

console.log('\n── edit-match: fuzzy strategies ──')
{
  const { findEditMatch } = await import('../src/edit-match.ts')
  check('exact', findEditMatch({ content: 'hello world', search: 'hello', replaceAll: false }).status === 'matched')
  const quote = findEditMatch({ content: 'say “hi” now', search: 'say "hi" now', replaceAll: false })
  check('quote_normalized', quote.status === 'matched' && quote.strategy === 'quote_normalized')
  const lnum = findEditMatch({ content: 'real code\n', search: '12: real code', replaceAll: false })
  check('line_number_prefix_stripped', lnum.status === 'matched' && lnum.strategy === 'line_number_prefix_stripped')
  const indent = findEditMatch({ content: 'fn a() {\n  let x = 1;\n}\n', search: 'fn a() {\nlet x = 1;\n}\n', replaceAll: false })
  check('line_trimmed/indent', indent.status === 'matched')
  const fuzzyAll = findEditMatch({ content: '  a  \n', search: 'a', replaceAll: true })
  check('replaceAll skips broad matchers', fuzzyAll.status === 'not_found' || fuzzyAll.strategy === 'exact' || fuzzyAll.strategy === 'quote_normalized' || fuzzyAll.strategy === 'escape_normalized' || fuzzyAll.strategy === 'line_number_prefix_stripped')
}

console.log('\n── unified diff ──')
{
  const before = 'keep\nold line\nkeep2\nkeep3\nkeep4\nkeep5\n'
  const after = 'keep\nnew line\nkeep2\nkeep3\nkeep4\nkeep5\n'
  const diff = createUnifiedDiff(before, after, 'a.txt')
  check('diff has headers', diff.patch.startsWith('--- a/a.txt\n+++ b/a.txt'))
  check('diff has hunk', diff.patch.includes('@@'))
  check('diff marks -/+', diff.patch.includes('-old line') && diff.patch.includes('+new line'))
  check('stats +1/-1', diff.stats.additions === 1 && diff.stats.deletions === 1)
  check('same content empty patch', createUnifiedDiff('x', 'x', 'f').patch === '')
  const out = formatDiffOutput('updated', diff)
  check('formatDiffOutput embeds patch', out.includes('updated') && out.includes('@@'))
}

console.log('\n── ls / find walk ──')
{
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, 'sub', 'c.ts'), 'export {}\n', 'utf8')
  writeFileSync(join(dir, 'top.ts'), 'export {}\n', 'utf8')
  writeFileSync(join(dir, 'readme.md'), '# hi\n', 'utf8')
  const listing = await listDirectory(dir, 50)
  check('ls marks dirs', listing.entries.some((e) => e.endsWith('/')) && listing.entries.includes('top.ts'))
  const hits = await walkGlob(dir, '**/*.ts', 10)
  check('find **/*.ts', hits.includes('top.ts') && hits.includes('sub/c.ts') && !hits.includes('readme.md'))
  const one = await walkGlob(dir, '*.md', 10)
  check('find *.md', one.includes('readme.md') && one.length === 1)
}

console.log('\n── screenshot-policy ──')
{
  const full = parseScreenshotArgs({ display: 1 })
  check('display defaults jpeg/overview', full.format === 'jpeg' && full.intent === 'overview' && full.quality === 68)
  const crop = parseScreenshotArgs({ region: { x: 10, y: 20, width: 400, height: 300 } })
  check('region defaults text + higher quality', crop.intent === 'text' && crop.quality === 78)
  let threw = false
  try { parseScreenshotArgs({}) } catch { threw = true }
  check('no target rejects full-dump', threw)
  threw = false
  try { parseScreenshotArgs({ display: -1 }) } catch { threw = true }
  check('negative display rejects', threw)
  threw = false
  try { parseScreenshotArgs({ region: { width: 0, height: 10 } }) } catch { threw = true }
  check('zero region rejects', threw)

  const disp = { x: 2560, y: 0, width: 2560, height: 1440 }
  const outside = clampRegionToDisplay({ x: 0, y: 0, width: 10, height: 10 }, disp)
  check('region outside display', outside.outside && outside.region === null)
  const clipped = clampRegionToDisplay({ x: 2500, y: 0, width: 100, height: 100 }, disp)
  check('region clipped to display', !clipped.outside && clipped.clipped && clipped.region!.x === 2560 && clipped.region!.width === 40)

  const displays = [
    { index: 0, name: 'A', primary: true, x: 0, y: 0, width: 2560, height: 1440, work: { x: 0, y: 0, width: 2560, height: 1400 } },
    { index: 1, name: 'B', primary: false, x: 2560, y: 0, width: 2560, height: 1440, work: { x: 2560, y: 0, width: 2560, height: 1400 } },
  ]
  check('displayAtPoint primary', displayAtPoint(10, 10, displays)?.index === 0)
  check('displayAtPoint secondary', displayAtPoint(3000, 10, displays)?.index === 1)

  const overview = planEncode({
    source: { x: 0, y: 0, width: 2560, height: 1440 },
    quality: 68,
    format: 'jpeg',
    intent: 'overview',
  })
  check('overview maxWidth default', overview.maxWidth === DEFAULT_MAX_WIDTH && overview.maxBytes === SHOT_MAX_BYTES)
  const textPlan = planEncode({
    source: { x: 0, y: 0, width: 800, height: 600 },
    region: { x: 0, y: 0, width: 800, height: 600 },
    quality: 78,
    format: 'jpeg',
    intent: 'text',
  })
  check('text region keeps 1:1', textPlan.maxWidth >= 800 && !scaleToFit(800, 600, textPlan.maxWidth).scaled)
  const wideText = planEncode({
    source: { x: 0, y: 0, width: 2560, height: 400 },
    region: { x: 0, y: 0, width: 2560, height: 400 },
    quality: 78,
    format: 'jpeg',
    intent: 'text',
  })
  check('wide text region caps at region default', wideText.maxWidth === DEFAULT_REGION_MAX_WIDTH)

  const fit = scaleToFit(2560, 1440, 1920)
  check('scaleToFit caps width', fit.scaled && fit.width === 1920 && fit.height === 1080)
  check('scaleToFit no upscale', !scaleToFit(800, 600, 1920).scaled)

  const ladder = jpegQualityLadder(68)
  check('quality ladder descends', ladder[0] === 68 && ladder[ladder.length - 1] <= 40)
  check('sizeHint text scaled warns', sizeHint('text', 2048, true).includes('tighter region'))
  // 体积策略：默认产物上限应明显小于 read 4MB
  check('shot budget under read limit', SHOT_MAX_BYTES < 4 * 1024 * 1024 && SHOT_MAX_BYTES <= 800 * 1024)
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n[smoke] ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
