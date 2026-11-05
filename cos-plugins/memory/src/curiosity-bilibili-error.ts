// @diver/memory — B 站接口错误与风控判定（纯逻辑）。

export class BilibiliError extends Error {
  readonly status: number
  readonly code: number
  readonly risk: boolean

  constructor(message: string, status: number, code: number) {
    super(message)
    this.name = 'BilibiliError'
    this.status = status
    this.code = code
    this.risk =
      status === 412 ||
      status === 429 ||
      code === -412 ||
      code === -352 ||
      code === -799 ||
      code === -509 ||
      code === -10403
  }
}

/** 标准信封里的业务码；缺失返回 -1。 */
export function envelopeCode(json: unknown): number {
  const code = (json as { code?: unknown } | null)?.code
  return typeof code === 'number' ? code : -1
}
