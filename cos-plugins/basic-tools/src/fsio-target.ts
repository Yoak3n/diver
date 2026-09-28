// @diver/basic-tools — 文件系统基础层：路径解析与存在性探测。

import { lstat, realpath, stat } from 'node:fs/promises'
import type { BigIntStats, Stats } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { DiverFsError, isENOENT, isENOTDIR } from './fsio-error.ts'

/** 解析后的本地路径：展示用绝对路径 + 身份用的 realpath 键。 */
export interface LocalTarget {
  /** 绝对路径（不解析符号链接）——用于展示。 */
  displayPath: string
  /** realpath 身份——用于稳定目标键与 I/O 路径。 */
  targetKey: string
}

/** 探测结果；null 表示不存在。 */
export interface PathInfo {
  version: string
  mode: number
  type: 'file' | 'directory' | 'other'
  size: number
}

/** Opaque 版本令牌：高精度身份与新鲜度元数据。 */
function versionOf(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

/**
 * 解析路径为绝对展示路径 + realpath 身份。目标缺失时 realpath 最近存在的
 * 祖先并回填缺失后缀，保证创建前后身份稳定（含符号链接祖先）。
 */
export async function resolveLocalTarget(cwd: string, path: string): Promise<LocalTarget> {
  if (path.trim().length === 0) throw new DiverFsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
  const displayPath = resolve(cwd, path)
  try {
    return { displayPath, targetKey: await realpath(displayPath) }
  } catch (error: unknown) {
    if (isENOTDIR(error)) {
      throw new DiverFsError(`cannot resolve "${displayPath}": a parent path segment is not a directory`, 'FS_NOT_FOUND')
    }
    if (!isENOENT(error)) throw error
  }
  // 文件缺失：realpath 最近存在的祖先，回填缺失后缀。
  const missing = [basename(displayPath)]
  let ancestor = dirname(displayPath)
  while (true) {
    try {
      const realAncestor = await realpath(ancestor)
      if (process.platform === 'win32') {
        const parentInfo = await stat(realAncestor)
        if (!parentInfo.isDirectory()) {
          throw new DiverFsError(`cannot resolve "${displayPath}": a parent path segment is not a directory`, 'FS_NOT_FOUND')
        }
      }
      return { displayPath, targetKey: join(realAncestor, ...missing) }
    } catch (error: unknown) {
      if (error instanceof DiverFsError) throw error
      if (!isENOENT(error)) throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) return { displayPath, targetKey: displayPath }
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

function pathType(info: Stats | BigIntStats): PathInfo['type'] {
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'directory'
  return 'other'
}

async function probeStats<T extends Stats | BigIntStats>(
  absolutePath: string,
  readStats: (path: string) => Promise<T>,
): Promise<T | null> {
  try {
    return await readStats(absolutePath)
  } catch (error: unknown) {
    if (!isENOENT(error) && !isENOTDIR(error)) throw error
    return null
  }
}

/** 探测路径的版本/模式/类型/大小；不存在（含父级为文件）时返回 null。 */
export async function probe(absolutePath: string): Promise<PathInfo | null> {
  const info = await probeStats(absolutePath, path => stat(path, { bigint: true }))
  if (!info) return null
  return {
    version: versionOf(info),
    mode: Number(info.mode & 0o777n),
    type: pathType(info),
    size: Number(info.size),
  }
}

/** 不跟随最终符号链接的探测。 */
export async function probeNoFollow(absolutePath: string): Promise<PathInfo | null> {
  const info = await probeStats(absolutePath, path => lstat(path, { bigint: true }))
  if (!info) return null
  return {
    version: versionOf(info),
    mode: Number(info.mode & 0o777n),
    type: pathType(info),
    size: Number(info.size),
  }
}
