// @diver/basic-tools — write 工具：创建或整体覆写 UTF-8 文本文件（移植自 DSH
// 上游 @deepseek-ai/dsh-tool-fs/write + fs-local 的原子写）。私有 staging 目录 +
// fsync + rename 原子发布；read-first 守卫；输出与上游一致的 Created/Updated envelope。

import type { Context } from 'cordis'

import { DiverFsError, probe, resolveLocalTarget, writeFileAtomic } from './fsio.ts'
import type { ObservationTable } from './observation.ts'

export interface WriteCaps {
  workspaceRoot: string
  observation: ObservationTable
}

interface WriteArgs {
  file_path: string
  content: string
}

/** 校验参数（content 空串合法——写空文件）。 */
function parseWriteArgs(args: WriteArgs): { filePath: string; content: string } {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  return { filePath: args.file_path, content: args.content }
}

/** 渲染写入结果 envelope（不回显文件内容）。 */
function formatWriteOutput(displayPath: string, operation: 'create' | 'update'): string {
  const verb = operation === 'create' ? 'Created' : 'Updated'
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${verb} file
</content>`
}

/** 注册 write 工具。 */
export function applyWriteTool(ctx: Context, caps: WriteCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:write',
    order: 101,
    text: 'Use the write tool to create files or completely replace file contents. Existing files are overwritten, so read an existing file first (the default fs-observation-policy requires it) and prefer edit for targeted changes.',
  })

  ctx.tools.register('write', async (args, signal) => {
    const input = parseWriteArgs(args as WriteArgs)
    const target = await resolveLocalTarget(caps.workspaceRoot, input.filePath)

    const existing = await probe(target.targetKey)
    if (existing !== null && existing.type !== 'file') {
      throw new DiverFsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    // read-first 守卫：目标已存在且本会话未读过 → FS_NOT_OBSERVED。
    if (existing !== null && !caps.observation.has(target.targetKey)) {
      throw new DiverFsError(
        `cannot overwrite existing "${target.displayPath}" without reading it first — read the file, then retry`,
        'FS_NOT_OBSERVED',
      )
    }

    await writeFileAtomic(target.targetKey, input.content, existing?.mode, signal)

    const operation: 'create' | 'update' = existing === null ? 'create' : 'update'
    const after = await probe(target.targetKey)
    if (after !== null) caps.observation.markObserved(target.targetKey, after.version)

    return { content: formatWriteOutput(target.displayPath, operation) }
  }, {
    description: 'Create or fully replace a UTF-8 text file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to write; relative paths resolve against the workspace root.' },
        content: { type: 'string', description: 'Full UTF-8 text content to write.' },
      },
      required: ['file_path', 'content'],
    },
  })
}
