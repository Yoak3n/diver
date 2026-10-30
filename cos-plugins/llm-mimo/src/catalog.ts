// @diver/llm-mimo — 模型目录：静态兜底 + 实时拉取（advisory）。

/**
 * 目录拉取失败时的兜底模型（advisory）。
 * 来源：MiMo 官方 Models 页「Text Generation Model」表（V2.6 系列）。
 *  - v2.5-pro / v2.5 已于 2026-10-21 下线（系统自动路由到 v2.6 对应型号），不列入；
 *  - `mimo-v2.6-pro-ultraspeed` 是定制服务（需开通），等 /models 实拉到再显示。
 */
export const FALLBACK_MODELS: readonly string[] = ['mimo-v2.6-pro', 'mimo-v2.6-flash']

/**
 * 是否为对话 / 文本生成模型。
 *
 * MiMo 的 /v1/models 与 TTS/ASR 共用命名空间（`mimo-v2.5-tts`、
 * `mimo-v2.5-tts-voiceclone`、`mimo-v2.5-asr`…），不过滤会让设置面板的
 * 模型下拉混入音频模型。
 */
export function isChatModelId(id: string): boolean {
  const lowered = id.toLowerCase()
  if (lowered === '' || lowered.endsWith('-asr')) return false
  return !/(^|-)tts(-|$)/.test(lowered)
}

/** 解析 /v1/models 载荷（{data:[{id}]} 形态）并滤掉音频模型；无有效 id 返回 null。纯函数可单测。 */
export function parseModelsPayload(body: unknown): readonly string[] | null {
  if (body === null || typeof body !== 'object') return null
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return null
  const ids = data
    .map((m) => (m === null || typeof m !== 'object' ? undefined : (m as { id?: unknown }).id))
    .filter((id): id is string => typeof id === 'string' && isChatModelId(id))
  return ids.length === 0 ? null : ids
}

/**
 * 实时拉取 GET {baseUrl}/models；任何失败返回 null（调用方静默退回静态目录，
 * 不打 warn 噪音——目录是 advisory）。
 */
export async function fetchModelCatalog(
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<readonly string[] | null> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(apiKey === undefined || apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    return parseModelsPayload(await response.json())
  } catch {
    return null
  }
}
