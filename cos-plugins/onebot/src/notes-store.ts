// @diver/onebot — 笔记落盘（IO）：安全建目录 + 追加 + 容量闸。
//
// 只做「加」：不 rename、不删除、不截断。目录逐段 lstat 后创建，拒绝符号链接
// 与普通文件顶替；最终文件 O_APPEND|O_CREAT|O_RDWR|O_NOFOLLOW，保证写入只会
// 落在 scope 根之内。路径校验在 notes.ts（纯逻辑），这里只负责按已校验的段
// 落盘，并在写入前后复核容量。

import { constants as fsConstants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

import { isEEXIST, isENOENT } from '@diver/basic-tools/fsio'

import { isWithin } from './fs-jail.ts'
import {
  NOTE_MAX_ENTRIES,
  NOTE_MAX_FILE_BYTES,
  NOTE_MAX_SCOPE_BYTES,
  type NotePath,
} from './notes.ts'

export interface NoteStoreCaps {
  maxEntries: number
  maxFileBytes: number
  maxScopeBytes: number
}

export const NOTE_STORE_CAPS: NoteStoreCaps = {
  maxEntries: NOTE_MAX_ENTRIES,
  maxFileBytes: NOTE_MAX_FILE_BYTES,
  maxScopeBytes: NOTE_MAX_SCOPE_BYTES,
}

export interface NoteAppendResult {
  /** 实际写入的文件绝对路径（realpath 父目录 + 文件名）。 */
  path: string
  /** 本次实际追加的字节数（含来源头/分隔符）。 */
  appendedBytes: number
  fileBytes: number
  scopeBytes: number
  scopeEntries: number
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch (error: unknown) {
    if (isENOENT(error)) return null
    throw error
  }
}

/** 创建/校验 $COS_HOME/notes 根，返回 realpath。符号链接或非目录一律拒绝。 */
export async function prepareNotesRoot(cosHome: string): Promise<string> {
  const lexical = join(cosHome, 'notes')
  let info = await lstatOrNull(lexical)
  if (info === null) {
    await mkdir(lexical, { mode: 0o700 })
    info = await lstat(lexical)
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`笔记根不是普通目录：${lexical}`)
  }
  return realpath(lexical)
}

/** 创建/校验一个来源作用域目录，返回 realpath。 */
export async function ensureScopeRoot(notesRoot: string, scopeDir: string): Promise<string> {
  if (!/^[a-z0-9-]+$/.test(scopeDir)) throw new Error(`非法笔记作用域：${scopeDir}`)
  const lexical = join(notesRoot, scopeDir)
  let info = await lstatOrNull(lexical)
  if (info === null) {
    await mkdir(lexical, { mode: 0o700 })
    info = await lstat(lexical)
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`笔记作用域不是普通目录：${scopeDir}`)
  }
  return realpath(lexical)
}

/** 统计作用域内条目与字节数（不跟随符号链接）。 */
async function measureScope(scopeRoot: string): Promise<{ entries: number; bytes: number }> {
  let entries = 0
  let bytes = 0
  const stack = [scopeRoot]
  while (stack.length > 0) {
    const current = stack.pop()!
    let dirents
    try {
      dirents = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of dirents) {
      entries += 1
      const full = join(current, dirent.name)
      if (dirent.isDirectory()) {
        stack.push(full)
        continue
      }
      // 符号链接只计条目，不跟随、不计字节。
      if (!dirent.isFile()) continue
      try {
        bytes += (await stat(full)).size
      } catch {
        // 只读/竞态：不阻断已有条目的统计。
      }
    }
  }
  return { entries, bytes }
}

/**
 * 追加一个块到作用域内文件。父目录不存在时逐段创建；文件只能被追加，
 * 已存在内容原样保留。任何符号链接/非普通文件/超限都会抛错。
 */
export async function appendNote(
  scopeRoot: string,
  notePath: NotePath,
  block: string,
  caps: NoteStoreCaps = NOTE_STORE_CAPS,
): Promise<NoteAppendResult> {
  const blockBytes = Buffer.byteLength(block, 'utf8')
  const before = await measureScope(scopeRoot)
  if (before.bytes + blockBytes > caps.maxScopeBytes) {
    throw new Error(`笔记作用域已满（上限 ${caps.maxScopeBytes} 字节），先清理或改用 remember。`)
  }
  let entries = before.entries

  let current = scopeRoot
  for (const segment of notePath.segments) {
    const next = join(current, segment)
    let info = await lstatOrNull(next)
    if (info === null) {
      if (entries + 1 > caps.maxEntries) {
        throw new Error(`笔记条目过多（上限 ${caps.maxEntries} 个），先清理再写。`)
      }
      try {
        await mkdir(next, { mode: 0o700 })
      } catch (error: unknown) {
        if (!isEEXIST(error)) throw error
      }
      entries += 1
      info = await lstat(next)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`笔记路径中的 "${segment}" 不是普通目录（可能是符号链接或文件）。`)
    }
    const real = await realpath(next)
    if (!isWithin(real, scopeRoot)) {
      throw new Error(`笔记路径越出作用域："${notePath.rel}"。`)
    }
    current = real
  }

  const filePath = join(current, notePath.file)
  let info = await lstatOrNull(filePath)
  const fileExisted = info !== null
  if (info !== null) {
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`笔记目标 "${notePath.file}" 不是普通文件。`)
    }
    if (info.size + blockBytes > caps.maxFileBytes) {
      throw new Error(`笔记文件已满（上限 ${caps.maxFileBytes} 字节），换一个文件再写。`)
    }
  } else if (entries + 1 > caps.maxEntries) {
    throw new Error(`笔记条目过多（上限 ${caps.maxEntries} 个），先清理再写。`)
  } else if (blockBytes > caps.maxFileBytes) {
    throw new Error(`笔记文件已满（上限 ${caps.maxFileBytes} 字节），换一个文件再写。`)
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0
  const flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | noFollow
  const handle = await open(filePath, flags, 0o600)
  try {
    const st = await handle.stat()
    if (!st.isFile()) throw new Error(`笔记目标 "${notePath.file}" 不是普通文件。`)
    let prefix = ''
    if (st.size > 0) {
      const last = Buffer.alloc(1)
      await handle.read(last, 0, 1, st.size - 1)
      if (last[0] !== 0x0a) prefix += '\n'
      // jsonl 不加空行，避免破坏逐行 JSON。
      if (extname(notePath.file).toLowerCase() !== '.jsonl') prefix += '\n'
    }
    const payload = prefix + block
    const payloadBytes = Buffer.byteLength(payload, 'utf8')
    if (st.size + payloadBytes > caps.maxFileBytes) {
      throw new Error(`笔记文件已满（上限 ${caps.maxFileBytes} 字节），换一个文件再写。`)
    }
    if (before.bytes + payloadBytes > caps.maxScopeBytes) {
      throw new Error(`笔记作用域已满（上限 ${caps.maxScopeBytes} 字节），先清理或改用 remember。`)
    }
    const bytes = Buffer.from(payload, 'utf8')
    let offset = 0
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset)
      if (bytesWritten <= 0) throw new Error('笔记写入失败（未写入任何字节）。')
      offset += bytesWritten
    }
    const after = await handle.stat()
    return {
      path: filePath,
      appendedBytes: payloadBytes,
      fileBytes: after.size,
      scopeBytes: before.bytes + payloadBytes,
      scopeEntries: entries + (fileExisted ? 0 : 1),
    }
  } finally {
    await handle.close()
  }
}
