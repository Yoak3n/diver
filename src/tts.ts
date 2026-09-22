// 在线 TTS 朗读：壳层 Rust 合成 → WebView `<audio>` 播放（无本地 SAPI）。
//
// 队列策略：
// 1. 正在播放的句子播完，不因新句插入而打断
// 2. 播放期间若又来多句，待播位只保留【最后一条】，中间的直接跳过
// 3. stopSpeaking() / 前端停止按钮：中断当前 + 清空待播
//
// 双窗口：桌宠在线时只由桌宠播放（口型同窗口）；主窗口只发事件。

import {
  emitTauriEvent,
  isPetWindowOpen,
  onTauriEvent,
  synthesizeTts,
  tauriAvailable,
} from "./tauri";

export const TTS_SPEAK_REQUEST = "tts://speak-request";
export const TTS_SPEAK_ACK = "tts://speak-ack";
export const TTS_SPEAK_DONE = "tts://speak-done";
export const TTS_STOP = "tts://stop";

export interface TtsSpeakRequest {
  requestId: string;
  text: string;
  voice?: string;
  messageId?: string;
  /** true = 打断当前立即播（仅设置试听用）；默认 false 走「播完当前 + 只留最新」。 */
  force?: boolean;
}

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let generation = 0;
let draining = false;

type SpeakJob = {
  text: string;
  voice?: string;
  resolve: () => void;
  reject: (err: unknown) => void;
};
/** 待播位：只保留最新一条（latest-wins）。 */
let pendingJob: SpeakJob | null = null;
/** 当前播放 Promise 的 resolve（被 stop/force 打断时收尾）。 */
let playWaiter: (() => void) | null = null;

const spokenMarks = new Map<string, number>();
const SPOKEN_TTL_MS = 60_000;

// ---- 播放状态（给停止按钮显隐） ----
type SpeakingListener = (speaking: boolean) => void;
const speakingListeners = new Set<SpeakingListener>();
let speakingFlag = false;

function setSpeaking(v: boolean) {
  if (speakingFlag === v) return;
  speakingFlag = v;
  for (const fn of speakingListeners) {
    try {
      fn(v);
    } catch {
      /* ignore */
    }
  }
}

export function isTtsSpeaking(): boolean {
  return speakingFlag;
}

export function onTtsSpeakingChange(fn: SpeakingListener): () => void {
  speakingListeners.add(fn);
  fn(speakingFlag);
  return () => speakingListeners.delete(fn);
}

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
  // 唤醒等待中的 playOne，避免 stop 后 Promise 悬挂
  const w = playWaiter;
  playWaiter = null;
  w?.();
}

function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function claimSpeech(_messageId: string | undefined, text: string): boolean {
  const key = `text:${text.replace(/\s+/g, " ").trim().slice(0, 300)}`;
  const now = Date.now();
  for (const [k, t] of spokenMarks) {
    if (now - t > SPOKEN_TTL_MS) spokenMarks.delete(k);
  }
  const prev = spokenMarks.get(key);
  if (prev && now - prev < SPOKEN_TTL_MS) return false;
  spokenMarks.set(key, now);
  return true;
}

async function playOne(text: string, voice: string | undefined, gen: number): Promise<void> {
  stopCurrent();
  setSpeaking(true);
  try {
    const audio = await synthesizeTts(text, voice);
    if (gen !== generation) return;
    const blob = base64ToBlob(audio.base64, audio.mime);
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    currentAudio = el;
    currentUrl = url;
    ensureAnalyser(el);
    await new Promise<void>((resolve) => {
      playWaiter = resolve;
      const done = () => {
        el.onended = null;
        el.onerror = null;
        playWaiter = null;
        if (currentAudio === el) stopCurrent();
        resolve();
      };
      el.onended = done;
      el.onerror = done;
      el.play().catch(done);
    });
  } finally {
    if (!pendingJob) setSpeaking(false);
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pendingJob) {
      const job = pendingJob;
      pendingJob = null;
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
    setSpeaking(false);
  }
}

/**
 * 本窗口播放。
 * - 默认：不打断当前；待播位只留最新（中间句跳过）
 * - force：打断当前立即播（设置试听）
 */
export async function speakLocal(
  text: string,
  voice?: string,
  opts?: { force?: boolean },
): Promise<void> {
  if (!text.trim() || !tauriAvailable()) return;
  return new Promise<void>((resolve, reject) => {
    const job: SpeakJob = { text, voice, resolve, reject };

    if (opts?.force) {
      // 明确要求立即播：打断当前 + 丢掉待播
      if (pendingJob) {
        pendingJob.resolve();
        pendingJob = null;
      }
      generation++;
      stopCurrent();
      pendingJob = job;
      void drain();
      return;
    }

    // 默认策略：当前播完；若已有待播，被新的替换（中间句 resolve 掉 = 跳过）
    if (pendingJob) {
      pendingJob.resolve();
    }
    pendingJob = job;
    setSpeaking(true);
    void drain();
  });
}

function waitEventOnce<T>(
  event: string,
  match: (p: T) => boolean,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    let un: (() => void) | null = null;
    let settled = false;
    const finish = (v: T | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      un?.();
      resolve(v);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    void onTauriEvent<T>(event, (p) => {
      if (match(p)) finish(p);
    }).then((u) => {
      un = u;
    });
  });
}

/**
 * 朗读入口。
 * 桌宠在线 → 只交给桌宠播（口型）；否则本地播。
 */
export async function speakMessageText(
  text: string,
  voice?: string,
  messageId?: string,
  opts?: { force?: boolean },
): Promise<void> {
  if (!text.trim() || !tauriAvailable()) return;
  if (!opts?.force && !claimSpeech(messageId, text)) return;

  const petOpen = await isPetWindowOpen();
  if (!petOpen) {
    return speakLocal(text, voice, opts);
  }

  const requestId = `tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const req: TtsSpeakRequest = {
    requestId,
    text,
    voice,
    messageId,
    force: opts?.force,
  };
  const doneP = waitEventOnce<{ requestId: string }>(
    TTS_SPEAK_DONE,
    (p) => p?.requestId === requestId,
    120_000,
  );
  await emitTauriEvent(TTS_SPEAK_REQUEST, req);
  await doneP;
}

/** 停止朗读：中断当前 + 清空待播；并通知桌宠窗口。 */
export function stopSpeaking(): void {
  generation++;
  if (pendingJob) {
    pendingJob.resolve();
    pendingJob = null;
  }
  stopCurrent();
  setSpeaking(false);
  void emitTauriEvent(TTS_STOP, {});
}
