// 动作 / 情绪动作播放（节流 + 优先级）+ 逻辑组别名解析。

import type { GroupAliases } from "./types";

type MotionModel = {
  internalModel: {
    motionManager?: {
      definitions?: unknown;
      on?: (ev: string, fn: () => void) => void;
      off?: (ev: string, fn: () => void) => void;
      state?: { currentPriority?: number };
    };
  };
  motion: (group: string, index?: number, priority?: number) => Promise<unknown>;
};

export function createMotionController(model: MotionModel, groupAliases: GroupAliases) {
  let emotionMotionActive = false;
  let lastEmotionEnd = 0;
  let emotionTimeout: number | null = null;
  let disposed = false;
  let speakingLock = false;

  const EMOTION_COOLDOWN_MS = 2200;
  const FORCE_GROUP_COOLDOWN_MS = 450;
  const lastGroupPlayAt = new Map<string, number>();

  function getMotionDefs(group: string): { group?: string }[] {
    const defs = (model.internalModel.motionManager as { definitions?: unknown })?.definitions as
      | { group?: string }[]
      | Record<string, { group?: string }[]>
      | undefined;
    if (!defs) return [];
    if (Array.isArray(defs)) {
      return defs.filter((d) => d?.group === group);
    }
    const list = (defs as Record<string, { group?: string }[]>)[group];
    return Array.isArray(list) ? list : [];
  }

  function groupExists(group: string): boolean {
    try {
      return getMotionDefs(group).length > 0;
    } catch {
      return false;
    }
  }

  function resolveGroup(logical: string): string | null {
    const candidates = groupAliases[logical]?.length
      ? groupAliases[logical]
      : [logical];
    for (const g of candidates) {
      if (groupExists(g)) return g;
    }
    const lower = logical.toLowerCase();
    if (lower !== logical && groupExists(lower)) return lower;
    return null;
  }

  function listGroups(): string[] {
    try {
      const defs = (model.internalModel.motionManager as { definitions?: unknown })?.definitions;
      if (!defs) return [];
      if (Array.isArray(defs)) {
        return [...new Set(defs.map((d: { group?: string }) => d?.group).filter(Boolean))] as string[];
      }
      return Object.keys(defs as object);
    } catch {
      return [];
    }
  }

  function hasActiveMotion(): boolean {
    try {
      const state = model.internalModel.motionManager?.state;
      return typeof state?.currentPriority === "number" && state.currentPriority > 1;
    } catch {
      return emotionMotionActive;
    }
  }

  function onMotionFinish() {
    emotionMotionActive = false;
    lastEmotionEnd = performance.now();
    if (emotionTimeout !== null) {
      window.clearTimeout(emotionTimeout);
      emotionTimeout = null;
    }
  }

  function armEmotionTimeout() {
    if (emotionTimeout !== null) window.clearTimeout(emotionTimeout);
    emotionTimeout = window.setTimeout(() => {
      emotionMotionActive = false;
      emotionTimeout = null;
    }, 6000);
  }

  try {
    model.internalModel.motionManager?.on?.("motionFinish", onMotionFinish);
  } catch {
    /* 事件系统不可用时仅靠定时器兜底 */
  }

  function playMotion(group = "TapBody") {
    const resolved = resolveGroup(group) ?? resolveGroup("TapBody") ?? resolveGroup("Idle");
    if (!resolved) {
      console.warn("[pet] playMotion: 无可用动作组", group, listGroups());
      return;
    }
    try {
      const groupDefs = getMotionDefs(resolved);
      if (groupDefs.length > 0) {
        const index = Math.floor(Math.random() * groupDefs.length);
        void model.motion(resolved, index).catch(() => {});
      } else {
        void model.motion(resolved).catch(() => {});
      }
    } catch (err) {
      console.warn("[pet] playMotion 失败", resolved, err);
    }
  }

  function playEmotion(group: string, opts?: { priority?: "normal" | "force" }) {
    if (disposed || !group) return;
    const force = opts?.priority === "force";
    const now = performance.now();

    if (!force && now - lastEmotionEnd < EMOTION_COOLDOWN_MS) return;
    if (!force && hasActiveMotion()) return;
    const resolved = resolveGroup(group);
    if (!resolved) {
      console.warn("[pet] playEmotion: 组不存在", group, "→", listGroups());
      return;
    }
    const lastGroup = lastGroupPlayAt.get(resolved) ?? 0;
    if (now - lastGroup < FORCE_GROUP_COOLDOWN_MS) {
      console.log("[pet] playEmotion 同类节流", resolved);
      return;
    }

    try {
      const groupDefs = getMotionDefs(resolved);
      let index: number | undefined;
      if (groupDefs.length > 0) {
        index = Math.floor(Math.random() * groupDefs.length);
      }
      const priority = force ? 3 : 2;
      emotionMotionActive = true;
      lastGroupPlayAt.set(resolved, now);
      armEmotionTimeout();
      console.log("[pet] playEmotion", group, "→", resolved, "idx", index, "force", force);
      void model.motion(resolved, index, priority).catch((err) => {
        console.warn("[pet] motion 播放失败", resolved, err);
      });
    } catch (err) {
      console.warn("[pet] playEmotion 异常", err);
      emotionMotionActive = false;
      if (emotionTimeout !== null) {
        window.clearTimeout(emotionTimeout);
        emotionTimeout = null;
      }
    }
  }

  /** Idle 随机小动作。 */
  let idleTimer: number | null = null;
  const IDLE_MIN_MS = 14000;
  const IDLE_JITTER_MS = 12000;

  function scheduleIdleMotion() {
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    const delay = IDLE_MIN_MS + Math.random() * IDLE_JITTER_MS;
    idleTimer = window.setTimeout(() => {
      idleTimer = null;
      if (disposed) return;
      if (!hasActiveMotion() && !emotionMotionActive && !speakingLock) {
        playMotion(resolveGroup("Idle") ?? resolveGroup("neutral") ?? "Idle");
      }
      scheduleIdleMotion();
    }, delay);
  }

  function setSpeakingLock(v: boolean) {
    speakingLock = v;
  }

  function destroy() {
    disposed = true;
    if (emotionTimeout !== null) {
      window.clearTimeout(emotionTimeout);
      emotionTimeout = null;
    }
    if (idleTimer !== null) {
      window.clearTimeout(idleTimer);
      idleTimer = null;
    }
    try {
      model.internalModel.motionManager?.off?.("motionFinish", onMotionFinish);
    } catch {
      /* 忽略 */
    }
  }

  return {
    playMotion,
    playEmotion,
    resolveGroup,
    listGroups,
    hasActiveMotion: () => hasActiveMotion() || emotionMotionActive,
    isEmotionActive: () => emotionMotionActive,
    scheduleIdleMotion,
    setSpeakingLock,
    destroy,
    getMotionDefs,
  };
}
