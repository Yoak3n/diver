// @diver/llm-volcark — 模型目录：静态兜底 + 可选实时拉取（advisory）。

/**
 * 目录拉取失败时的兜底模型（advisory）。
 * 来源：方舟官方模型列表（文本生成 / Chat API）+ plan 端点控制台短名。
 * 官方 Model ID 用于标准 `/api/v3`；`/api/plan/v3` 也可用控制台短名（如 `deepseek-v4.1-flash`）。
 * 另可填推理接入点 `ep-…`。目录会过时，未列出的 id 不拦截。
 */
export const FALLBACK_MODELS: readonly string[] = [
  // 官方模型列表 · 推荐（文本生成）
  'doubao-seed-evolving',
  'doubao-seed-2-1-pro-260915',
  'doubao-seed-2-1-lite-260915',
  'doubao-seed-2-1-pro-260628',
  'doubao-seed-2-1-turbo-260628',
  // plan 端点控制台短名（与 /api/plan/v3 配套）
  'doubao-seed-2-1-turbo',
  'doubao-seed-2-0-lite',
  'doubao-seed-2-0-mini',
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'glm-5.3',
  'glm-5.3-flash',
  'kimi-k3',
  'kimi-k2.8-preview',
  'kimi-k2.7-code',
  'minimax-m3',
]

/**
 * 实时拉取 GET /models 目录；任何失败返回 null（调用方静默退回静态目录，
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
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const body = (await response.json()) as { data?: Array<{ id?: string }> }
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id !== '')
    return ids.length === 0 ? null : ids
  } catch {
    return null
  }
}
