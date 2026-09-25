// @diver/llm-custom — 自定义模型提供商（OpenAI 兼容）适配器宿主插件。
//
// 「身份」注册表：$COS_HOME/custom-providers.json —— { providers: [{ id, name }] }，
// 由 backend /api/custom-providers 增删改。每个身份注册一个 OpenAI 兼容适配器；
// 配置值（baseUrl / models / apiKey）走通用 provider 配置通道，保存即热生效。
//
// 身份文件变更热重注册（轮询监听，Windows 上 fs.watch 不可靠）：
//   新增 → registerAdapter；删除 → dispose；改名 → dispose + 重注册（显示名跟随）。
// @module @diver/llm-custom

import { readFileSync, unwatchFile, watchFile } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'cordis'

import { OpenAICompatAdapter, apiKeyEnvOf, apiKeyRefOf } from './openai-compat.ts'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'llm-custom'

/** 本插件需要的框架服务：@cos/llm 注册表 + @cos/credentials 凭据层。 */
export const inject = ['llm', 'credentials']

/** 自定义提供商身份（与 backend custom-providers.ts 的落盘格式一致）。 */
export interface CustomProviderIdentity {
  id: string
  name: string
}

/** 身份注册表路径（通道收敛：状态在 COS_HOME）。 */
export function identitiesPath(): string {
  return join(process.env.COS_HOME ?? '', 'custom-providers.json')
}

/** 读取身份列表；文件缺失/损坏视为空（插件层不因用户数据问题挂掉 boot）。 */
function loadIdentities(): CustomProviderIdentity[] {
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

/** 插件激活：按身份注册适配器，监听身份文件热重注册。 */
export function apply(ctx: Context) {
  const registered = new Map<string, { name: string; dispose: () => void }>()

  const sync = () => {
    const wanted = loadIdentities()
    const wantedIds = new Set(wanted.map((w) => w.id))
    for (const [id, entry] of [...registered]) {
      if (wantedIds.has(id)) continue
      entry.dispose()
      registered.delete(id)
    }
    for (const identity of wanted) {
      const entry = registered.get(identity.id)
      if (entry !== undefined && entry.name === identity.name) continue
      // 新增或改名：旧注册让位（改名时显示名要跟随）。
      entry?.dispose()
      const ref = apiKeyRefOf(identity.id)
      // 凭据查找 key 必须与 backend 写入端同路径（writeSecret ref=custom.<id>.apiKey）。
      ctx.credentials.provide(
        ref,
        { key: ref, envKey: apiKeyEnvOf(identity.id) },
        { ref: `Custom provider "${identity.name}" API key (secrets file → ${ref}, or env ${apiKeyEnvOf(identity.id)})` },
      )
      const dispose = ctx.llm.registerAdapter(
        [identity.id],
        new OpenAICompatAdapter(identity.id, identity.name, ctx.credentials),
      )
      registered.set(identity.id, { name: identity.name, dispose })
    }
  }

  sync()
  // 2s 轮询足够「保存后热生效」的体感；比 fs.watch 在 Windows 上可靠。
  ctx.effect(() => {
    watchFile(identitiesPath(), { interval: 2000 }, () => {
      try {
        sync()
      } catch (error) {
        console.error('[llm-custom] 身份同步失败:', error)
      }
    })
    return () => {
      unwatchFile(identitiesPath())
      for (const entry of registered.values()) entry.dispose()
      registered.clear()
    }
  })
}
