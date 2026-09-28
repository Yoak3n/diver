// presence 相位 → 桌宠思考表现（thinking 进出驱动，按实例定向）。
//
// 表现三件套：① 视线钉定缓慢游移（思索张望）② 柔和表情 + 低频 Nod 微动作
// ③ 思考台词气泡（嘟囔，非正式回答）。语义真源是 L0 相位（thinking = 回合工作中），
// 不是消息流：壳在相位迁移时广播 `presence://phase`，本窗口按绑定实例过滤
// （经典宠跟随 active 标记）。事件是沿触发，窗口可能中途创建——启动补查一次快照。
//
// 铁律：只走 setLookPinned / setExpression / playEmotion / showBubble 现有通道，
// 不碰嘴参数；说话中 / 面板打开时气泡让位；动作播放在现有冷却节流下兜底。

import { onUnmounted } from "vue";

import { onTauriEvent } from "../../ipc/core";
import { getPresenceSnapshot } from "../../ipc/presence";
import type { PetEmotion } from "../emotion";
import { PRESENCE_PHASE_EVENT } from "../constants";

/** 思考嘟囔台词池（随机挑，别像背台词）。 */
const THOUGHT_LINES = [
  "唔……让我想想。",
  "嗯，等我琢磨琢磨。",
  "哦？这个有点意思。",
  "我在想……",
  "嗯……是这样吗？",
  "让我理一理。",
];

/** 思索游移的注视点（窗口宽高比例；偏上 = 抬眼想）。 */
const GAZE_SPOTS: Array<{ x: number; y: number }> = [
  { x: 0.22, y: 0.28 },
  { x: 0.5, y: 0.18 },
  { x: 0.78, y: 0.3 },
  { x: 0.34, y: 0.42 },
];

const GAZE_DRIFT_MS = 2600;
const NOD_INTERVAL_MS = 11000;
const MUTTER_INTERVAL_MS = 24000;

interface PhaseEvent {
  instance?: string;
  prev?: string;
  phase?: string;
  active?: boolean;
}

/** 思考表现所需的最小 pet 面（与 PetModelHandle 结构兼容）。 */
interface ThinkPet {
  setLookPinned: (target: { x: number; y: number } | null) => void;
  setExpression: (name?: string | null) => void;
  playEmotion: (group: string, opts?: { priority?: "normal" | "force" }) => void;
}

/** 装配面：PetApp 把既有 composable/reactive 整体传入，本模块只取所需成员。 */
interface ThinkingDeps {
  /** 本窗口绑定实例（instanceId null = 经典宠，跟随 active）。 */
  instance: { instanceId: { value: string | null } };
  pet: { getPet: () => ThinkPet | null };
  lip: { isSpeaking: () => boolean };
  panel: { panelOpen: boolean };
  bubble: { showBubble: (kind: "user" | "assistant" | "thinking", text: string, holdMs?: number) => void };
  /** 进思考 / 嘟囔时补一层柔和表情。 */
  emotion: { applyExpression: (emotion: PetEmotion, soft?: boolean) => void };
}

function pickOne<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function usePetThinking(deps: ThinkingDeps) {
  let thinking = false;
  let gazeTimer: number | null = null;
  let nodTimer: number | null = null;
  let mutterTimer: number | null = null;

  function driftGaze() {
    const pet = deps.pet.getPet();
    if (!pet) return;
    const spot = pickOne(GAZE_SPOTS);
    pet.setLookPinned({
      x: spot.x * window.innerWidth,
      y: spot.y * window.innerHeight,
    });
  }

  function mutter() {
    if (deps.lip.isSpeaking() || deps.panel.panelOpen) return;
    deps.emotion.applyExpression("neutral", true);
    deps.bubble.showBubble("thinking", pickOne(THOUGHT_LINES));
  }

  function enter() {
    if (thinking) return;
    thinking = true;
    driftGaze();
    gazeTimer = window.setInterval(driftGaze, GAZE_DRIFT_MS);
    nodTimer = window.setInterval(() => {
      const pet = deps.pet.getPet();
      if (pet && !deps.lip.isSpeaking()) pet.playEmotion("Nod", { priority: "normal" });
    }, NOD_INTERVAL_MS);
    mutter();
    mutterTimer = window.setInterval(mutter, MUTTER_INTERVAL_MS);
    console.log("[pet] thinking enter");
  }

  function exit() {
    if (!thinking) return;
    thinking = false;
    for (const t of [gazeTimer, nodTimer, mutterTimer]) {
      if (t !== null) window.clearInterval(t);
    }
    gazeTimer = null;
    nodTimer = null;
    mutterTimer = null;
    const pet = deps.pet.getPet();
    pet?.setLookPinned(null);
    pet?.setExpression(null);
    console.log("[pet] thinking exit");
  }

  function onPhase(p: PhaseEvent) {
    const me = deps.instance.instanceId.value;
    const mine = me === null ? p.active === true : p.instance === me;
    if (!mine) return;
    // 相位在工作串内恒定 thinking（FSM 工作电平语义：播报不迁相位、插话不离相位），
    // 按沿触发即可；离开 thinking 统一收表现。
    if (p.phase === "thinking") enter();
    else exit();
  }

  // 启动补种：思考中途开的窗错过沿触发，查一次快照对齐。
  void (async () => {
    const snap = await getPresenceSnapshot(deps.instance.instanceId.value);
    if (snap?.phase === "thinking") enter();
  })();

  let unlisten: (() => void) | null = null;
  void onTauriEvent<PhaseEvent>(PRESENCE_PHASE_EVENT, onPhase).then((u) => {
    unlisten = u;
  });

  onUnmounted(() => {
    unlisten?.();
    unlisten = null;
    exit();
  });

  return { isThinking: () => thinking };
}
