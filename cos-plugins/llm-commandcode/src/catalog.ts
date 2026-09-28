// @diver/llm-commandcode — 模型目录：静态兜底 + 可选实时拉取（advisory）。

/** 目录拉取失败时的兜底模型（GOAT 套餐高频模型，advisory）。 */
export const FALLBACK_MODELS: readonly string[] = [
  'deepseek/deepseek-v4.1-flash',
  'deepseek/deepseek-v4-pro',
  'Qwen/Qwen3.8-Max',
  'Qwen/Qwen3.7-Plus',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'google/gemini-3.7-flash',
  'xai/grok-4.6',
  'zai-org/GLM-5.2',
]

/**
 * 实时拉取公开的 GET /models 目录；任何失败返回 null（调用方静默退回静态目录，
 * 不打 warn 噪音——默认关闭时根本不发请求，目录是 advisory）。
 */
export async function fetchModelCatalog(
  baseUrl: string,
  timeoutMs: number,
): Promise<readonly string[] | null> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { data?: Array<{ id?: string }> }
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && id !== '')
    return ids.length === 0 ? null : ids
  } catch {
    return null
  }
}
