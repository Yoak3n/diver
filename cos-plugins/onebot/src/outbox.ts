// @diver/onebot — 出站发件箱：串行队列 + 间隔节流 + 连续失败熔断 + 语音/文本形态决策。
//
// QQ 风控优先于拟人化：同一实现侧连续发送易触发风控，所有 send_* 的实际出网
// 都经 SendQueue 串行执行；连续失败由 SendBreaker 熔断（账号级：群发与私聊共享，
// breaker 实例随 SendQueue 一对一）。settleMessage 决定出站形态：语音合成成功才
// 用语音，失败/未配置/超时绝不丢消息，降级发文本并告知原因。

import { SendBreaker, breakerErrorMessage } from './send-breaker.ts'
import { decideVoice, recordSegment, voiceKey, type VoicePolicy } from './voice.ts'

export interface VoiceSendDeps {
  policy: VoicePolicy
  /** 合成（文本已遮蔽；壳层 TTS 全局开关/凭据在 Rust 侧判定）。 */
  synth(text: string): Promise<{ base64: string }>
  cooldownOk(key: string, now: number): boolean
  noteUsed(key: string, now: number): void
}

/** 出站消息段（数组形态；text 段为字面文本，无需 CQ 转义）。 */
function buildMessage(text: string, quoteId?: number): Array<{ type: string; data: Record<string, unknown> }> {
  const segments: Array<{ type: string; data: Record<string, unknown> }> = []
  if (quoteId !== undefined) segments.push({ type: 'reply', data: { id: String(quoteId) } })
  segments.push({ type: 'text', data: { text } })
  return segments
}

/**
 * 出站形态决策：语音（合成成功才用）或文本。文本必须已遮蔽；语音合成的是
 * 同一段遮蔽后文本（无第二条内容通道）。voice 为 undefined 时恒走文本。
 */
export async function settleMessage(
  maskedText: string,
  requested: boolean | undefined,
  key: string,
  voice: VoiceSendDeps | undefined,
  quoteId?: number,
): Promise<{ segments: Array<{ type: string; data: Record<string, unknown> }>; voiceInfo?: Record<string, unknown> }> {
  if (voice === undefined) {
    return { segments: buildMessage(maskedText, quoteId) }
  }
  const now = Date.now()
  const decision = decideVoice({
    policy: voice.policy,
    requested,
    textLength: maskedText.length,
    cooldownOk: voice.cooldownOk(key, now),
    roll: Math.random(),
  })
  if (!decision.voice) {
    return {
      segments: buildMessage(maskedText, quoteId),
      voiceInfo: { voice: false, voiceSkip: decision.reason },
    }
  }
  try {
    const audio = await voice.synth(maskedText)
    voice.noteUsed(key, now)
    return { segments: [recordSegment(audio.base64)], voiceInfo: { voice: true } }
  } catch (error) {
    // 合成失败/未配置/超时：消息绝不丢，降级发文本并告知模型原因
    const reason = error instanceof Error ? error.message : String(error)
    return {
      segments: buildMessage(maskedText, quoteId),
      voiceInfo: { voice: false, voiceFallback: reason },
    }
  }
}

/** 串行发送队列（间隔节流 + 熔断记账）。 */
export class SendQueue {
  private chain: Promise<unknown> = Promise.resolve()
  private lastSendAt = 0
  private readonly breaker = new SendBreaker()

  constructor(private readonly intervalMs: number) {}

  /** 串行 + 最小间隔执行一次发送任务。 */
  run<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.intervalMs - (Date.now() - this.lastSendAt)
      if (this.lastSendAt > 0 && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      try {
        return await job()
      } finally {
        this.lastSendAt = Date.now()
      }
    })
    this.chain = run.catch(() => undefined)
    return run
  }

  /** 熔断检查：阻断时给出停止文案（本地短路，不打实现侧、不合成语音）。 */
  blockedJson(): { content: string } | undefined {
    if (!this.breaker.blocked(Date.now())) return undefined
    return { content: JSON.stringify({ error: breakerErrorMessage(this.breaker.failCount()) }) }
  }

  recordOk(): void {
    this.breaker.recordOk()
  }

  /** 发送失败回执：记录熔断并提示模型停止重试。 */
  failJson(error: unknown): { content: string; isError: true } {
    this.breaker.recordFail(Date.now())
    const message = error instanceof Error ? error.message : String(error)
    return {
      content: JSON.stringify({ error: message, hint: '发送失败；连续失败会暂停出话，不要在本回合反复重试。' }),
      isError: true,
    }
  }
}
