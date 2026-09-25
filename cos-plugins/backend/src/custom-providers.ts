// @diver/backend — 自定义模型提供商（OpenAI 兼容）子系统。
//
// 「身份」注册表：$COS_HOME/custom-providers.json —— { providers: [{ id, name }] }。
// 配置值走通用 provider 配置通道（与 @diver/llm-custom 适配器读取端一致）：
//   - `<id>.baseUrl` / `<id>.models` → cos-settings（cos 契约文件，保存即热生效）
//   - `custom.<id>.apiKey`           → secrets 文件（ctx.credentials 解析）
// llm-custom 插件监听身份文件热重注册适配器：增删改 ≤2s 内出现在设置面板。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from 'cordis'

import { writeCosSettings } from './session-helpers.ts'
import { secretsFileOf, writeSecret } from './secrets.ts'

/** 自定义提供商身份（与 @diver/llm-custom 的落盘解析一致）。 */
export interface CustomProviderIdentity {
  id: string
  name: string
}

/** 增/改输入：name 必填，其余为配置值（空串语义见 applyConfig）。 */
export interface CustomProviderInput {
  name: string
  baseUrl?: string
  apiKey?: string
  models?: string
}

/** 身份注册表路径（通道收敛：状态在 COS_HOME）。 */
export function identitiesPath(): string {
  return join(process.env.COS_HOME ?? '', 'custom-providers.json')
}

/** 身份列表；文件缺失/损坏视为空。 */
export function listCustomProviders(): CustomProviderIdentity[] {
  try {
    const raw = JSON.parse(readFileSync(identitiesPath(), 'utf8')) as { providers?: unknown }
    const list = Array.isArray(raw.providers) ? raw.providers : []
    const seen = new Set<string>()
    const out: CustomProviderIdentity[] = []
    for (const item of list) {
      const id = String((item as { id?: unknown } | null)?.id ?? '')
      const name = String((item as { name?: unknown } | null)?.name ?? '')
      if (id === '' || name === '' || seen.has(id)) continue
      seen.add(id)
      out.push({ id, name })
    }
    return out
  } catch {
    return []
  }
}

/** 原子写身份表（tmp + rename，避免监听方读到半截）。 */
function writeIdentities(list: CustomProviderIdentity[]): void {
  const file = identitiesPath()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ providers: list }, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 新身份 id：`custom-` + 时间/随机 base36（无 unicode 约束，可作 settings 键）。 */
function newId(): string {
  return `custom-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`
}

/** 写入一个提供商的配置值：
 *  - settings（baseUrl/models）：空串 = 显式清空（适配器侧视为空并回退）
 *  - secret（apiKey）：空串 = 留空不修改 */
function applyConfig(ctx: Context, id: string, input: CustomProviderInput): void {
  const patch: Record<string, unknown> = {}
  if (input.baseUrl !== undefined) patch[`${id}.baseUrl`] = input.baseUrl.trim()
  if (input.models !== undefined) patch[`${id}.models`] = input.models.trim()
  if (Object.keys(patch).length > 0) writeCosSettings(patch)
  const key = (input.apiKey ?? '').trim()
  if (key !== '') {
    const ref = `custom.${id}.apiKey`
    writeSecret(ref, key, secretsFileOf(ctx))
    // credentials 服务有内存缓存：写盘后必须失效（同 applyProviderConfigs）。
    ctx.credentials.invalidate?.(ref)
  }
}

/** 新增：生成身份 + 写配置值。 */
export function addCustomProvider(ctx: Context, input: CustomProviderInput): CustomProviderIdentity {
  const name = input.name.trim()
  if (name === '') throw new Error('name 不能为空')
  const identity: CustomProviderIdentity = { id: newId(), name }
  writeIdentities([...listCustomProviders(), identity])
  applyConfig(ctx, identity.id, input)
  return identity
}

/** 修改：改名（留空不改）+ 按需更新配置值。 */
export function updateCustomProvider(
  ctx: Context,
  id: string,
  input: CustomProviderInput,
): CustomProviderIdentity | undefined {
  const list = listCustomProviders()
  const target = list.find((p) => p.id === id)
  if (target === undefined) return undefined
  const name = input.name.trim()
  if (name !== '') target.name = name
  writeIdentities(list)
  applyConfig(ctx, id, input)
  return target
}

/** 删除身份并清掉其 settings 配置（secret 留在 secrets 文件，不主动动用户密钥内容）。 */
export function removeCustomProvider(id: string): boolean {
  const list = listCustomProviders()
  const next = list.filter((p) => p.id !== id)
  if (next.length === list.length) return false
  writeIdentities(next)
  writeCosSettings({ [`${id}.baseUrl`]: '', [`${id}.models`]: '' })
  return true
}

/** 「拉取模型」：GET {baseUrl}/models（OpenAI 兼容目录接口）。 */
export async function probeProviderModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (base === '') throw new Error('baseUrl 不能为空')
  const response = await fetch(`${base}/models`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...(apiKey !== undefined && apiKey.trim() !== '' ? { authorization: `Bearer ${apiKey.trim()}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`端点返回 ${response.status}`)
  const body = (await response.json()) as { data?: Array<{ id?: unknown }> }
  return (body.data ?? [])
    .map((m) => (typeof m.id === 'string' ? m.id.trim() : ''))
    .filter((id) => id !== '')
}
