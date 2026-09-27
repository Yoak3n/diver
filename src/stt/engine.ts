// 语音转写引擎契约（拍板 2026-09-27：先做底座，引擎后接）。
//
// 底座（src/stt/recorder.ts + ComposerBar 语音按钮）产出录音 Blob 后，
// 交给当前引擎转写。引擎位现为空（currentSttEngine() 返回 null），
// 接入路径（任选其一实现 SttEngine 后调 setSttEngine 注册）：
// - 本地 whisper：壳层 Rust 集成 whisper.cpp / Dev 使录音落盘再喂模型
// - 云 API：backend HTTP 端点或直连（注意 key 与隐私边界）

export interface SttTranscribeInput {
  /** 录音数据（MediaRecorder 产物，通常 webm/opus）。 */
  blob: Blob;
  /** 录音 MIME（引擎按需转码）。 */
  mime: string;
  durationMs: number;
}

export interface SttEngine {
  /** 引擎标识（如 "whisper-local" / "volcengine-stt"）。 */
  readonly id: string;
  readonly displayName: string;
  /** 转写录音为文本；失败抛 Error（message 面向用户）。 */
  transcribe(input: SttTranscribeInput): Promise<string>;
}

const registry: { engine: SttEngine | null } = { engine: null };

/** 注册/替换当前引擎（传 null = 摘除）。应用启动时由接线方调用一次。 */
export function setSttEngine(engine: SttEngine | null): void {
  registry.engine = engine;
}

/** 当前引擎；null = 尚未接入（底座就绪）。 */
export function currentSttEngine(): SttEngine | null {
  return registry.engine;
}
