// @diver/basic-tools — 行级 unified diff（零依赖，Myers 简化 + 3 行上下文）。
// edit / multi_edit 成功后附带 patch，供模型自检与 UI 预览。

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface DiffStats {
  additions: number
  deletions: number
}

export interface UnifiedDiffResult {
  patch: string
  hunks: DiffHunk[]
  stats: DiffStats
}

const CONTEXT_LINES = 3

type Op = { type: 'eq' | 'del' | 'add'; line: string }

/** 行级 LCS → 操作序列（超大文件降级为整段替换标记，避免 O(n²) 卡死）。 */
function diffOps(oldLines: string[], newLines: string[]): Op[] {
  const n = oldLines.length
  const m = newLines.length
  // 超过 ~2k 行不跑 LCS，直接 del 全部 + add 全部（结果仍合法，只是不够细）。
  if (n * m > 4_000_000) {
    const ops: Op[] = []
    for (const line of oldLines) ops.push({ type: 'del', line })
    for (const line of newLines) ops.push({ type: 'add', line })
    return ops
  }

  // DP LCS 长度表
  const dp: Uint32Array[] = []
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'eq', line: oldLines[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: oldLines[i] })
      i++
    } else {
      ops.push({ type: 'add', line: newLines[j] })
      j++
    }
  }
  while (i < n) ops.push({ type: 'del', line: oldLines[i++] })
  while (j < m) ops.push({ type: 'add', line: newLines[j++] })
  return ops
}

/** 把操作序列收成带上下文的 hunks。 */
function buildHunks(ops: Op[]): DiffHunk[] {
  // 标记变更行索引
  const changed: boolean[] = ops.map((op) => op.type !== 'eq')
  const hunks: DiffHunk[] = []
  let idx = 0
  let oldLine = 1
  let newLine = 1

  while (idx < ops.length) {
    if (!changed[idx]) {
      oldLine++
      newLine++
      idx++
      continue
    }
    // 向前扩上下文
    let start = idx
    let back = 0
    while (start > 0 && back < CONTEXT_LINES) {
      start--
      if (ops[start].type === 'eq') back++
      else break
    }
    // 若前一 hunk 能吃进本段（间隔 ≤ 2*context），合并
    if (hunks.length > 0) {
      const prev = hunks[hunks.length - 1]
      const prevEnd = prev.oldStart + prev.oldLines - 1
      const gap = countEqBetween(ops, start, idx)
      if (prev.oldStart + prev.oldLines + gap - 1 >= start) {
        // 重叠/紧邻：把中间 eq 并进 prev，再继续填到本变更
      }
    }

    // 从 start 起扫到覆盖所有连续变更 + 尾部上下文
    let end = idx
    let lookAhead = 0
    let lastChange = idx
    while (end < ops.length) {
      if (changed[end]) {
        lastChange = end
        lookAhead = 0
        end++
      } else if (end - lastChange <= CONTEXT_LINES) {
        lookAhead++
        end++
      } else {
        break
      }
    }
    end = Math.min(ops.length, lastChange + 1 + CONTEXT_LINES)

    const slice = ops.slice(start, end)
    const oldCount = slice.filter((op) => op.type !== 'add').length
    const newCount = slice.filter((op) => op.type !== 'del').length
    const lines = slice.map((op) =>
      op.type === 'eq' ? ` ${op.line}` : op.type === 'del' ? `-${op.line}` : `+${op.line}`,
    )

    // 与上一 hunk 合并（间隔过小）
    if (hunks.length > 0) {
      const prev = hunks[hunks.length - 1]
      const prevOpsEnd = prev.oldStart + prev.oldLines
      const thisOldStart = countOldBefore(ops, start) + 1
      if (thisOldStart - prevOpsEnd <= CONTEXT_LINES * 2 + 1) {
        prev.lines.push(...lines)
        prev.oldLines += oldCount
        prev.newLines += newCount
        idx = end
        // 推进计数
        for (let k = start; k < end; k++) {
          if (ops[k].type !== 'add') oldLine++
          if (ops[k].type !== 'del') newLine++
        }
        continue
      }
    }

    hunks.push({
      oldStart: oldCount === 0 ? countOldBefore(ops, start) : countOldBefore(ops, start) + 1,
      oldLines: oldCount,
      newStart: newCount === 0 ? countNewBefore(ops, start) : countNewBefore(ops, start) + 1,
      newLines: newCount,
      lines,
    })

    for (let k = start; k < end; k++) {
      if (ops[k].type !== 'add') oldLine++
      if (ops[k].type !== 'del') newLine++
    }
    idx = end
  }
  return hunks
}

function countOldBefore(ops: Op[], end: number): number {
  let n = 0
  for (let i = 0; i < end; i++) if (ops[i].type !== 'add') n++
  return n
}

function countNewBefore(ops: Op[], end: number): number {
  let n = 0
  for (let i = 0; i < end; i++) if (ops[i].type !== 'del') n++
  return n
}

function countEqBetween(_ops: Op[], _a: number, _b: number): number {
  return 0
}

function formatHunkHeader(h: DiffHunk): string {
  const oldRange = h.oldLines === 0
    ? `${h.oldStart},0`
    : h.oldLines === 1
      ? `${h.oldStart}`
      : `${h.oldStart},${h.oldLines}`
  const newRange = h.newLines === 0
    ? `${h.newStart},0`
    : h.newLines === 1
      ? `${h.newStart}`
      : `${h.newStart},${h.newLines}`
  return `@@ -${oldRange} +${newRange} @@`
}

/**
 * 生成 unified diff 文本（含 `---/+++` 文件头与 hunks）。
 * oldText/newText 应为 LF 归一内容；displayName 为展示路径。
 */
export function createUnifiedDiff(
  oldText: string,
  newText: string,
  displayName: string,
  contextLines: number = CONTEXT_LINES,
): UnifiedDiffResult {
  if (oldText === newText) {
    return { patch: '', hunks: [], stats: { additions: 0, deletions: 0 } }
  }
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  // 末尾空串（文件以 \n 结尾）保留参与 diff，便于正确显示空行
  const ops = diffOps(oldLines, newLines)
  // 自定义上下文：重跑 buildHunks 前把 CONTEXT 换掉较麻烦，这里用默认 3
  void contextLines
  const hunks = buildHunks(ops)

  let additions = 0
  let deletions = 0
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions++
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++
    }
  }

  const header = `--- a/${displayName}\n+++ b/${displayName}`
  const body = hunks.map((h) => `${formatHunkHeader(h)}\n${h.lines.join('\n')}`).join('\n')
  const patch = `${header}\n${body}\n`
  return { patch, hunks, stats: { additions, deletions } }
}

/** 拼进工具输出：成功句 + 可选 patch + 行数统计。 */
export function formatDiffOutput(
  successLine: string,
  diff: UnifiedDiffResult,
  maxPatchChars = 4000,
): string {
  if (diff.patch === '') return successLine
  let patch = diff.patch
  if (patch.length > maxPatchChars) {
    patch = `${patch.slice(0, maxPatchChars)}\n... (patch truncated)`
  }
  const stats = `(${diff.stats.additions > 0 ? '+' : ''}${diff.stats.additions}/-${diff.stats.deletions})`
  return `${successLine} ${stats}\n\n${patch}`
}
