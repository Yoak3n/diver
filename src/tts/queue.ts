// 朗读队列（latest-wins）+ 本窗口播放 + 跨窗口朗读入口。

import {
  emitTauriEvent,
  getTtsConfig,
  isPetWindowOpen,
  onTauriEvent,
  synthesizeTts,
  tauriAvailable,
} from "../ipc";
import {
  bindLevelAnalyser,
  resetLevel,
  setPlayingAudio,
  setSpeaking,
  teardownLevelAnalyser,
} from "./level";
import { playPcmStream, resetPcmPlayback } from "./pcm";
import { claimSpeech } from "./spoken";
import {
  TTS_SPEAK_DONE,
  TTS_SPEAK_REQUEST,
  TTS_STOP,
  type TtsSpeakRequest,
} from "./types";

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

function isStale(gen: number): boolean {
  return gen !== generation;
}

function stopCurrent() {
  resetPcmPlayback();
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    try {
      currentAudio.pause();
    } catch {
      /* ignore */
    }
    currentAudio = null;
    setPlayingAudio(null);
  }
  teardownLevelAnalyser();
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  resetLevel();
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

async function playBlobOnce(text: string, voice: string | undefined, gen: number): Promise<void> {
  const audio = await synthesizeTts(text, voice);
  if (isStale(gen)) return;
  const blob = base64ToBlob(audio.base64, audio.mime);
  const url = URL.createObjectURL(blob);
  const el = new Audio(url);
  currentAudio = el;
  currentUrl = url;
  setPlayingAudio(el);
  bindLevelAnalyser(el);
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
}

async function playOne(text: string, voice: string | undefined, gen: number): Promise<void> {
  stopCurrent();
  resetPcmPlayback();
  setSpeaking(true);
  try {
    let useStream = false;
    try {
      const cfg = await getTtsConfig();
      useStream = cfg.provider === "mimo";
    } catch {
      useStream = false;
    }
    if (useStream) {
      try {
        await playPcmStream(text, voice, () => isStale(gen));
        return;
      } catch {
        /* 回退整段 */
      }
    }
    await playBlobOnce(text, voice, gen);
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
  opts?: { force?: boolean; userGesture?: boolean },
): Promise<void> {
  if (!text.trim() || !tauriAvailable()) return;
  if (!opts?.force && !opts?.userGesture && !claimSpeech(messageId, text)) return;

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
    force: !!opts?.force || !!opts?.userGesture,
    userGesture: !!opts?.userGesture,
  };
  const doneP = waitEventOnce<{ requestId: string }>(
    TTS_SPEAK_DONE,
    (p) => p?.requestId === requestId,
    120_000,
  );
  await emitTauriEvent(TTS_SPEAK_REQUEST, req);
  await doneP;
}

/**
 * 停止朗读：中断当前 + 清空待播。
 * `broadcast` 默认 true（主窗口点停止时通知桌宠）；
 * 桌宠收到 tts://stop 后必须传 false，否则会无限回环广播。
 */
export function stopSpeaking(opts?: { broadcast?: boolean }): void {
  generation++;
  if (pendingJob) {
    pendingJob.resolve();
    pendingJob = null;
  }
  stopCurrent();
  setSpeaking(false);
  if (opts?.broadcast !== false) {
    void emitTauriEvent(TTS_STOP, {});
  }
}

export { claimSpeech };
