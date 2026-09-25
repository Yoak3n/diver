// 后端播放队列事件 → 本窗口播放（PCM / 整段）+ 口型状态。
// 只有被 attach 的窗口会收到事件；pet 优先，main 兜底。

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
let audioEl: HTMLAudioElement | null = null;
let audioUrl: string | null = null;
let detachFn: (() => void) | null = null;
let attachKind: PlayerKind | null = null;

function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function stopAudioEl() {
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

async function playAudioBlob(base64: string, mime: string): Promise<void> {
  stopAudioEl();
  const url = URL.createObjectURL(base64ToBlob(base64, mime));
  const el = new Audio(url);
  audioEl = el;
  audioUrl = url;
  await new Promise<void>((resolve) => {
    const done = () => {
      el.onended = null;
      el.onerror = null;
      resolve();
    };
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

async function onPlayerEvent(ev: TtsPlayerEvent) {
  switch (ev.type) {
    case "speaking":
      setSpeaking(ev.value);
      return;
    case "stopped":
      activeRequestId = null;
      sawPcm = false;
      resetPcmPlayback();
      stopAudioEl();
      setSpeaking(false);
      return;
    case "start":
      activeRequestId = ev.requestId;
      sawPcm = false;
      resetPcmPlayback();
      stopAudioEl();
      setSpeaking(true);
      return;
    case "pcm":
      if (ev.requestId !== activeRequestId) return;
      if (!sawPcm) {
        sawPcm = true;
        try {
          await beginPcmSession();
        } catch (e) {
          console.warn("[tts] PCM 会话失败:", e);
          sawPcm = false;
          return;
        }
      }
      enqueuePcmChunk(ev.base64);
      return;
    case "audio":
      if (ev.requestId !== activeRequestId) return;
      await playAudioBlob(ev.base64, ev.mime);
      return;
    case "synthDone": {
      if (ev.requestId !== activeRequestId) return;
      const rid = ev.requestId;
      if (sawPcm) {
        await finishPcmSession();
      }
      activeRequestId = null;
      reportEnd(rid);
      return;
    }
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
    void onPlayerEvent(ev);
  };
  await invoke("tts_attach_player", { kind, onEvent: ch });
  attachKind = kind;
  const detach = () => {
    if (attachKind !== kind) return;
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
