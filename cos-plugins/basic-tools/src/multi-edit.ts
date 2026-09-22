// @diver/basic-tools — multi_edit 工具：同一文件按顺序应用多处字面替换。
// 一次 read、多处 edit；任一处失败则整文件不落盘（全有或全无）。

import type { Context } from 'cordis'

import {
  DiverFsError,
  applyLiteralEdit,
  probe,
  readForEdit,
  resolveLocalTarget,
  restoreLineEndings,
  writeFileAtomic,
} from './fsio.ts'
import type { ObservationTable } from './observation.ts'
import { createUnifiedDiff, formatDiffOutput } from './diff.ts'

export interface MultiEditCaps {
  workspaceRoot: string
  observation: ObservationTable
}

interface EditItem {
  old_string: string
  new_string: string
  replace_all?: boolean
}

interface MultiEditArgs {
  file_path: string
  edits: EditItem[]
}

function parseMultiEditArgs(args: MultiEditArgs): { filePath: string; edits: EditItem[] } {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  if (!Array.isArray(args.edits) || args.edits.length === 0) {
    throw new Error('edits must be a non-empty array')
  }
  for (const [i, e] of args.edits.entries()) {
    if (!e || typeof e.old_string !== 'string' || e.old_string.length === 0) {
      throw new Error(`edits[${i}].old_string must be a non-empty string`)
    }
    if (typeof e.new_string !== 'string') {
      throw new Error(`edits[${i}].new_string must be a string`)
    }
    if (e.old_string === e.new_string) {
      throw new Error(`edits[${i}]: old_string and new_string must differ`)
    }
  }
  return { filePath: args.file_path, edits: args.edits }
}

export function applyMultiEditTool(ctx: Context, caps: MultiEditCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:multi_edit',
    order: 103,
    text: 'Use multi_edit when one file needs several independent replacements. Each edit is applied in order to the evolving content; all must succeed or nothing is written. Prefer it over repeated edit calls to save round-trips. Read the file first (observation policy).',
  })

  ctx.tools.register('multi_edit', async (args, signal) => {
    const input = parseMultiEditArgs(args as MultiEditArgs)
    const target = await resolveLocalTarget(caps.workspaceRoot, input.filePath)

    const existing = await probe(target.targetKey)
    if (existing === null) {
      throw new DiverFsError(
        `cannot multi_edit "${target.displayPath}": file changed since it was read — re-read the file, then retry`,
        'FS_STALE_VERSION',
      )
    }
    if (existing.type !== 'file') {
      throw new DiverFsError(`cannot multi_edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    const observed = caps.observation.get(target.targetKey)
    if (observed === undefined || observed !== existing.version) {
      throw new DiverFsError(
        `cannot multi_edit "${target.displayPath}": file changed since it was read — read the file, then retry`,
        'FS_STALE_VERSION',
      )
    }

    const original = await readForEdit(target.targetKey, target.displayPath, signal)
    let content = original.content
    let totalReplacements = 0
    for (const [i, edit] of input.edits.entries()) {
      try {
        const result = applyLiteralEdit(
          content,
          edit.old_string,
          edit.new_string,
          edit.replace_all ?? false,
          target.displayPath,
        )
        content = result.content
        totalReplacements += result.replacements
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new DiverFsError(
          `multi_edit aborted at edits[${i}] (no changes written): ${reason}`,
          error instanceof DiverFsError ? error.code : 'FS_EDIT_NOT_FOUND',
        )
      }
    }

    const restored = restoreLineEndings(content, original.lineEndings)
    await writeFileAtomic(target.targetKey, restored, existing.mode, signal)
    const after = await probe(target.targetKey)
    if (after !== null) caps.observation.markObserved(target.targetKey, after.version)

    return {
      content: formatDiffOutput(
        `The file ${target.displayPath} has been updated. Applied ${input.edits.length} edit(s), ${totalReplacements} replacement(s).`,
        createUnifiedDiff(original.content, content, target.displayPath),
      ),
    }
  }, {
    description:
      'Apply multiple literal replacements to one UTF-8 text file in a single call. Edits run in order on the evolving content. All succeed or nothing is written.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to edit; relative paths resolve against the workspace root.' },
        edits: {
          type: 'array',
          description: 'Ordered list of replacements.',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Literal text to replace. Must match exactly.' },
              new_string: { type: 'string', description: 'Literal replacement text. Empty string deletes the match.' },
              replace_all: { type: 'boolean', description: 'Replace all matches of this old_string. Default false (must be unique).' },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['file_path', 'edits'],
    },
  })
}
