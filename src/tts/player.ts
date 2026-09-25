// 后端播放队列事件 → 本窗口播放（PCM / 整段）+ 口型状态。
// 只有被 attach 的窗口会收到事件；pet 优先，main 兜底。
//
// 事件分两类：
// - 控制类（speaking / stopped / start）立即处理（打断必须零延迟）；
// - 播放类（pcm / audio / synthDone）走串行 pipeline，
//   保证「排程 → 真实播完 → tts_report_end」按序收尾，不与 begin/finish 竞态。

import { invoke, tauriAvailable } from "../ipc";
import { setSpeaking } from "./level";
import {
  beginPcmSession,
  enqueuePcmChunk,
  finishPcmSession,
  resetPcmPlayback,
} from "./pcm";

export type TtsPlayerEvent =
  | { type: "start"; requestId: string }
  | { type: "pcm"; requestId: string; base64: string }
  | { type: "audio"; requestId: string; base64: string; mime: string }
  | { type: "synthDone"; requestId: string }
  | { type: "stopped" }
  | { type: "speaking"; value: boolean };

type PlayerKind = "pet" | "main";

let activeRequestId: string | null = null;
let sawPcm = false;
let playGen = 0;
let pipeline: Promise<void> = Promise.resolve();
let audioEl: HTMLAudioElement | null = null;
let audioUrl: string | null = null;
let audioDone: (() => void) | null = null;
let detachFn: (() => void) | null = null;
let attachKind: PlayerKind | null = null;

function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function stopAudioEl() {
  if (audioDone) {
    const done = audioDone;
    audioDone = null;
    done();
  }
  if (audioEl) {
    audioEl.onended = null;
    audioEl.onerror = null;
    try {
      audioEl.pause();
    } catch {
      /* ignore */
    }
    audioEl = null;
  }
  if (audioUrl) {
    URL.revokeObjectURL(audioUrl);
    audioUrl = null;
  }
}

/** 整段 Blob 播放；stop/换句经 stopAudioEl 提前结束（不悬挂 pipeline）。 */
function playAudioBlob(base64: string, mime: string): Promise<void> {
  stopAudioEl();
  const url = URL.createObjectURL(base64ToBlob(base64, mime));
  const el = new Audio(url);
  audioEl = el;
  audioUrl = url;
  return new Promise<void>((resolve) => {
    const done = () => {
      if (audioDone === done) audioDone = null;
      el.onended = null;
      el.onerror = null;
      resolve();
    };
    audioDone = done;
    el.onended = done;
    el.onerror = done;
    el.play().catch(done);
  });
}

function reportEnd(requestId: string) {
  // 失败不能静默：report_end 丢了会让后端 wait_playback 干等 90s（嘴型空摆）。
  void invoke("tts_report_end", { requestId }).catch((e) => {
    console.warn("[tts] tts_report_end 失败:", e);
  });
}

/** 播放类事件串行化：step 先校验代数/请求归属，再做异步收尾。 */
function runPipeline(step: (gen: number) => Promise<void>) {
  const gen = playGen;
  pipeline = pipeline
    .then(() => step(gen))
    .catch((e) => {
      console.warn("[tts] 播放 pipeline 异常:", e);
    });
}

async function onPcmChunk(gen: number, requestId: string, base64: string) {
  if (gen !== playGen || requestId !== activeRequestId) return;
  if (!sawPcm) {
    sawPcm = true;
    try {
      await beginPcmSession();
    } catch (e) {
      console.warn("[tts] PCM 会话失败:", e);
      sawPcm = false;
      return;
    }
    if (gen !== playGen || requestId !== activeRequestId) return;
  }
  enqueuePcmChunk(base64);
}

async function onAudioBlob(gen: number, requestId: string, base64: string, mime: string) {
  if (gen !== playGen || requestId !== activeRequestId) return;
  await playAudioBlob(base64, mime);
}

async function onSynthDone(gen: number, requestId: string) {
  if (gen !== playGen || requestId !== activeRequestId) return;
  if (sawPcm) {
    await finishPcmSession();
  }
  if (gen !== playGen) return; // 已被打断：队列已换代，不再回报
  if (activeRequestId === requestId) activeRequestId = null;
  reportEnd(requestId);
}

function onPlayerEvent(ev: TtsPlayerEvent) {
  switch (ev.type) {
    case "speaking":
      setSpeaking(ev.value);
      return;
    case "stopped":
      playGen++;
      activeRequestId = null;
      sawPcm = false;
      resetPcmPlayback();
      stopAudioEl();
      setSpeaking(false);
      return;
    case "start":
      playGen++;
      activeRequestId = ev.requestId;
      sawPcm = false;
      resetPcmPlayback();
      stopAudioEl();
      setSpeaking(true);
      return;
    case "pcm":
      runPipeline((gen) => onPcmChunk(gen, ev.requestId, ev.base64));
      return;
    case "audio":
      runPipeline((gen) => onAudioBlob(gen, ev.requestId, ev.base64, ev.mime));
      return;
    case "synthDone":
      runPipeline((gen) => onSynthDone(gen, ev.requestId));
      return;
  }
}

/** 挂载播放器（pet 优先 / main 兜底）。返回 detach。 */
export async function attachTtsPlayer(kind: PlayerKind): Promise<() => void> {
  if (!tauriAvailable()) return () => {};
  // 同 kind 重复 attach 覆盖；换 kind 先卸旧的
  if (detachFn && attachKind !== kind) {
    detachFn();
    detachFn = null;
  }
  const { Channel } = await import("@tauri-apps/api/core");
  const ch = new Channel<TtsPlayerEvent>();
  ch.onmessage = (ev) => {
    onPlayerEvent(ev);
  };
  await invoke("tts_attach_player", { kind, onEvent: ch });
  attachKind = kind;
  const detach = () => {
    if (attachKind !== kind) return;
    playGen++;
    resetPcmPlayback();
    stopAudioEl();
    setSpeaking(false);
    attachKind = null;
    detachFn = null;
    void invoke("tts_detach_player", { kind }).catch(() => {});
  };
  detachFn = detach;
  return detach;
}
