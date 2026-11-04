// @diver/backend — 设置面板的「提供商卡片」列表（UI 状态，落 diver-settings.json）。
//
// 面板默认只常驻 deepseek-official，其余卡片由用户经「添加模型提供商」加入。
// 首次读取（文件里还没有 providerCards）按当前状态播种：默认项 + 已配齐凭据的
// 适配器 + 自定义身份 —— 升级/迁移后不会把用户已经在用的 provider 藏起来。
//
// 写操作走增量（add / remove）而不是让客户端用本地快照整表覆盖：并发或陈旧快照
// 最多让一次增删落空，不会把别的卡片永久抹掉。

import { readDiverSettings, writeDiverSettings } from './session-helpers.ts'
import type { ProviderDeclView } from './types.ts'

/** 常驻的默认卡片（与前端 DEFAULT_VISIBLE_PROVIDERS 保持一致）。 */
export const DEFAULT_PROVIDER_CARDS: readonly string[] = ['deepseek-official']

/** 卡片上限：防止脏数据把设置文件撑爆。 */
const MAX_CARDS = 32
/** 单个 id 长度上限。 */
const MAX_ID_LENGTH = 100

/**
 * 规整任意输入为去重、去空、限长的 id 列表。
 * 非数组返回 undefined —— 调用方据此区分「未初始化」与「显式清空」。
 */
export function normalizeProviderCards(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (id === '' || id.length > MAX_ID_LENGTH || out.includes(id)) continue
    out.push(id)
    if (out.length >= MAX_CARDS) break
  }
  return out
}

/** 已持久化的卡片 id；undefined = 还没初始化过（调用方负责播种）。 */
export function readProviderCards(): string[] | undefined {
  return normalizeProviderCards(readDiverSettings().providerCards)
}

/** 声明是否已配齐必填凭据（无必填 secret 的 provider 不算「已配置」）。 */
export function isDeclConfigured(decl: ProviderDeclView): boolean {
  const required = (decl.fields ?? []).filter((field) => field.secret && field.required)
  return required.length > 0 && required.every((field) => field.configured)
}

/**
 * 首次初始化：默认项 + 已配置/自定义的 provider，保持注册顺序并去重。
 * 这样老用户升级后，已经填过 key 的 provider 不会因为列表为空而消失。
 */
export function seedProviderCards(decls: readonly ProviderDeclView[]): string[] {
  const ids = [...DEFAULT_PROVIDER_CARDS]
  for (const decl of decls) {
    if (decl.custom === true || isDeclConfigured(decl)) {
      if (!ids.includes(decl.provider)) ids.push(decl.provider)
    }
  }
  return normalizeProviderCards(ids) ?? []
}

/** 追加一张卡片（已存在则原样返回）。 */
export function appendProviderCard(cards: readonly string[], id: string): string[] {
  return normalizeProviderCards([...cards, id]) ?? [...cards]
}

/** 移除一张卡片（不存在则原样返回）。 */
export function dropProviderCard(cards: readonly string[], id: string): string[] {
  return cards.filter((card) => card !== id)
}

/**
 * 持久化卡片列表。
 * 顺带把旧字段 `addedProviders` 置 undefined —— JSON.stringify 会省略该键，
 * 完成一次性的字段名迁移。
 */
export function writeProviderCards(cards: readonly string[]): string[] {
  const normalized = normalizeProviderCards([...cards]) ?? []
  writeDiverSettings({ providerCards: normalized, addedProviders: undefined })
  return normalized
}
