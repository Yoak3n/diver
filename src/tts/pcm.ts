// MiMo 流式 PCM 会话播放（24kHz PCM16LE）——由后端队列推分片，本模块只负责出声。

import { adoptAnalyser, setPcmPlaying } from "./level";

const PCM_RATE = 24000;
let pcmCtx: AudioContext | null = null;
let pcmAnalyser: AnalyserNode | null = null;
let pcmNextTime = 0;
let pcmWaiter: (() => void) | null = null;
let levelData: Uint8Array | null = null;
let pcmGen = 0;
const liveSources = new Set<AudioBufferSourceNode>();

async function ensurePcmGraph() {
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
    if (pcmCtx.state === "suspended") {
      try {
        await pcmCtx.resume();
      } catch {
        /* ignore */
      }
    }
    if (pcmCtx.state !== "running") return false;
    if (!pcmAnalyser) {
      pcmAnalyser = pcmCtx.createAnalyser();
      pcmAnalyser.fftSize = 256;
      pcmAnalyser.smoothingTimeConstant = 0.5;
      levelData = new Uint8Array(pcmAnalyser.frequencyBinCount);
    }
    try {
      pcmAnalyser.disconnect();
    } catch {
      /* ignore */
    }
    pcmAnalyser.connect(pcmCtx.destination);
    return true;
  } catch {
    return false;
  }
}

/** PCM16LE base64 → Float32。 */
export function pcmBase64ToFloat32(b64: string): Float32Array {
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

function stopLiveSources() {
  for (const src of liveSources) {
    try {
      src.onended = null;
      src.stop();
    } catch {
      /* ignore */
    }
    try {
      src.disconnect();
    } catch {
      /* ignore */
    }
  }
  liveSources.clear();
}

export function resetPcmPlayback() {
  pcmGen++;
  pcmNextTime = 0;
  stopLiveSources();
  setPcmPlaying(false);
  if (pcmWaiter) {
    const w = pcmWaiter;
    pcmWaiter = null;
    w();
  }
}

/** 开始一句 PCM 流（会先 reset 旧会话）。 */
export async function beginPcmSession(): Promise<void> {
  resetPcmPlayback();
  if (!(await ensurePcmGraph())) {
    throw new Error("AudioContext 不可用或未运行");
  }
  adoptAnalyser(pcmAnalyser, levelData);
  setPcmPlaying(true);
}

/** 追加一包 PCM16LE base64。 */
export function enqueuePcmChunk(b64: string): void {
  if (!pcmCtx || !pcmAnalyser) return;
  const gen = pcmGen;
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
  liveSources.add(src);
  src.onended = () => {
    liveSources.delete(src);
    if (gen !== pcmGen) return;
    if (liveSources.size === 0 && pcmWaiter) {
      const w = pcmWaiter;
      pcmWaiter = null;
      w();
    }
  };
}

/** 合成结束，等待已排程 buffer 播完。 */
export async function finishPcmSession(): Promise<void> {
  const gen = pcmGen;
  if (liveSources.size === 0 && pcmNextTime <= (pcmCtx?.currentTime ?? 0)) {
    setPcmPlaying(false);
    return;
  }
  await new Promise<void>((resolve) => {
    pcmWaiter = () => {
      if (gen === pcmGen) setPcmPlaying(false);
      resolve();
    };
    window.setTimeout(() => {
      if (pcmWaiter) {
        const w = pcmWaiter;
        pcmWaiter = null;
        if (gen === pcmGen) setPcmPlaying(false);
        w();
      }
    }, 60_000);
  });
}
