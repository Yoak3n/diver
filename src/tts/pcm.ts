// MiMo 流式 PCM 播放（24kHz PCM16LE）。

import { synthesizeTtsStream } from "../ipc/tts";
import { adoptAnalyser, setPcmPlaying } from "./level";

const PCM_RATE = 24000;
let pcmCtx: AudioContext | null = null;
let pcmAnalyser: AnalyserNode | null = null;
let pcmNextTime = 0;
let pcmActiveSources = 0;
let pcmWaiter: (() => void) | null = null;
let levelData: Uint8Array | null = null;

function ensurePcmGraph() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return false;
    if (!pcmCtx) {
      try {
        pcmCtx = new Ctx({ sampleRate: PCM_RATE });
      } catch {
        pcmCtx = new Ctx();
      }
    }
    if (pcmCtx.state === "suspended") void pcmCtx.resume();
    if (!pcmAnalyser) {
      pcmAnalyser = pcmCtx.createAnalyser();
      pcmAnalyser.fftSize = 256;
      pcmAnalyser.smoothingTimeConstant = 0.5;
      levelData = new Uint8Array(pcmAnalyser.frequencyBinCount);
      pcmAnalyser.connect(pcmCtx.destination);
    }
    return true;
  } catch {
    return false;
  }
}

function pcmBase64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = bin.charCodeAt(i * 2);
    const hi = bin.charCodeAt(i * 2 + 1);
    let s = (hi << 8) | lo;
    if (s >= 0x8000) s -= 0x10000;
    out[i] = s / 32768;
  }
  return out;
}

function enqueuePcm(b64: string) {
  if (!pcmCtx || !pcmAnalyser) return;
  const samples = pcmBase64ToFloat32(b64);
  if (samples.length === 0) return;
  const buf = pcmCtx.createBuffer(1, samples.length, PCM_RATE);
  buf.copyToChannel(samples, 0);
  const src = pcmCtx.createBufferSource();
  src.buffer = buf;
  src.connect(pcmAnalyser);
  const startAt = Math.max(pcmCtx.currentTime + 0.02, pcmNextTime);
  src.start(startAt);
  pcmNextTime = startAt + buf.duration;
  pcmActiveSources++;
  src.onended = () => {
    pcmActiveSources--;
    if (pcmActiveSources <= 0 && pcmWaiter) {
      const w = pcmWaiter;
      pcmWaiter = null;
      w();
    }
  };
}

export function resetPcmPlayback() {
  pcmNextTime = 0;
  pcmActiveSources = 0;
  setPcmPlaying(false);
  if (pcmWaiter) {
    const w = pcmWaiter;
    pcmWaiter = null;
    w();
  }
}

export async function playPcmStream(
  text: string,
  voice: string | undefined,
  isStale: () => boolean,
): Promise<void> {
  if (!ensurePcmGraph()) {
    throw new Error("AudioContext 不可用");
  }
  resetPcmPlayback();
  // 重绑定 getSpeechLevel 用的 analyser
  adoptAnalyser(pcmAnalyser, levelData);
  setPcmPlaying(true);
  let failed: string | null = null;
  await synthesizeTtsStream(text, voice, (chunk) => {
    if (isStale()) return;
    if (chunk.done) {
      if (pcmActiveSources <= 0 && pcmWaiter) {
        const w = pcmWaiter;
        pcmWaiter = null;
        w();
      }
      return;
    }
    try {
      enqueuePcm(chunk.base64);
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
  });
  if (isStale()) return;
  if (failed) throw new Error(failed);
  if (pcmActiveSources > 0 || pcmNextTime > (pcmCtx?.currentTime ?? 0)) {
    await new Promise<void>((resolve) => {
      pcmWaiter = resolve;
      window.setTimeout(() => {
        if (pcmWaiter === resolve) {
          pcmWaiter = null;
          resolve();
        }
      }, 120_000);
    });
  }
}
