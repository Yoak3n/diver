// @diver/self-prompt — 提示词槽位专用读写（纯逻辑 + 受限写盘）。
//
// 只写覆盖层 `$COS_HOME/self-prompt/prompts/<slot>.md`：
// - slot 是白名单标识，不接受路径
// - 自动生成 frontmatter（order/name）
// - 单文件沿用 MAX_PROMPT_BYTES 硬上限
// 这样主人发起的 OneBot 回合不需要 read/write/edit 也能自改提示词。

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  MAX_PROMPT_BYTES,
  loadPromptDir,
  mergePromptSlots,
  type PromptSlot,
} from './prompts.ts'

/** 槽位名：小写字母/数字/下划线/短横线，1-64 位；不允许路径分隔符。 */
export const SLOT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface ReviseInput {
  slot: string
  order: number
  body: string
}

export type ReviseResult =
  | { ok: true; slot: string; order: number; bytes: number }
  | { ok: false; error: string }

/** 解析并校验工具参数；失败返回稳定错误文案。 */
export function parseReviseInput(args: unknown): ReviseInput | { error: string } {
  const a = (args ?? {}) as { slot?: unknown; order?: unknown; body?: unknown }
  const slot = typeof a.slot === 'string' ? a.slot.trim() : ''
  if (!SLOT_PATTERN.test(slot)) {
    return { error: 'slot 必须是 1-64 位小写字母/数字/下划线/短横线，且不能包含路径' }
  }
  const order = typeof a.order === 'number' ? a.order : Number(a.order)
  if (!Number.isInteger(order)) return { error: 'order 必须是整数' }
  const body = typeof a.body === 'string' ? a.body.trim() : ''
  if (body === '') return { error: 'body 不能为空' }
  return { slot, order, body }
}

/** 生成带 frontmatter 的槽位文件内容。 */
export function formatPromptFile(slot: string, order: number, body: string): string {
  return `---\norder: ${order}\nname: ${slot}\n---\n${body.trimEnd()}\n`
}

/** 写入覆盖层；只接受已校验的 slot，路径不可逃逸。 */
export function writePromptOverride(dir: string, input: ReviseInput): ReviseResult {
  if (!SLOT_PATTERN.test(input.slot)) return { ok: false, error: 'slot 非法' }
  const raw = formatPromptFile(input.slot, input.order, input.body)
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes > MAX_PROMPT_BYTES) {
    return { ok: false, error: `prompt 过大（${bytes} > ${MAX_PROMPT_BYTES} 字节）` }
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${input.slot}.md`), raw, 'utf8')
  return { ok: true, slot: input.slot, order: input.order, bytes }
}

export interface PromptSlotInfo {
  slot: string
  order: number
  source: 'bundled' | 'override'
  bytes: number
}

/** 列出合并后的槽位；不返回绝对路径。 */
export function listPromptSlots(
  bundledDir: string,
  overrideDir: string,
): { slots: PromptSlotInfo[]; errors: string[] } {
  const bundled = loadPromptDir(bundledDir)
  const overrides = loadPromptDir(overrideDir)
  const overrideNames = new Set(overrides.slots.map((slot) => slot.name))
  const merged = mergePromptSlots(bundled.slots, overrides.slots)
  return {
    slots: merged.map((slot: PromptSlot) => ({
      slot: slot.name,
      order: slot.order,
      source: overrideNames.has(slot.name) ? 'override' : 'bundled',
      bytes: Buffer.byteLength(slot.text, 'utf8'),
    })),
    errors: [...bundled.errors, ...overrides.errors],
  }
}
