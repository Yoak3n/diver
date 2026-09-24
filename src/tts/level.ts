// 播放状态（停止按钮显隐）+ 响度电平（桌宠口型）。

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

export { setSpeaking };

// ---- 响度电平（桌宠口型） ----
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let srcNode: MediaElementAudioSourceNode | null = null;
let levelData: Uint8Array | null = null;
let lastLevel = 0;

export function bindLevelAnalyser(el: HTMLAudioElement) {
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

export function teardownLevelAnalyser() {
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

/** 流式 PCM 路径共用 analyser 节点（与 level 采样共用 getSpeechLevel）。 */
export function adoptAnalyser(next: AnalyserNode | null, data: Uint8Array | null) {
  analyser = next;
  levelData = data;
}

export function getSpeechLevel(): number {
  if (!analyser || !levelData || !isTtsPlayingRef()) {
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

/** 当前是否有 audio 元素在播（Blob 路径）。流式路径由 pcm 模块维护 paused 语义。 */
let playingAudio: HTMLAudioElement | null = null;

export function setPlayingAudio(el: HTMLAudioElement | null) {
  playingAudio = el;
}

function isTtsPlayingRef(): boolean {
  if (playingAudio) return !playingAudio.paused;
  return pcmPlaying;
}

/** 流式播放中标志（level 采样用）。 */
export let pcmPlaying = false;

export function setPcmPlaying(v: boolean) {
  pcmPlaying = v;
}

export function resetLevel() {
  lastLevel = 0;
}
