// @diver/llm-opencode — 模型目录：静态兜底 + 实时拉取（advisory）。

/**
 * 目录拉取失败时的兜底模型（chat/completions 可用的高频模型，advisory；
 * 仅 /responses 端点的模型如 grok-4.7 / gpt-6-luna 不列入）。
 */
export const FALLBACK_MODELS: readonly string[] = [
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.2',
  'kimi-k3',
  'kimi-k2.7-code',
  'qwen3.8-max',
  'qwen3.8-flash',
  'deepseek-v4-pro',
  'deepseek-v4.1-flash',
  'claude-haiku-5-5',
  'minimax-m3',
  'step-5-preview',
]

/** 解析 /v1/models 载荷（{data:[{id}]} 形态）；无有效 id 返回 null。纯函数可单测。 */
export function parseModelsPayload(body: unknown): readonly string[] | null {
  if (body === null || typeof body !== 'object') return null
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return null
  const ids = data
    .map((m) => (m === null || typeof m !== 'object' ? undefined : (m as { id?: unknown }).id))
    .filter((id): id is string => typeof id === 'string' && id !== '')
  return ids.length === 0 ? null : ids
}

/**
 * 实时拉取模型目录；任何失败返回 null（调用方静默退回静态目录——目录是
 * advisory，不打 warn 噪音）。apiKey best-effort：未配置也照拉（端点公开）。
 */
export async function fetchModelCatalog(
  url: string,
  timeoutMs: number,
  apiKey?: string,
): Promise<readonly string[] | null> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(apiKey !== undefined && apiKey !== '' ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    return parseModelsPayload(await response.json())
  } catch {
    return null
  }
}
