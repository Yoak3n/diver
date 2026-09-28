// @diver/basic-tools — 文件系统基础层：稳定错误码与错误判定（fsio-* 各模块共用）。
// 错误用 DiverFsError（带稳定 code）而非上游 FsError 词表，message 即模型可见文案。

/** 稳定的文件操作错误码（上游 FsErrorCode 的简化子集）。 */
export type DiverFsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_NOT_DIRECTORY'
  | 'FS_NOT_TEXT'
  | 'FS_TOO_LARGE'
  | 'FS_STALE_VERSION'
  | 'FS_NOT_OBSERVED'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_PERMISSION_DENIED'
  | 'FS_IO_ERROR'
  | 'FS_ABORTED'

/** 文件操作错误：message 即模型可见文案，code 供上层分支。 */
export class DiverFsError extends Error {
  override readonly name = 'DiverFsError'
  readonly code: DiverFsErrorCode

  constructor(message: string, code: DiverFsErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

export function isENOENT(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export function isENOTDIR(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOTDIR'
}

export function isEEXIST(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function throwIfAborted(signal: AbortSignal | undefined, verb: string): void {
  if (signal?.aborted) throw new DiverFsError(`${verb} aborted`, 'FS_ABORTED')
}
