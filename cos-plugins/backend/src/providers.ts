// @diver/backend — 模型 provider 配置子系统（适配新版 harness 框架）。
//
// 这层不再硬编码任何 provider 知识（deepseek-official / opencode-go / 具体模型
// 列表均已移除），一切从 harness 的适配器注册表与凭据层推导：
//   - provider 目录与显示名 ← ctx.llm.listProviders()（适配器注册的路由）
//   - 模型目录             ← ctx.llm.listModels(provider)（适配器自行声明，advisory）
//   - 配置 schema          ← ctx.llm.listProviderConfigs() / adapterConfig()
//                            （各 provider 适配器插件声明自己的配置字段）
//   - 凭据判定             ← ctx.credentials.get(field.credentialRef)（适配器已 provide）
//   - 凭据写入             ← 框架配置的 secrets 文件（credentials.config.file）
// 因此新增 provider 只需注册适配器并声明 providerConfig，本插件与设置面板零改动。

import type { Context } from 'cordis'
import type { AdapterConfigField } from '@cos/plugin-api'

import { readDiverSettings, writeDiverSettings } from './session-helpers.ts'
import { secretsFileOf, writeSecret } from './secrets.ts'
import type { ProviderDeclView } from './types.ts'

/**
 * 激活 provider：持久化选择直接采用（即使已不在注册表——让配置错位显式暴露，
 * 而不是悄悄钳制到 mock 之类的其它适配器掩盖问题）；未持久化时取注册表第一个。
 */
export async function activeProvider(ctx: Context): Promise<string | undefined> {
  const settings = readDiverSettings()
  if (typeof settings.provider === 'string' && settings.provider !== '') return settings.provider
  return ctx.llm.listProviders()[0]?.id
}

/** 激活模型的兜底：持久化 model 优先，其次该 provider 适配器目录的第一个模型。 */
export async function firstModelOf(ctx: Context, provider: string): Promise<string | undefined> {
  try {
    const models = await ctx.llm.listModels(provider)
    return models[0]
  } catch { /* 目录失败静默 */ }
  return undefined
}

/** 设置面板持久化的 provider（未持久化时取注册表第一个）——聊天守卫据此判定。 */
export function persistedProvider(ctx: Context): string {
  const settings = readDiverSettings()
  if (typeof settings.provider === 'string' && settings.provider !== '') return settings.provider
  return ctx.llm.listProviders()[0]?.id ?? ''
}

/** 全部可配置 provider 声明（合并注册表 + 适配器声明），并解析每个字段的当前状态。 */
export async function providerDecls(ctx: Context): Promise<ProviderDeclView[]> {
  const out: ProviderDeclView[] = []
  for (const live of ctx.llm.listProviders()) {
    const decl = ctx.llm.adapterConfig(live.id) ?? {
      provider: live.id,
      name: live.name,
      description: undefined,
      fields: [],
    }
    const fields: Array<AdapterConfigField & { configured: boolean; value?: string }> = []
    for (const field of decl.fields) {
      const configured = await fieldConfigured(ctx, live.id, field)
      // 非 secret 的 settings 字段回传当前值，设置面板可回填/清空。
      if (field.store === 'settings' && !field.secret) {
        fields.push({ ...field, configured, value: settingsFieldValue(live.id, field.key) })
      } else {
        fields.push({ ...field, configured })
      }
    }
    out.push({ ...decl, fields })
  }
  return out
}

/** 一个字段的当前状态（secret 字段只回传 configured 布尔）。 */
export async function fieldConfigured(ctx: Context, provider: string, field: AdapterConfigField): Promise<boolean> {
  if (field.store === 'credentials' || field.secret) {
    const ref = field.credentialRef ?? `${provider}.${field.key}`
    try {
      if (ctx.credentials.get(ref)) return true
    } catch { /* 未注册/未解析 */ }
    if (field.envKey !== undefined && process.env[field.envKey]) return true
    return false
  }
  // store === 'settings'
  return settingsFieldValue(provider, field.key).length > 0
}

/** settings 字段当前值（非 secret；供设置面板回填，便于查看/清空）。 */
function settingsFieldValue(provider: string, key: string): string {
  const value = readDiverSettings()[`${provider}.${key}`]
  return typeof value === 'string' ? value : ''
}

/** 模型目录（各 provider 适配器自行声明，advisory）。 */
export async function catalogModels(ctx: Context): Promise<Array<{ provider: string; id: string }>> {
  const models: Array<{ provider: string; id: string }> = []
  for (const { id } of ctx.llm.listProviders()) {
    try {
      for (const model of await ctx.llm.listModels(id)) models.push({ provider: id, id: model })
    } catch { /* 单提供商目录失败静默 */ }
  }
  return models
}

/**
 * 某 provider 是否已配置：
 * - 无适配器（未注册）→ 未配置（聊天守卫据此拒绝）
 * - 有适配器但无必填 secret 字段 → 已配置（如 mock）
 * - 有必填 secret 字段 → 全部可经 ctx.credentials 解析（或环境变量兜底）
 */
export async function isConfigured(ctx: Context, provider: string): Promise<boolean> {
  if (provider === '') return false
  if (!ctx.llm.listProviders().some((p) => p.id === provider)) return false
  const decl = ctx.llm.adapterConfig(provider)
  if (decl === undefined) return true
  const requiredSecrets = decl.fields.filter((f) => f.secret && f.required)
  if (requiredSecrets.length === 0) return true
  for (const field of requiredSecrets) {
    if (!(await fieldConfigured(ctx, provider, field))) return false
  }
  return true
}

/** 按适配器声明动态写入 provider 配置（credentials → secrets 文件；settings → diver-settings）。 */
export async function applyProviderConfigs(
  ctx: Context,
  providerConfigs: Record<string, Record<string, string>>,
): Promise<void> {
  if (!providerConfigs || typeof providerConfigs !== 'object') return
  const patch: Record<string, unknown> = {}
  for (const [provider, values] of Object.entries(providerConfigs)) {
    const decl = ctx.llm.adapterConfig(provider)
    if (!decl || !values || typeof values !== 'object') continue
    for (const field of decl.fields) {
      // 键不存在 = 不改动；空串对 settings 字段表示「清空、回退适配器默认」。
      if (!(field.key in values)) continue
      const raw = values[field.key]
      if (typeof raw !== 'string') continue
      const value = raw.trim()
      if (field.store === 'credentials' || field.secret) {
        // secret 空串 = 留空不修改（与设置面板 placeholder 一致）
        if (value === '') continue
        writeSecret(field.credentialRef ?? `${provider}.${field.key}`, value, secretsFileOf(ctx))
      } else {
        // settings 字段带 provider 前缀落盘（如 opencode-go.baseUrl 形态，泛化为 <provider>.<key>）
        // 空串显式写入，settingsValue 视为空并回退默认端点。
        patch[`${provider}.${field.key}`] = value
      }
    }
  }
  if (Object.keys(patch).length > 0) writeDiverSettings(patch)
}