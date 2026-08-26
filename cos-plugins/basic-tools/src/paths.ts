// @diver/basic-tools — 路径解析助手：相对路径基于 workspace 根，绝对路径原样。

import { isAbsolute, resolve } from 'node:path'

/** 把模型给的路径解析为磁盘绝对路径。 */
export function resolveTarget(input: string, workspaceRoot: string): string {
  if (input.trim().length === 0) throw new Error('path must be a non-empty string')
  return isAbsolute(input) ? resolve(input) : resolve(workspaceRoot, input)
}
