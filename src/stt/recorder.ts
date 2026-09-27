// 麦克风录音机（STT 底座）：getUserMedia + MediaRecorder，产出录音 Blob。
// 与转写引擎无关——引擎只消费 blob/mime（见 engine.ts 契约）。

export interface RecordingResult {
  blob: Blob;
  mime: string;
  durationMs: number;
}

export class MicRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelBuf: Uint8Array | null = null;
  private chunks: Blob[] = [];
  private mime = "";
  private startedAt = 0;

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }

  /** 请求麦克风并开始录音；权限/设备问题抛 Error（message 面向用户）。 */
  async start(): Promise<void> {
    if (this.recording) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      throw new Error(friendlyMicError(err));
    }
    const mime = pickMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    // 音量电平（UI 脉冲用）：stream → AnalyserNode，level() 由组件轮询。
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      this.audioCtx = ctx;
      this.analyser = analyser;
      this.levelBuf = new Uint8Array(analyser.frequencyBinCount);
    } catch {
      /* 分析器不可用不影响录音 */
    }
    this.stream = stream;
    this.recorder = recorder;
    this.mime = recorder.mimeType || mime || "audio/webm";
    this.startedAt = Date.now();
    recorder.start();
  }

  /** 停止并收集录音（未在录音返回 null）。 */
  stop(): Promise<RecordingResult | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") return Promise.resolve(null);
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mime });
        this.cleanup();
        resolve({
          blob,
          mime: blob.type || this.mime,
          durationMs: Date.now() - this.startedAt,
        });
      };
      recorder.stop();
    });
  }

  /** 取消录音并释放设备（不产出结果）。 */
  cancel(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.cleanup();
  }

  /** 当前输入电平 0..1（无分析器时 0）。 */
  level(): number {
    if (!this.analyser || !this.levelBuf) return 0;
    this.analyser.getByteFrequencyData(this.levelBuf);
    let sum = 0;
    for (const v of this.levelBuf) sum += v * v;
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) / 128);
  }

  private cleanup(): void {
    this.recorder = null;
    this.analyser = null;
    this.levelBuf = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    void this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
    this.chunks = [];
  }
}

function pickMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

function friendlyMicError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "麦克风权限被拒绝：请在系统设置的隐私权限中允许 Diver 使用麦克风";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "未检测到可用的麦克风设备";
  }
  if (name === "NotReadableError") {
    return "麦克风被其他应用占用";
  }
  return `麦克风启动失败：${name || String(err)}`;
}
