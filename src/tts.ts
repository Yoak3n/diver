// 在线 TTS 朗读：壳层 Rust 合成 → WebView `<audio>` 播放（无本地 SAPI）。
//
// 防重叠策略（短消息连发时尤其重要）：
// 1. 串行播放队列 —— 自动朗读按到达顺序一路接一路，绝不双开 Audio
// 2. 生成令牌 —— 合成是异步的，过期结果直接丢弃，避免旧句在新句之后诈尸
// 3. 消息认领 —— 主窗口 / 桌宠对同一句只读一次
// 4. 手动朗读 force —— 清空队列并打断当前，立即响应

import { synthesizeTts, tauriAvailable } from "./tauri";

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

/** 单调递增令牌：+1 表示「已换新任务」，在飞合成回来时若不匹配则丢弃。 */
let generation = 0;
/** 串行播放是否进行中。 */
let draining = false;
/** 待播队列（FIFO）。 */
type SpeakJob = {
  text: string;
  voice?: string;
  resolve: () => void;
  reject: (err: unknown) => void;
};
const queue: SpeakJob[] = [];

/** 已朗读过的消息：key → 时间戳（跨窗口弱去重）。 */
const spokenMarks = new Map<string, number>();
const SPOKEN_TTL_MS = 8000;

// ---- 响度电平（桌宠口型） ----
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let srcNode: MediaElementAudioSourceNode | null = null;
let levelData: Uint8Array | null = null;
let lastLevel = 0;

function ensureAnalyser(el: HTMLAudioElement) {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    srcNode = audioCtx.createMediaElementSource(el);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    levelData = new Uint8Array(analyser.frequencyBinCount);
    srcNode.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch {
    analyser = null;
    srcNode = null;
    levelData = null;
  }
}

function teardownAnalyser() {
  try {
    srcNode?.disconnect();
    analyser?.disconnect();
  } catch {
    /* ignore */
  }
  srcNode = null;
  analyser = null;
  levelData = null;
  lastLevel = 0;
}

/**
 * 当前 TTS 响度电平（0~1），供 Live2D 口型。
 * 未在播放时返回 0（调用方回退正弦）。
 */
export function getSpeechLevel(): number {
  if (!analyser || !levelData || !currentAudio || currentAudio.paused) {
    return (lastLevel = 0);
  }
  try {
    analyser.getByteTimeDomainData(levelData);
  } catch {
    return (lastLevel = 0);
  }
  let sum = 0;
  for (let i = 0; i < levelData.length; i++) {
    const v = (levelData[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / levelData.length);
  const level = Math.min(1, rms * 4);
  lastLevel = level > lastLevel ? level : lastLevel * 0.85 + level * 0.15;
  return lastLevel;
}

function stopCurrent() {
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    try {
      currentAudio.pause();
    } catch {
      /* ignore */
    }
    currentAudio = null;
  }
  teardownAnalyser();
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  lastLevel = 0;
}

function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** 消息认领：同一句 8s 内只自动朗读一次（主窗口 / 桌宠去重）。 */
export function claimSpeech(messageId: string | undefined, text: string): boolean {
  const key = messageId || `text:${text.trim().slice(0, 200)}`;
  const now = Date.now();
  for (const [k, t] of spokenMarks) {
    if (now - t > SPOKEN_TTL_MS) spokenMarks.delete(k);
  }
  const prev = spokenMarks.get(key);
  if (prev && now - prev < SPOKEN_TTL_MS) return false;
  spokenMarks.set(key, now);
  return true;
}

/** 合成 + 播放一句；`gen` 过期则丢弃结果（不播）。 */
async function playOne(text: string, voice: string | undefined, gen: number): Promise<void> {
  stopCurrent();
  const audio = await synthesizeTts(text, voice);
  if (gen !== generation) return; // 已被更新任务作废，禁止叠播/插队
  const blob = base64ToBlob(audio.base64, audio.mime);
  const url = URL.createObjectURL(blob);
  const el = new Audio(url);
  currentAudio = el;
  currentUrl = url;
  ensureAnalyser(el);
  await new Promise<void>((resolve) => {
    const done = () => {
      el.onended = null;
      el.onerror = null;
      if (currentAudio === el) stopCurrent();
      resolve();
    };
    el.onended = done;
    el.onerror = done;
    el.play().catch(done);
  });
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      const gen = ++generation;
      try {
        await playOne(job.text, job.voice, gen);
        job.resolve();
      } catch (err) {
        job.reject(err);
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * 朗读一段文本（在线 TTS）。
 *
 * 自动朗读进入串行队列，Promise 在**本句**播完时 resolve（不含后续排队句），
 * 便于桌宠口型只对齐本句。手动朗读（force）清空队列并立即打断。
 */
export async function speakMessageText(
  text: string,
  voice?: string,
  messageId?: string,
  opts?: { force?: boolean },
): Promise<void> {
  if (!text.trim() || !tauriAvailable()) return;
  if (!opts?.force && !claimSpeech(messageId, text)) return;

  return new Promise<void>((resolve, reject) => {
    if (opts?.force) {
      // 手动：丢掉排队中的自动句，作废在飞合成，立刻打断当前
      for (const j of queue.splice(0, queue.length)) {
        j.resolve(); // 被取消的自动句安静结束
      }
      generation++;
      stopCurrent();
    }
    queue.push({ text, voice, resolve, reject });
    void drain();
  });
}

/** 中断当前朗读并清空队列。 */
export function stopSpeaking(): void {
  generation++;
  for (const j of queue.splice(0, queue.length)) {
    j.resolve();
  }
  stopCurrent();
}
