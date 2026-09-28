// @diver/basic-tools — 文件系统基础层：写入（staging + 原子发布）。
// Windows 覆盖用 rename（Node 的 rename 在 Windows 上即 MoveFileEx 覆盖语义），
// 有既有 mode 时保留（上游用 koffi 复制 DACL + ReplaceFileW，此处置简化）。

import { randomUUID } from 'node:crypto'
import {
  chmod, link, lstat, mkdir, open, rename, rm,
} from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import {
  DiverFsError, errorMessage, isAbortError, isEEXIST, isENOENT, isENOTDIR, throwIfAborted,
} from './fsio-error.ts'

async function removeStagingDirOrThrow(
  stagingDir: string,
  originalError: unknown,
  removeStagingDir: (path: string) => Promise<void>,
): Promise<never> {
  try {
    await removeStagingDir(stagingDir)
  } catch (cleanupError: unknown) {
    throw new DiverFsError(
      `write failed (${errorMessage(originalError)}) and temp cleanup failed (${errorMessage(cleanupError)})`,
      'FS_NOT_FOUND',
      { cause: originalError },
    )
  }
  throw originalError
}

async function throwGuardedCreateFailure(
  error: unknown,
  absolutePath: string,
  displayPath: string,
  inspectPublicationTarget: (path: string) => Promise<BigIntStats>,
): Promise<never> {
  let existing: BigIntStats | undefined
  try {
    existing = await inspectPublicationTarget(absolutePath)
  } catch (metadataError: unknown) {
    if (!isENOENT(metadataError) && !isENOTDIR(metadataError)) {
      throw new DiverFsError(`cannot write "${displayPath}": ${errorMessage(metadataError)}`, 'FS_IO_ERROR', { cause: metadataError })
    }
  }
  if (existing !== undefined) {
    if (!existing.isFile()) {
      throw new DiverFsError(`cannot write "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE', { cause: error })
    }
    throw new DiverFsError(
      `cannot overwrite existing "${displayPath}" without reading it first`,
      'FS_NOT_OBSERVED',
      { cause: error },
    )
  }
  if (isEEXIST(error)) {
    throw new DiverFsError(
      `cannot overwrite existing "${displayPath}" without reading it first`,
      'FS_NOT_OBSERVED',
      { cause: error },
    )
  }
  throw new DiverFsError(`cannot write "${displayPath}": ${errorMessage(error)}`, 'FS_IO_ERROR', { cause: error })
}

/**
 * 通过同目录私有、已 sync 的 staging 文件原子替换目标文件。
 * staging 目录与文件以 0o700 / 0o600 创建；Windows 覆盖用 rename（Node 的
 * rename 在 Windows 上即 MoveFileEx 覆盖语义），有既有 mode 时保留。
 */
export async function writeFileAtomic(
  absolutePath: string,
  content: string,
  mode: number | undefined,
  signal: AbortSignal | undefined,
  createIfAbsent?: { displayPath: string },
): Promise<void> {
  throwIfAborted(signal, 'write')
  const directory = dirname(absolutePath)
  await mkdir(directory, { recursive: true })

  throwIfAborted(signal, 'write')
  const stagingDirName = `.${basename(absolutePath)}.${process.pid}.${randomUUID()}.tmpdir`
  const stagingDir = join(directory, stagingDirName)
  const tempPath = join(stagingDir, `${basename(absolutePath)}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let stagingCreated = false
  try {
    await mkdir(stagingDir, { mode: 0o700 })
    stagingCreated = true
    await chmod(stagingDir, 0o700)

    handle = await open(tempPath, 'wx', 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(content, { encoding: 'utf8', ...signal ? { signal } : {} })
    await handle.sync()
    if (mode !== undefined) await handle.chmod(mode)
    await handle.close()
    handle = undefined

    throwIfAborted(signal, 'write')
    if (createIfAbsent !== undefined) {
      try {
        await link(tempPath, absolutePath)
      } catch (error: unknown) {
        await throwGuardedCreateFailure(
          error,
          absolutePath,
          createIfAbsent.displayPath,
          path => lstat(path, { bigint: true }),
        )
      }
    } else {
      await rename(tempPath, absolutePath)
    }
    try {
      await rm(stagingDir, { recursive: true, force: true })
    } catch (_committedStagingCleanupFailure) {
      // 目标已提交；owner-only staging 残留不应把这次写入变成失败。
    }
  } catch (error: unknown) {
    let failure: unknown = isAbortError(error) ? new DiverFsError('write aborted', 'FS_ABORTED') : error
    if (handle) {
      try {
        await handle.close()
      } catch (closeError: unknown) {
        failure = new DiverFsError(
          `write failed (${errorMessage(failure)}) and temp close failed (${errorMessage(closeError)})`,
          'FS_NOT_FOUND',
          { cause: failure },
        )
      }
    }
    if (!stagingCreated) throw failure
    return removeStagingDirOrThrow(stagingDir, failure, path => rm(path, { recursive: true, force: true }))
  }
}
