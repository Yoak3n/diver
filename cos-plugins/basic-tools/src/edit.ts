// @diver/basic-tools — edit 工具：对已存在 UTF-8 文本文件做字面替换（移植自
// DSH 上游 @deepseek-ai/dsh-tool-fs/edit + fs-local 的 applyLiteralEdit）。默认
// 唯一匹配；replace_all 全替换；CRLF 归一匹配 + 行尾还原；版本守卫先于匹配。

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

export interface EditCaps {
  workspaceRoot: string
  observation: ObservationTable
}

interface EditArgs {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

/** 校验参数并应用默认值。 */
function parseEditArgs(args: EditArgs): { filePath: string; oldString: string; newString: string; replaceAll: boolean } {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  if (args.old_string.length === 0) throw new Error('old_string must be a non-empty string')
  if (args.old_string === args.new_string) throw new Error('old_string and new_string must differ')
  return {
    filePath: args.file_path,
    oldString: args.old_string,
    newString: args.new_string,
    replaceAll: args.replace_all ?? false,
  }
}

/** 渲染编辑成功的模型可见消息：成功句 + unified diff + 行数统计。 */
function formatEditOutput(displayPath: string, replaceAll: boolean, oldText: string, newText: string): string {
  const success = replaceAll
    ? `The file ${displayPath} has been updated. All occurrences were successfully replaced.`
    : `The file ${displayPath} has been updated successfully.`
  const diff = createUnifiedDiff(oldText, newText, displayPath)
  return formatDiffOutput(success, diff)
}

/** 注册 edit 工具。 */
export function applyEditTool(ctx: Context, caps: EditCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: 102,
    text: 'Use the edit tool for targeted changes to existing UTF-8 text files. It replaces literal old_string with new_string; by default old_string must appear exactly once. If old_string appears multiple times, provide a more specific old_string or set replace_all to true. Read the file first (the default fs-observation-policy requires it), unless you just created or edited it in this session.',
  })

  ctx.tools.register('edit', async (args, signal) => {
    const input = parseEditArgs(args as EditArgs)
    const target = await resolveLocalTarget(caps.workspaceRoot, input.filePath)

    // 版本守卫先于匹配：缺失目标与版本不符都用 stale 码。
    const existing = await probe(target.targetKey)
    if (existing === null) {
      throw new DiverFsError(
        `cannot edit "${target.displayPath}": file changed since it was read — re-read the file, then retry`,
        'FS_STALE_VERSION',
      )
    }
    if (existing.type !== 'file') {
      throw new DiverFsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    const observed = caps.observation.get(target.targetKey)
    if (observed === undefined) {
      throw new DiverFsError(
        `cannot edit "${target.displayPath}": file changed since it was read — read the file, then retry`,
        'FS_STALE_VERSION',
      )
    }
    if (observed !== existing.version) {
      throw new DiverFsError(
        `cannot edit "${target.displayPath}": file changed since it was read — re-read the file, then retry`,
        'FS_STALE_VERSION',
      )
    }

    const original = await readForEdit(target.targetKey, target.displayPath, signal)
    const edited = applyLiteralEdit(original.content, input.oldString, input.newString, input.replaceAll, target.displayPath)
    const content = restoreLineEndings(edited.content, original.lineEndings)
    await writeFileAtomic(target.targetKey, content, existing.mode, signal)

    const after = await probe(target.targetKey)
    if (after !== null) caps.observation.markObserved(target.targetKey, after.version)

    return { content: formatEditOutput(target.displayPath, input.replaceAll, original.content, edited.content) }
  }, {
    description: 'Edit an existing UTF-8 text file by replacing literal text.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to edit; relative paths resolve against the workspace root.' },
        old_string: { type: 'string', description: 'Literal text to replace. Must match exactly.' },
        new_string: { type: 'string', description: 'Literal replacement text. Use an empty string to delete the match.' },
        replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  })
}
