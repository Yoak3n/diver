// @diver/self-prompt — prompts/*.md 解析与装载（纯逻辑可单测）。
//
// 文件格式：YAML frontmatter（仅 order / name）+ Markdown 正文。
// 需要的只有两样：提示词正文 + 优先级 order；编排交给 @cos/system-prompt。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** 单文件正文硬上限，防止误写入超大文件撑爆系统提示词。 */
export const MAX_PROMPT_BYTES = 32 * 1024

export interface PromptSlot {
  /** systemPrompt section 名：`diver:self-prompt:<name>` */
  name: string
  order: number
  text: string
  /** 来源绝对路径，便于 skill 告诉模型改哪个文件。 */
  source: string
}

export type ParseResult =
  | { ok: true; slot: Omit<PromptSlot, 'source'> }
  | { ok: false; error: string }

/**
 * 解析一份 prompt 文件：`---\norder: 110\nname: style\n---\n正文`。
 * 失败返回稳定错误文案（模型可见），不抛异常。
 */
export function parsePromptFile(raw: string, fallbackName: string): ParseResult {
  if (raw.length > MAX_PROMPT_BYTES) {
    return { ok: false, error: `prompt 过大（${raw.length} > ${MAX_PROMPT_BYTES} 字节）` }
  }
  const text = raw.replace(/^﻿/, '')
  if (!text.startsWith('---')) {
    return { ok: false, error: '缺少 frontmatter（文件须以 --- 开头，含 order）' }
  }
  const end = text.indexOf('\n---', 3)
  if (end < 0) {
    return { ok: false, error: 'frontmatter 未闭合（缺少结束 ---）' }
  }
  const head = text.slice(3, end).replace(/^\r?\n/, '')
  const body = text.slice(end + 4).replace(/^\r?\n/, '').trimEnd()
  if (body.length === 0) {
    return { ok: false, error: '正文为空' }
  }

  let order: number | undefined
  let name = fallbackName
  for (const line of head.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const sep = trimmed.indexOf(':')
    if (sep < 0) continue
    const key = trimmed.slice(0, sep).trim()
    const value = trimmed.slice(sep + 1).trim().replace(/^["']|["']$/g, '')
    if (key === 'order') {
      const n = Number(value)
      if (!Number.isInteger(n)) return { ok: false, error: `order 必须是整数，收到 "${value}"` }
      order = n
    } else if (key === 'name') {
      if (value) name = value
    }
  }
  if (order === undefined) {
    return { ok: false, error: 'frontmatter 缺少 order' }
  }
  return { ok: true, slot: { name, order, text: body } }
}

/**
 * 从目录读入全部 `*.md`。
 * - 目录不存在：视为空覆盖层（正常），不记 error
 * - 坏文件 / 真读失败：记入 `errors` 并跳过（层层设防，不整包失败）
 */
export function loadPromptDir(dir: string): { slots: PromptSlot[]; errors: string[] } {
  const slots: PromptSlot[] = []
  const errors: string[] = []
  if (!existsSync(dir)) return { slots, errors }
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md')).sort()
  } catch (err) {
    return { slots, errors: [`无法读取 prompts 目录 ${dir}: ${(err as Error)?.message ?? err}`] }
  }
  for (const file of names) {
    const source = join(dir, file)
    try {
      if (!statSync(source).isFile()) continue
      const raw = readFileSync(source, 'utf8')
      const fallback = basename(file, '.md')
      const result = parsePromptFile(raw, fallback)
      if (result.ok) slots.push({ ...result.slot, source })
      else errors.push(`${file}: ${result.error}`)
    } catch (err) {
      errors.push(`${file}: ${(err as Error)?.message ?? err}`)
    }
  }
  return { slots, errors }
}

/**
 * 合并 bundled + override（同名以 override 为准），按 order 升序。
 * 用于注册 `diver:self-prompt:<name>` section。
 */
export function mergePromptSlots(
  bundled: PromptSlot[],
  overrides: PromptSlot[],
): PromptSlot[] {
  const map = new Map<string, PromptSlot>()
  for (const slot of bundled) map.set(slot.name, slot)
  for (const slot of overrides) map.set(slot.name, slot)
  return [...map.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

/** 每次组装前重读两层目录（热加载；不必为改正文而重启）。 */
export function collectLiveSlots(
  bundledDir: string,
  overrideDir: string,
): { slots: PromptSlot[]; errors: string[] } {
  const bundled = loadPromptDir(bundledDir)
  const overrides = loadPromptDir(overrideDir)
  return {
    slots: mergePromptSlots(bundled.slots, overrides.slots),
    errors: [...bundled.errors, ...overrides.errors],
  }
}

/** section 名前缀：`diver:self-prompt:<name>`。 */
export const SECTION_PREFIX = 'diver:self-prompt:'

export function sectionNameOf(slotName: string): string {
  return `${SECTION_PREFIX}${slotName}`
}
