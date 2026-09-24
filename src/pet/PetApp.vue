<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePetChat } from "./usePetChat";
import { inferEmotionDetail, loadEmotionMap } from "./emotion";
import type { PetEmotion } from "./emotion";
import { tauriAvailable, onTauriEvent, startPetMouseStream, movePetWindow, cancelPetMoveAnimation, setPetDragging } from "../tauri";
import {
  speakLocal,
  onTtsSpeakingChange,
  stopSpeaking,
  TTS_STOP,
  TTS_SPEAK_REQUEST,
  TTS_SPEAK_ACK,
  TTS_SPEAK_DONE,
  type TtsSpeakRequest,
} from "../tts";
import { emitTauriEvent } from "../tauri";
import { hasVisibleMessageBody, markdownToPlainText, renderMarkdownHtml } from "../markdown";
import {
  filesToAttachments,
  imageFilesFromClipboard,
  imageFilesFromDataTransfer,
} from "../imageAttach";
import { createPetInteractionTracker, DEFAULT_LONG_HOLD_MS } from "./interaction";
import type { PetInteractionTracker } from "./interaction";
import { MODEL_HEIGHT_RATIO, PET_MOUSE_MOVE_EVENT } from "./constants";
import type { PetModelHandle } from "./live2d";
import {
  loadModelCatalog,
  pickModelProfile,
  selectModelId,
  PET_MODEL_CHANGED_EVENT,
} from "./models";
import type { PetModelProfile } from "./models";
import PetModelPicker from "../components/PetModelPicker.vue";

const modelHost = ref<HTMLElement | null>(null);
const panelInput = ref<HTMLInputElement | null>(null);
const attachFileInput = ref<HTMLInputElement | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const runtimeErrors = ref<string[]>([]);
let pet: PetModelHandle | null = null;
let stopMouth: (() => void) | null = null;
let offTtsMouth: (() => void) | null = null;
let speaking = false;

// ---------- 模型切换（Hiyori / YUI…） ----------
const modelProfiles = ref<PetModelProfile[]>([]);
const activeModelId = ref<string>("");
/** 模型选择面板（独立页面式浮层，不再藏在二级菜单） */
const modelPickerOpen = ref(false);
const switchingModel = ref(false);

/** 用当前 profile 创建/重建 Live2D 句柄。 */
async function mountPetModel(profile: PetModelProfile) {
  if (!modelHost.value) {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }
  if (!modelHost.value) {
    throw new Error("模型容器未就绪（modelHost 为空）");
  }
  stopMouth?.();
  stopMouth = null;
  pet?.destroy();
  pet = null;
  const mod = await import("./live2d");
  pet = await mod.createPetModel(modelHost.value, {
    heightRatio: profile.heightRatio ?? MODEL_HEIGHT_RATIO,
    anchorXRatio: 0.5,
    modelUrl: profile.model3,
    groupAliases: profile.groupAliases,
  });
  activeModelId.value = profile.id;
  if (panelOpen.value) pet.setRetreat(true, bubbleSide.value);
  // 模型就绪后重算气泡位置（此前可能用的是回退角位）
  if (bubbleVisible.value) layoutSpeechBubble();
}

async function switchModel(id: string) {
  if (switchingModel.value || id === activeModelId.value) {
    modelPickerOpen.value = false;
    return;
  }
  const profile = modelProfiles.value.find((m) => m.id === id);
  if (!profile) return;
  switchingModel.value = true;
  modelPickerOpen.value = false;
  loadError.value = null;
  try {
    await mountPetModel(profile);
    selectModelId(profile.id);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[pet] switch model failed:", detail, err);
    loadError.value =
      detail +
      (profile.installHint ? `（可先执行 ${profile.installHint}）` : "");
  } finally {
    switchingModel.value = false;
    loading.value = false;
  }
}

function openModelPicker() {
  moreMenuOpen.value = false;
  modelPickerOpen.value = !modelPickerOpen.value;
}

/** 设置页/其他窗口改了模型：热切换到新形象。 */
async function onExternalModelChange(id: string) {
  if (!id || id === activeModelId.value || switchingModel.value) return;
  const profile = modelProfiles.value.find((m) => m.id === id);
  if (!profile) return;
  switchingModel.value = true;
  loadError.value = null;
  try {
    await mountPetModel(profile);
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    switchingModel.value = false;
    loading.value = false;
  }
}

// ---------- ⋯ 更多菜单（低频操作；跨屏拖动已恢复，无需「转到屏幕」） ----------
const moreMenuOpen = ref(false);

function toggleMoreMenu() {
  moreMenuOpen.value = !moreMenuOpen.value;
  if (moreMenuOpen.value) modelPickerOpen.value = false;
}

/** ⋯ 菜单里的"收起面板"：关闭面板 + 菜单。 */
function closePanelFromMenu() {
  moreMenuOpen.value = false;
  modelPickerOpen.value = false;
  panelOpen.value = false;
}

// 全局错误捕获（用于排查桌宠窗口渲染问题）
window.addEventListener("error", (e) => {
  const msg = `[error] ${e.message}`;
  console.error(msg);
  runtimeErrors.value.push(msg);
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = `[rejection] ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`;
  console.error(msg);
  runtimeErrors.value.push(msg);
});

const {
  messages,
  busy,
  connected,
  composer,
  attachments,
  isReady,
  canSend,
  addAttachments,
  removeAttachment,
  connect,
  send,
  startAutoRefresh,
  ttsEnabled,
  ttsVoice,
  pendingQuestion,
  submitQuestionAnswer,
} = usePetChat();

/** 面板可见消息：滤掉无正文无图的空白步骤（工具/思考占位）。 */
const visibleMessages = computed(() => messages.value.filter(hasVisibleMessageBody));

const panelDragOver = ref(false);

async function onAddAttachFiles(files: File[]) {
  const items = await filesToAttachments(files);
  if (items.length) addAttachments(items);
}

function pickAttachImages() {
  attachFileInput.value?.click();
}

function onAttachFileInput(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length) void onAddAttachFiles(files);
}

function onPanelPaste(e: ClipboardEvent) {
  const files = imageFilesFromClipboard(e);
  if (files.length) {
    e.preventDefault();
    void onAddAttachFiles(files);
  }
}

function onPanelDragOver(e: DragEvent) {
  if (e.dataTransfer?.types.includes("Files")) {
    e.preventDefault();
    panelDragOver.value = true;
  }
}

function onPanelDrop(e: DragEvent) {
  panelDragOver.value = false;
  const files = imageFilesFromDataTransfer(e.dataTransfer);
  if (files.length) {
    e.preventDefault();
    void onAddAttachFiles(files);
  }
}

/** 桌宠侧提问的临时选择状态（单选：label；多选：数组）。 */
const qSelections = ref<Record<string, string[]>>({});
const qCustoms = ref<Record<string, string>>({});

function toggleQOption(qId: string, label: string, multiSelect?: boolean) {
  const cur = qSelections.value[qId] ?? [];
  qSelections.value[qId] = multiSelect
    ? cur.includes(label)
      ? cur.filter((l) => l !== label)
      : [...cur, label]
    : [label];
}

function answerPending() {
  const q = pendingQuestion.value;
  if (!q) return;
  const answers = q.questions.map((item) => {
    const a: { id: string; selected: string[]; custom?: string } = {
      id: item.id,
      selected: qSelections.value[item.id] ?? [],
    };
    const custom = (qCustoms.value[item.id] ?? "").trim();
    if (custom) a.custom = custom;
    return a;
  });
  void submitQuestionAnswer(answers);
}

/** 布局：模型全屏 + 消息流悬浮面板 */
// 模型占满窗口（居中），消息流面板悬浮在窗口一侧。
// 面板在屏幕中心一侧（bubbleSide）：窗口在屏幕左半 → 面板在右；右半 → 面板在左。
// 面板打开时模型缩小让位（setRetreat），避免遮挡；关闭时恢复。
/** 面板相对模型的位置：'right' = 面板在右（窗口在屏幕左半时），'left' = 面板在左。 */
const bubbleSide = ref<"left" | "right">("right");

/** 依据窗口在屏幕中的位置决定面板浮在哪一侧（朝屏幕中心）。
 *  注：窗口本身已被 Rust 侧限位在屏幕内（多屏按当前显示器工作区），
 *  因此窗口不会出屏，面板/模型也不会因窗口贴边而被挤出屏幕。 */
async function updateBubbleSide() {
  try {
    let winLeft = 0;
    let winWidth = window.innerWidth;
    if (tauriAvailable()) {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const [pos, size] = await Promise.all([
        getCurrentWindow().outerPosition(),
        getCurrentWindow().outerSize(),
      ]);
      winLeft = pos.x;
      winWidth = size.width;
    } else {
      winLeft = window.screenX || 0;
      winWidth = window.outerWidth || winWidth;
    }
    const screenLeft = (window.screen as unknown as { availLeft?: number }).availLeft ?? 0;
    const screenWidth = window.screen.availWidth || 1920;
    const winCenter = winLeft + winWidth / 2;
    const screenCenter = screenLeft + screenWidth / 2;
    // 窗口中心在屏幕中心左侧 → 面板浮在右（朝屏幕中心）；右侧 → 面板在左
    const next = winCenter < screenCenter ? "right" : "left";
    if (next !== bubbleSide.value) {
      bubbleSide.value = next;
      // 面板开着时换边：立即让模型重新让位到新面板对侧（避免面板遮住模型）
      if (panelOpen.value) {
        pet?.setRetreat(true, next);
      }
    }
    // 侧边/窗口位置变化后重算气泡贴头位置
    if (bubbleVisible.value) layoutSpeechBubble();
  } catch {
    // 检测失败时默认面板在右
    bubbleSide.value = "right";
    if (bubbleVisible.value) layoutSpeechBubble();
  }
}

// ---------- 头顶对话气泡：自然浮现/淡出，始终位于气泡区 ----------
const panelOpen = ref(false);
const bubbleText = ref("");
const bubbleKind = ref<"user" | "assistant">("assistant");
const bubbleVisible = ref(false);
const bubbleStreaming = ref(false);
/** 消息流容器（面板内滚动区），新消息到达时自动滚到底部。 */
const chatMessagesRef = ref<HTMLElement | null>(null);
let bubbleTimer: number | null = null;
let bubbleSideTimer: number | null = null;

/** 按内容长度估算气泡停留时长（短句 3s，长文本上限 12s）。 */
function bubbleDuration(text: string): number {
  const chars = text.replace(/\s/g, "").length;
  return Math.min(Math.max(3000, chars * 120), 12000);
}

function showBubble(kind: "user" | "assistant", text: string, holdMs?: number) {
  if (bubbleTimer !== null) window.clearTimeout(bubbleTimer);
  const plain = markdownToPlainText(text);
  bubbleKind.value = kind;
  bubbleText.value = plain;
  bubbleVisible.value = true;
  bubbleStreaming.value = false;
  scheduleBubbleDismiss(holdMs ?? bubbleDuration(plain));
  void nextTick(() => {
    layoutSpeechBubble();
    // 气泡就位后立刻按当前鼠标位置重算穿透，避免指着气泡却点不着
    if (lastMouseScreen) void applyClickthroughAt(lastMouseScreen.x, lastMouseScreen.y);
  });
}

function scheduleBubbleDismiss(ms: number) {
  if (bubbleTimer !== null) window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => {
    bubbleTimer = null;
    if (bubbleHovering) return; // 悬停中不自动消失，leave 时再补
    bubbleVisible.value = false;
    bubbleStreaming.value = false;
  }, ms);
}

function hideBubbleNow() {
  if (bubbleTimer !== null) window.clearTimeout(bubbleTimer);
  bubbleTimer = null;
  bubbleVisible.value = false;
  bubbleStreaming.value = false;
  bubbleHovering = false;
  void nextTick(() => {
    if (lastMouseScreen) void applyClickthroughAt(lastMouseScreen.x, lastMouseScreen.y);
  });
}

// ---------- 默认态气泡：贴角色头顶 + 交互 ----------
/** 气泡定位（pet-root 绝对坐标）。null = 回退到 bubble-area 角上 */
const bubblePos = ref<{ left: number; top: number } | null>(null);
/** 悬停中：暂停自动消失 */
let bubbleHovering = false;

/**
 * 默认态气泡：锚在窗口左上角（不跟角色头顶漂）。
 * 面板打开时气泡不显示，无需再算。
 */
function layoutSpeechBubble() {
  bubblePos.value = { left: 12, top: 12 };
}

/** 悬停：暂停自动消失，避免长文还没读完就淡出 */
function onBubbleEnter() {
  bubbleHovering = true;
  if (bubbleTimer !== null) {
    window.clearTimeout(bubbleTimer);
    bubbleTimer = null;
  }
}

function onBubbleLeave() {
  bubbleHovering = false;
  if (bubbleVisible.value && !bubbleStreaming.value && bubbleTimer === null) {
    scheduleBubbleDismiss(1600);
  }
}

// 监听消息流：用户消息立刻浮现；助手消息流式跟随，完成后停留再淡出。
watch(
  () => messages.value,
  (list) => {
    // 面板打开时：消息流自动滚到底部（跟随最新消息）
    if (panelOpen.value) {
      void nextTick(() => scrollChatToBottom());
    }
    const last = list[list.length - 1];
    if (!last) return;
    // 历史加载（重启恢复）不是"到达"的消息：不弹气泡、不朗读、不触发动作。
    if (last.fromHistory) return;
    // 面板打开时不再弹短暂气泡（消息已在消息流中展示），但情绪动作照常触发
    if (last.kind === "user") {
      if (!panelOpen.value) onUserMessage(last.content);
      else reactToText(last.content);
    } else if (last.kind === "assistant") {
      if (last.streaming) {
        // 流式输出中：持续跟随显示，不启动停留计时
        if (bubbleTimer !== null) window.clearTimeout(bubbleTimer);
        bubbleTimer = null;
        bubbleKind.value = "assistant";
        bubbleText.value = markdownToPlainText(last.content);
        bubbleVisible.value = true;
        bubbleStreaming.value = true;
        layoutSpeechBubble();
        // 流式过程中也做表情/情绪响应（内部有节流）——等说完再动会显得很迟钝
        if (last.content.length >= 4) reactToText(last.content);
      } else if (last.content) {
        // 完成：停留后淡出（面板打开时不弹气泡）
        if (!panelOpen.value) showBubble("assistant", last.content);
        // 朗读 + 情绪动作（面板开合不影响）
        onAssistantDone(last.content);
      }
    }
  },
  { deep: true },
);

// ---------- 交互模型：长按拖动 / 点按互动 / 右键呼出交互面板 ----------
// 跨窗口/跨屏拖动（对齐 DSH）：系统 startDragging 负责移动窗口；
// Rust 的 Moved 事件**只落盘、不 set_position**，避免与原生拖动抢位置导致
// 跨屏闪动。拖动结束后再调用 move_pet_window(0,0) 做软限位（最近显示器）。
const LONG_PRESS_MS = 350;
/** 蓄力环延迟显示：短按（点按互动）不应闪出「按住拖动」 */
const CHARGE_UI_DELAY_MS = 150;
/** 拖动状态：idle=默认 / arming=长按蓄力中（尚不可拖） / dragging=已可拖动 */
const dragState = ref<"idle" | "arming" | "dragging">("idle");
/** 蓄力指示器锚点（视口坐标，跟随按下的位置） */
const chargePos = ref({ x: 0, y: 0 });
/** 蓄力环是否已显示（延迟后才 true，避免点按闪 UI） */
const chargeUiVisible = ref(false);
/** 蓄力起始点：用于判定「按住未移动」；移动过大则取消蓄力 */
let chargeOrigin: { x: number; y: number } | null = null;
/** 取消「长按拖动」的漂移（px）：略动就不进拖动，但**仍可算点按** */
const CHARGE_MOVE_TOLERANCE = 12;
/** 取消「点按互动」的漂移（px）：只有明显拖拽才吞掉点击反应 */
const CLICK_MOVE_TOLERANCE = 28;
let pressTimer: number | null = null;
let chargeUiTimer: number | null = null;
let longPressDragging = false;
/** 拖动会话：beginDrag 后置 true；Moved 停歇才做软限位 */
let petDragSession = false;
/** 拖动结束软限位定时器（Moved 防抖） */
let dragIdleTimer: number | null = null;
let unlistenPetMoved: (() => void) | null = null;
/** 互动事件识别（切屏 / 长拖）→ invoke 壳 pet_gesture_event（Presence 裁决 + inject）。 */
const interactionTracker: PetInteractionTracker = createPetInteractionTracker();

function clearPressTimer() {
  if (pressTimer !== null) {
    window.clearTimeout(pressTimer);
    pressTimer = null;
  }
}

function clearChargeUiTimer() {
  if (chargeUiTimer !== null) {
    window.clearTimeout(chargeUiTimer);
    chargeUiTimer = null;
  }
  chargeUiVisible.value = false;
}

function clearDragIdleTimer() {
  if (dragIdleTimer !== null) {
    window.clearTimeout(dragIdleTimer);
    dragIdleTimer = null;
  }
}

/**
 * 拖动结束判定（对齐 DSH use-window-draggable）：
 *
 * - Windows 上 startDragging 期间 **鼠标仍按住时 Moved 就会持续触发**，
 *   这不是「误触发」，而是系统拖动仍在进行的信号。
 * - 不能用很短的停歇（如 350ms）就当拖动结束：用户在拖动中停顿一下
 *   （仍按住）会被误判，随后 move_pet_window 又与系统抢坐标。
 * - webview 收不到 pointerup，只能以「Moved 停歇」为准；停歇阈值取
 *   会话级超时（约 1.5s），与 DSH DRAG_SESSION_TIMEOUT 同量级。
 */
const DRAG_IDLE_MS = 1500;
/** 长按后始终没有 Moved（未真正拖动）时的会话超时 */
const DRAG_SESSION_MS = 1500;

function endDragVisualState() {
  interactionTracker.endDragSession();
  petDragSession = false;
  longPressDragging = false;
  if (dragState.value !== "idle") {
    dragState.value = "idle";
  }
}

function armDragIdleRecovery() {
  clearDragIdleTimer();
  dragIdleTimer = window.setTimeout(() => {
    dragIdleTimer = null;
    // 先关「拖动会话」，再归位：否则 Rust 会因仍在拖动而跳过过渡动画
    endDragVisualState();
    void setPetDragging(false);
    void movePetWindow(0, 0);
    void updateBubbleSide();
  }, DRAG_IDLE_MS);
}

/** beginDrag 后的兜底：长时间无 Moved 则退出拖动态（指针恢复 default）。 */
function armDragSessionTimeout() {
  clearDragIdleTimer();
  dragIdleTimer = window.setTimeout(() => {
    dragIdleTimer = null;
    endDragVisualState();
    void setPetDragging(false);
    void updateBubbleSide();
  }, DRAG_SESSION_MS);
}

/** 是否点击在面板/气泡区域内（这些区域不参与长按拖动与点按互动）。 */
function inPanelArea(target: EventTarget | null): boolean {
  return !!(target instanceof HTMLElement && target.closest(".chat-flow, .speech-bubble, .question-card, .model-picker-panel"));
}

async function beginDrag() {
  if (!tauriAvailable()) return;
  try {
    cancelPetMoveAnimation();
    // 打开 Rust 侧拖动会话：期间禁止归位动画/瞬时 set_position
    void setPetDragging(true);
    clearDragIdleTimer();
    petDragSession = true;
    longPressDragging = true;
    dragState.value = "dragging";
    interactionTracker.beginDragSession();
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startDragging();
    armDragSessionTimeout();
  } catch {
    endDragVisualState();
    void setPetDragging(false);
    clearDragIdleTimer();
  }
}

/** 监听桌宠窗口 Moved：拖动会话中用于防抖结束判定。 */
async function bindPetMovedListener() {
  if (!tauriAvailable() || unlistenPetMoved) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const unlisten = await getCurrentWindow().onMoved((pos) => {
      // Moved 在「鼠标仍按住的系统拖动」中就会触发 —— 说明拖动仍在进行，
      // 保持 grabbing，并重置「停歇超时」；不要在这里做 set_position。
      if (!petDragSession && !longPressDragging) return;
      petDragSession = true;
      if (dragState.value !== "dragging") {
        dragState.value = "dragging";
      }
      // 跨屏语义事件（同一拖动会话只报一次）；pos 为窗口物理坐标
      const p = pos as unknown as { x?: number; y?: number } | undefined;
      if (p && typeof p.x === "number" && typeof p.y === "number") {
        interactionTracker.noteMoved(p.x + 40, p.y + 40);
      } else {
        void getCurrentWindow()
          .outerPosition()
          .then((wp) => interactionTracker.noteMoved(wp.x + 40, wp.y + 40))
          .catch(() => {});
      }
      armDragIdleRecovery();
    });
    unlistenPetMoved = unlisten;
  } catch {
    /* 忽略 */
  }
}

/** 短按是否还算「点击」（未明显拖拽、未进入系统拖动）。 */
let clickCandidate = false;
/** 明显拖拽 / 系统拖动后，松手不再触发点按互动 */
let suppressClickReaction = false;

function resetPointerSession() {
  clearPressTimer();
  clearChargeUiTimer();
  chargeOrigin = null;
  clickCandidate = false;
  if (dragState.value === "arming") dragState.value = "idle";
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return; // 仅左键；右键走 contextmenu
  if (inPanelArea(e.target)) return;
  longPressDragging = false;
  suppressClickReaction = false;
  clickCandidate = true;
  chargeOrigin = { x: e.clientX, y: e.clientY };
  chargePos.value = { x: e.clientX, y: e.clientY };
  // 不立刻亮「按住拖动」——短按是点按互动，不是拖动
  dragState.value = "arming";
  clearChargeUiTimer();
  chargeUiTimer = window.setTimeout(() => {
    chargeUiTimer = null;
    if (dragState.value === "arming" && chargeOrigin && clickCandidate) {
      chargeUiVisible.value = true;
    }
  }, CHARGE_UI_DELAY_MS);
  clearPressTimer();
  // 长按超过阈值 → 进入窗口拖动
  pressTimer = window.setTimeout(() => {
    pressTimer = null;
    if (!clickCandidate) return;
    longPressDragging = true;
    suppressClickReaction = true;
    chargeOrigin = null;
    chargeUiVisible.value = false;
    dragState.value = "dragging";
    void beginDrag();
  }, LONG_PRESS_MS);
}

/**
 * 移动判定（分级）：
 * - >12px：取消「长按拖动」（略动就别进系统拖动）
 * - >28px：才算明显拖拽，松手不触发点按
 * 小幅抖动不应吞掉 点脸/点身子 反应。
 */
function onPointerMove(e: PointerEvent) {
  if (dragState.value !== "arming" || !chargeOrigin) return;
  const dx = e.clientX - chargeOrigin.x;
  const dy = e.clientY - chargeOrigin.y;
  const dist2 = dx * dx + dy * dy;
  if (dist2 > CLICK_MOVE_TOLERANCE * CLICK_MOVE_TOLERANCE) {
    // 明显拖拽：取消长按 + 不触发点按
    clearPressTimer();
    clearChargeUiTimer();
    chargeOrigin = null;
    clickCandidate = false;
    suppressClickReaction = true;
    dragState.value = "idle";
    return;
  }
  if (dist2 > CHARGE_MOVE_TOLERANCE * CHARGE_MOVE_TOLERANCE) {
    // 轻微移动：取消长按拖动，但保留点按
    clearPressTimer();
    clearChargeUiTimer();
    chargeOrigin = null;
    clickCandidate = true;
    dragState.value = "idle";
  }
}

/** 同一分区点击冷却（ms）：连点脸/连点身不重复播；换区立即响应。 */
const CLICK_ZONE_COOLDOWN_MS = 550;
const lastClickReactAt: Record<"head" | "body", number> = { head: 0, body: 0 };

function onPointerUp(e: PointerEvent) {
  clearPressTimer();
  clearChargeUiTimer();
  chargeOrigin = null;
  const wasLongDrag = longPressDragging;
  longPressDragging = false;
  dragState.value = "idle";
  if (wasLongDrag) {
    clickCandidate = false;
    return;
  }
  // 短按松手 → 点脸 / 点身子 分区反应（同类节流）
  if (!suppressClickReaction && clickCandidate && e.button === 0 && !inPanelArea(e.target) && pet) {
    const zone = hitZoneAt(e.clientX, e.clientY);
    const now = performance.now();
    const last = lastClickReactAt[zone] || 0;
    if (now - last < CLICK_ZONE_COOLDOWN_MS) {
      clickCandidate = false;
      suppressClickReaction = false;
      return;
    }
    lastClickReactAt[zone] = now;
    console.log("[pet] click zone =", zone);
    pet.react("neutral", { force: true, zone });
  }
  clickCandidate = false;
  suppressClickReaction = false;
}

/** 点击分区：命中框上 35% 视为头部（害羞/惊讶），其余身体（TapBody）。 */
function hitZoneAt(_clientX: number, clientY: number): "head" | "body" {
  const box = pet?.getHitbox();
  if (!box) return "body";
  const relY = (clientY - box.top) / Math.max(1, box.height);
  return relY <= 0.35 ? "head" : "body";
}

function onPointerCancel() {
  resetPointerSession();
  clickCandidate = false;
  suppressClickReaction = true;
  longPressDragging = false;
  dragState.value = "idle";
}

/** 呼出消息面板（右键 / 点击气泡共用）。 */
function openPanel() {
  // 呼出前先按最新窗口位置刷新面板方向（防止窗口贴屏幕边缘时
  // 让位方向把模型挤出屏幕外）
  void updateBubbleSide().then(() => {
    // 先开面板接管让位，再清气泡——避免中间态把模型弹回又拉走
    panelOpen.value = true;
    hideBubbleNow();
    void nextTick(() => {
      scrollChatToBottom();
      panelInput.value?.focus();
      void focusWindow();
    });
  });
}

/** 收起消息面板。 */
function closePanel() {
  panelOpen.value = false;
}

/** 右键：呼出/收起交互面板（输入框常态隐藏）。 */
function onContextMenu(e: MouseEvent) {
  if (e.target instanceof HTMLElement && e.target.closest(".chat-flow")) {
    return; // 面板内保留原生菜单（如粘贴）
  }
  e.preventDefault();
  if (!panelOpen.value) {
    openPanel();
    return;
  }
  closePanel();
}

/** 消息流滚动到底部（最新消息）。 */
function scrollChatToBottom() {
  const el = chatMessagesRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/** 模型让位：仅消息面板打开时（整块 383px 面板需要占位）。
 *  默认态气泡是贴头小卡，不让位——全量 setRetreat 会把角色甩到天边。 */
function applyRetreat() {
  pet?.setRetreat(panelOpen.value, bubbleSide.value);
}

// 面板打开 → 模型缩小让位（偏到面板对侧）+ 滚到最新消息；关闭 → 恢复
watch(panelOpen, (open) => {
  applyRetreat();
  if (open) void nextTick(() => scrollChatToBottom());
});

/** 让桌宠窗口获得键盘焦点（否则输入框无法输入）。 */
async function focusWindow() {
  if (!tauriAvailable()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFocus();
  } catch {
    /* 忽略 */
  }
}

/** 发送消息：保持面板打开，让用户看到回复在消息流中滚动（回复完成可手动收起）。 */
async function sendAndClose() {
  await send();
}

// ---------- 聊天内容 → 情绪 → Live2D 动作/表情 ----------
// 借鉴 N.E.K.O：对聊天气泡文本做轻量情绪推断，触发对应动作组 + 表情。
// 表情与大动作解耦：朗读中只换脸（不动大动作），弱情绪也换脸，避免「几乎没反应」。
let emotionMapReady = false;
/** 上次情绪大动作触发时刻（避免连续消息动作过密）。 */
let lastEmotionAt = 0;
const EMOTION_MIN_INTERVAL_MS = 1800;
/** 上次表情切换时刻（可以比大动作更勤）。 */
let lastExprAt = 0;
const EXPR_MIN_INTERVAL_MS = 700;
/** neutral 时的轻点头冷却（保持存在感，又不吵）。 */
let lastNodAt = 0;
const NOD_INTERVAL_MS = 12000;

/** 弱/无情绪时的软表情池（YUI 有 exp3 时随机轻表情）。 */
const SOFT_EXPRS = ["by", "expression3", "expression4", "expression11", "yyy", "xxy", "001"];

function pickOne<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function currentProfile(): PetModelProfile | undefined {
  return modelProfiles.value.find((m) => m.id === activeModelId.value);
}

/** 换脸（朗读中也可用；不影响 ParamMouthOpenY 口型）。 */
function applyExpression(emotion: PetEmotion, soft = false) {
  if (!pet) return;
  const now = performance.now();
  if (now - lastExprAt < EXPR_MIN_INTERVAL_MS) return;
  const profile = currentProfile();
  const list = profile?.expressionMap?.[emotion] ?? (soft ? SOFT_EXPRS : []);
  if (!list.length) return;
  lastExprAt = now;
  pet.setExpression(pickOne(list));
}

/**
 * 情绪→动作/表情触发。
 * - strong：表情 + 大动作（大动作受节流/朗读限制）
 * - weak：只换脸
 * - neutral/none：偶尔轻点头，保持存在感
 */
function reactToText(text: string) {
  if (!pet || !emotionMapReady) return;
  const detail = inferEmotionDetail(text);
  const emotion = detail.emotion;
  const now = performance.now();

  // 表情：朗读中也允许（只动脸，不动身体）
  applyExpression(emotion, detail.intensity !== "strong");

  // 大动作：朗读中跳过（避免与口型/声音打架）
  if (speaking) return;
  if (detail.intensity === "weak") return;
  if (emotion === "neutral" || detail.intensity === "none") {
    // 闲聊兜底：偶尔轻点头，避免「完全没反应」
    if (now - lastNodAt > NOD_INTERVAL_MS) {
      lastNodAt = now;
      pet.playEmotion("Nod", { priority: "normal" });
    }
    return;
  }
  if (now - lastEmotionAt < EMOTION_MIN_INTERVAL_MS) {
    applyExpression(emotion, false);
    return;
  }

  const profile = currentProfile();
  lastEmotionAt = now;
  lastExprAt = now;
  // 动作 + 表情同播（表情淡入淡出）
  pet.react(emotion, {
    expressions: profile?.expressionMap?.[emotion],
  });
  console.log("[pet] emotion", emotion, detail.intensity);
}

/** 用户消息到达：先推断情绪并触发动作，再显示气泡。 */
function onUserMessage(content: string) {
  reactToText(content);
  showBubble("user", content, 3500);
}

/** 助手消息完成：朗读 + 根据助手内容触发情绪动作（如安慰、开心回应）。 */
function onAssistantDone(content: string) {
  reactToText(content);
  // 朗读由主窗口 speakMessageText → tts://speak-request 统一触发（避免双端各播）
}

// ---------- 点击穿透：默认穿透，命中可交互区则解除 ----------
// 对齐成熟方案：Rust 全局鼠标流（device-mouse-move，16ms 节流）推坐标。
// 整窗 setIgnoreCursorEvents(true) 后 WebView 收不到 mousemove，事件流是
// 穿透态下唯一可靠的光标来源 —— 解除「穿透后无法恢复交互」死锁。
// 前端用窗口几何换算 client 坐标 + elementFromPoint 命中检测，翻转穿透。
let unlistenMouseMove: (() => void) | null = null;
/** 最近一次穿透态（避免重复 IPC） */
let clickthroughActive = true;
/** 最近一次鼠标流坐标：气泡/面板出现时立刻重算命中，避免「已经指着却点不着」 */
let lastMouseScreen: { x: number; y: number } | null = null;

/** 命中可交互区域 → 不需要穿透。
 *  模型侧只认 .model-hitbox（角色包围盒，由 live2d.ts 按顶点 bbox 计算），
 *  整块 PIXI 画布不参与命中 —— 桌宠两侧/头顶透明空白可穿透鼠标。
 *  对气泡/面板额外做 16px hit-slop：光标靠近就先解除穿透，避免「看着到了却点不着」。 */
const INTERACTIVE_SELECTOR =
  ".model-hitbox, .speech-bubble, .chat-flow, .model-picker-panel, .question-card, .conn-dot";
const HIT_SLOP = 16;

function isInteractiveAt(clientX: number, clientY: number): boolean {
  try {
    const el = document.elementFromPoint(clientX, clientY);
    if (el?.closest?.(INTERACTIVE_SELECTOR)) return true;
    // hit-slop：可交互矩形外扩一圈，提前释放 setIgnoreCursorEvents
    const slop = HIT_SLOP;
    for (const node of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
      const r = (node as HTMLElement).getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (
        clientX >= r.left - slop &&
        clientX <= r.right + slop &&
        clientY >= r.top - slop &&
        clientY <= r.bottom + slop
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** 窗口几何缓存：鼠标流 16ms 一发，每次都 IPC 拉 outerPosition/Size 会拖垮命中灵敏度 */
let winGeomCache: { x: number; y: number; w: number; h: number; at: number } | null = null;
const WIN_GEOM_TTL_MS = 400;

async function refreshWinGeom(force = false) {
  if (!tauriAvailable()) return null;
  const now = performance.now();
  if (!force && winGeomCache && now - winGeomCache.at < WIN_GEOM_TTL_MS) return winGeomCache;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
    winGeomCache = { x: pos.x, y: pos.y, w: size.width, h: size.height, at: now };
    return winGeomCache;
  } catch {
    return winGeomCache;
  }
}

async function applyClickthroughAt(screenX: number, screenY: number) {
  if (!tauriAvailable()) return;
  try {
    const geom = await refreshWinGeom();
    if (!geom) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const dpr = window.devicePixelRatio || 1;
    // 事件坐标为物理像素；outerPosition/Size 亦为物理像素 → client 用 /dpr
    const clientX = (screenX - geom.x) / dpr;
    const clientY = (screenY - geom.y) / dpr;
    const outOfWindow =
      clientX < 0 || clientY < 0 || clientX >= geom.w / dpr || clientY >= geom.h / dpr;
    if (outOfWindow) {
      if (!clickthroughActive) {
        clickthroughActive = true;
        await win.setIgnoreCursorEvents(true);
      }
      return;
    }
    const wantIgnore = !isInteractiveAt(clientX, clientY);
    if (wantIgnore === clickthroughActive) return;
    clickthroughActive = wantIgnore;
    await win.setIgnoreCursorEvents(wantIgnore);
  } catch {
    /* 忽略 */
  }
}

async function startClickthrough() {
  if (!tauriAvailable()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    // 初始整窗穿透；CSS pointer-events 双保险见 .pet-root
    clickthroughActive = true;
    await getCurrentWindow().setIgnoreCursorEvents(true);
  } catch {
    /* 忽略 */
  }
  // 绑定 Rust 鼠标流（窗口重建后 mount 会再次调用，Rust 侧幂等重绑）
  try {
    await startPetMouseStream();
    unlistenMouseMove = await onTauriEvent<{ x: number; y: number }>(
      PET_MOUSE_MOVE_EVENT,
      (p) => {
        lastMouseScreen = { x: p.x, y: p.y };
        void applyClickthroughAt(p.x, p.y);
        void feedLookAt(p.x, p.y);
      },
    );
  } catch (err) {
    console.error("[pet] mouse stream unavailable", err);
  }
}

/** 全局光标 → 容器坐标 → 视线追踪（穿透态也能「看着鼠标」）。 */
async function feedLookAt(screenX: number, screenY: number) {
  if (!pet || !tauriAvailable()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
    const dpr = window.devicePixelRatio || 1;
    const clientX = (screenX - pos.x) / dpr;
    const clientY = (screenY - pos.y) / dpr;
    if (
      clientX < 0 ||
      clientY < 0 ||
      clientX >= size.width / dpr ||
      clientY >= size.height / dpr
    ) {
      return;
    }
    pet.setLookAt(clientX, clientY);
  } catch {
    /* 忽略 */
  }
}

function stopClickthrough() {
  unlistenMouseMove?.();
  unlistenMouseMove = null;
  clickthroughActive = true;
}

// ---------- 语音朗读 + 口型同步 ----------
/** 执行主窗口朗读请求：立刻 ack + 入本地队列（latest-wins），播完/跳过都回 done。 */
function handleTtsRequest(req: TtsSpeakRequest) {
  if (!req?.text) return;
  void emitTauriEvent(TTS_SPEAK_ACK, { requestId: req.requestId });
  void (async () => {
    try {
      // 主窗口已按设置决定是否发起；这里只负责播（不再用 ttsEnabled 拦截，避免未同步导致静音）
      void ttsEnabled.value;
      await speakLocal(req.text, ttsVoice.value || undefined, { force: !!req.force });
    } catch {
      /* ignore */
    } finally {
      try {
        await emitTauriEvent(TTS_SPEAK_DONE, { requestId: req.requestId });
      } catch {
        /* ignore */
      }
    }
  })();
}

// 助手最终消息到达时自动朗读（历史加载/重启恢复的消息不朗读，避免重放）
// 注：朗读 + 情绪动作统一由 onAssistantDone 触发（在消息流 watch 中调用），
// 这里不再重复监听，避免双重朗读。
onMounted(async () => {
  connect();
  startAutoRefresh();
  void updateBubbleSide();
  void bindPetMovedListener();
  // 互动感知：读设置里的长拖阈值（默认 3s）；模式关时 backend 会直接丢弃
  void (async () => {
    try {
      const { getSettings } = await import("../api");
      const s = await getSettings();
      if (s.petInteraction?.longHoldMs) {
        interactionTracker.setLongHoldMs(s.petInteraction.longHoldMs);
      }
    } catch {
      interactionTracker.setLongHoldMs(DEFAULT_LONG_HOLD_MS);
    }
  })();
  // 窗口被拖动后位置会变化：定时重新检测气泡区方向 + 模型偏置
  bubbleSideTimer = window.setInterval(() => void updateBubbleSide(), 3000);
  void startClickthrough();
  // 全局朗读执行端（手动点读 / 自动回复都到这里，才能带动口型）
  void onTauriEvent<TtsSpeakRequest>(TTS_SPEAK_REQUEST, (req) => {
    handleTtsRequest(req);
  });
  // 口型跟随播放态（当前播完/被停止时收口）
  offTtsMouth = onTtsSpeakingChange((v) => {
    if (v) {
      stopMouth?.();
      stopMouth = pet ? pet.startMouth() : null;
    } else {
      stopMouth?.();
      stopMouth = null;
    }
  });
  void onTauriEvent(TTS_STOP, () => {
    // 只停本地，禁止再 emit TTS_STOP（回环）
    stopSpeaking({ broadcast: false });
  });
  try {
    if (modelHost.value) {
      // Live2D 懒加载：即使模型/渲染失败，页面主体仍可用
      const catalog = await loadModelCatalog();
      modelProfiles.value = catalog.models;
      const profile = pickModelProfile(catalog);
      await mountPetModel(profile);
      loading.value = false;
      // 情绪映射（聊天气泡 → 动作）懒加载；失败时回退内置缺省表
      try {
        await loadEmotionMap();
      } finally {
        emotionMapReady = true;
      }
      // 设置页/其他窗口切换模型时热更新
      void onTauriEvent<{ id: string }>(PET_MODEL_CHANGED_EVENT, (p) => {
        void onExternalModelChange(p?.id);
      });
      window.addEventListener("storage", (e) => {
        if (e.key === "diver.pet.modelId" && e.newValue) {
          void onExternalModelChange(e.newValue);
        }
      });
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
    loading.value = false;
    console.error("[pet] model load failed:", err);
  }
});

onBeforeUnmount(() => {
  if (bubbleSideTimer !== null) window.clearInterval(bubbleSideTimer);
  petDragSession = false;
  clearDragIdleTimer();
  void setPetDragging(false);
  interactionTracker.dispose();
  unlistenPetMoved?.();
  unlistenPetMoved = null;
  stopClickthrough();
  offTtsMouth?.();
  offTtsMouth = null;
  stopMouth?.();
  pet?.destroy();
  pet = null;
  hideBubbleNow();
});
</script>

<template>
  <div
    class="pet-root"
    :class="[`bubble-${bubbleSide}`, `drag-${dragState}`]"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @contextmenu="onContextMenu"
  >
    <!-- 长按蓄力：按住超过 150ms 才显示圆环；短按是点按互动，不闪 UI -->
    <div
      v-if="dragState === 'arming' && chargeUiVisible"
      class="drag-charge"
      :style="{ left: `${chargePos.x}px`, top: `${chargePos.y}px` }"
      aria-hidden="true"
    >
      <svg class="drag-charge-ring" viewBox="0 0 40 40">
        <circle class="drag-charge-track" cx="20" cy="20" r="16" />
        <circle
          class="drag-charge-fill"
          cx="20"
          cy="20"
          r="16"
          :style="{ animationDuration: `${LONG_PRESS_MS}ms` }"
        />
      </svg>
      <span class="drag-charge-hint">按住拖动</span>
    </div>

    <!-- 模型区：全屏（模型居中），消息流面板悬浮其上 -->
    <div class="model-area" :class="{ loading }">
      <div ref="modelHost" class="model-host"></div>
      <div v-if="loading" class="loading-hint">加载桌宠…</div>
      <div v-if="loadError" class="load-error">模型加载失败：{{ loadError }}</div>
      <div v-if="runtimeErrors.length" class="runtime-errors">
        <div v-for="(e, i) in runtimeErrors.slice(-5)" :key="i">{{ e }}</div>
      </div>
    </div>

    <!-- 悬浮消息流面板：宽 ~383px，占满高度，位于模型对侧（朝屏幕中心）。
         常态收起；面板打开时模型缩小让位（setRetreat）。 -->
    <div class="bubble-area">
      <Transition name="panel">
        <div v-if="panelOpen" class="chat-flow" :class="{ 'drag-over': panelDragOver }" @pointerdown.stop @dragenter.prevent="onPanelDragOver" @dragover.prevent="onPanelDragOver" @dragleave.prevent="panelDragOver = false" @drop="onPanelDrop">
          <!-- 消息流：透明背景，可滚动回看历史 -->
          <div ref="chatMessagesRef" class="chat-messages">
            <div
              v-for="(m, i) in visibleMessages"
              :key="m.id + '-' + i"
              class="chat-msg"
              :class="[m.kind, { streaming: m.streaming }]"
            >
              <template v-if="m.kind === 'system'">
                <span class="msg-text system-text">{{ m.content }}</span>
              </template>
              <template v-else>
                <span v-if="m.kind === 'user'" class="msg-label">我</span>
                <span v-else class="msg-label">✦</span>
                <span class="msg-text">
                  <span v-if="(m.images?.length ?? 0) > 0" class="msg-images">
                    <img
                      v-for="(img, ii) in m.images"
                      :key="ii"
                      class="msg-image"
                      :src="`data:${img.mime};base64,${img.data}`"
                      :alt="img.name || '图片'"
                    />
                  </span>
                  <span class="md-body" v-html="renderMarkdownHtml(m.content)"></span>
                  <span v-if="m.streaming" class="cursor">▍</span>
                </span>
              </template>
            </div>
            <div v-if="!visibleMessages.length" class="chat-empty">说点什么吧…</div>
          </div>
          <!-- 输入区：附件预览 + 文本 + 加图/发送 -->
          <div v-if="attachments.length" class="panel-attach-strip">
            <div v-for="a in attachments" :key="a.id" class="panel-attach-item">
              <img :src="a.previewUrl" :alt="a.name || '图片'" class="panel-attach-thumb" />
              <button
                class="panel-attach-remove"
                type="button"
                title="移除"
                @pointerdown.stop
                @click="removeAttachment(a.id)"
              >
                ×
              </button>
            </div>
          </div>
          <div class="panel-input-row">
            <input
              ref="attachFileInput"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              @change="onAttachFileInput"
            />
            <button
              class="attach-btn"
              type="button"
              title="添加图片"
              @pointerdown.stop
              @click="pickAttachImages"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <circle cx="8.5" cy="10" r="1.5" />
                <path d="M21 16l-5-5-4 4-2-2-7 7" />
              </svg>
            </button>
            <input
              ref="panelInput"
              v-model="composer"
              type="text"
              :placeholder="isReady ? '说点什么吧…（可粘贴图片）' : busy ? '正在思考…' : '连接中…'"
              :disabled="!isReady"
              @keydown.enter="sendAndClose"
              @paste="onPanelPaste"
            />
            <button
              class="send-btn"
              :class="{ busy }"
              :disabled="!canSend"
              :title="busy ? '正在思考…' : '发送'"
              @click="sendAndClose"
            >
              <svg v-if="!busy" class="send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 2 11 13" />
                <path d="M22 2 15 22 11 13 2 9 22 2Z" />
              </svg>
              <span v-else class="busy-dots">…</span>
            </button>
            <!-- ⋯ 菜单：低频操作收纳在此；切换模型打开独立面板 -->
            <div class="more-menu-wrap">
              <button class="more-btn" title="更多" @click="toggleMoreMenu">⋯</button>
              <Transition name="panel">
                <div v-if="moreMenuOpen" class="more-menu">
                  <button class="more-opt" @click="openModelPicker">
                    切换模型{{ switchingModel ? " …" : "" }}
                  </button>
                  <button class="more-opt" @click="closePanelFromMenu">收起面板</button>
                </div>
              </Transition>
            </div>
          </div>
        </div>
      </Transition>

      <!-- 模型选择面板：卡片列表，与设置页「桌宠形象」同一套 UI -->
      <Transition name="panel">
        <div v-if="modelPickerOpen" class="model-picker-panel" @pointerdown.stop>
          <div class="model-picker-head">
            <span class="model-picker-title">切换模型</span>
            <button class="model-picker-close" title="关闭" @click="modelPickerOpen = false">×</button>
          </div>
          <PetModelPicker
            compact
            :models="modelProfiles"
            :active-id="activeModelId"
            :switching="switchingModel"
            @select="switchModel"
          />
          <p class="model-picker-hint">YUI 来自 N.E.K.O，仅供本地学习评估。</p>
        </div>
      </Transition>
    </div>

    <!-- 常态气泡：贴角色头顶的紧凑预览卡（pet-root 直属子级，按 hitbox 定位） -->
    <Transition name="bubble">
      <div
        v-if="!panelOpen && bubbleVisible && bubbleText"
        class="speech-bubble"
        :class="bubbleKind"
        :style="bubblePos ? { left: `${bubblePos.left}px`, top: `${bubblePos.top}px` } : undefined"
        title="点击展开消息面板"
        @pointerdown.stop
        @click.stop="openPanel"
        @mouseenter="onBubbleEnter"
        @mouseleave="onBubbleLeave"
      >
        <div class="bubble-head">
          <span v-if="bubbleKind === 'user'" class="bubble-label">我</span>
          <span v-else class="bubble-label">✦</span>
          <button
            class="bubble-close"
            title="关闭"
            @pointerdown.stop
            @click.stop="hideBubbleNow"
          >
            ×
          </button>
        </div>
        <span class="bubble-text">
          {{ bubbleText }}
          <span v-if="bubbleStreaming" class="cursor">▍</span>
        </span>
        <div v-if="!bubbleStreaming" class="bubble-hint">点击展开 ›</div>
      </div>
    </Transition>

    <!-- 连接状态小圆点：仅离线时显示（常态在线时不显示，避免干扰视觉） -->
    <div v-if="!connected" class="conn-dot" title="离线"></div>

    <!-- 提问卡片：agent 通过 ask_user_question 询问时出现 -->
    <Transition name="panel">
      <div v-if="pendingQuestion" class="question-card" @pointerdown.stop>
        <div v-for="q in pendingQuestion.questions" :key="q.id" class="q-item">
          <div class="q-text">{{ q.question }}</div>
          <div v-if="q.options?.length" class="q-options">
            <button
              v-for="opt in q.options"
              :key="opt.label"
              class="q-opt"
              :class="{ picked: (qSelections[q.id] ?? []).includes(opt.label) }"
              @click="toggleQOption(q.id, opt.label, q.multiSelect)"
            >
              {{ opt.label }}
            </button>
          </div>
          <input
            v-if="!q.options?.length || q.multiSelect"
            v-model="qCustoms[q.id]"
            type="text"
            :placeholder="q.multiSelect ? '补充（可选）' : '输入回答…'"
            class="q-input"
          />
        </div>
        <div class="q-actions">
          <button class="send-btn" @click="answerPending">回答</button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.pet-root {
  position: relative;
  display: flex;
  height: 100vh;
  width: 100vw;
  background: transparent;
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  overflow: hidden;
  cursor: default;
  user-select: none;
  /* 点击穿透双保险：窗口级 setIgnoreCursorEvents + CSS 级 pointer-events。
     默认整页穿透（透明区域不挡鼠标），可交互区（模型/气泡/面板）opt-in auto。
     注意：本规则用独立的非 scoped style 块（见文件底部），因为 scoped 的
     data-v 属性选择器无法可靠作用于 PIXI 运行时创建的 canvas 与过渡动画包装。 */
  pointer-events: none;
}
/* 长按蓄力反馈：
   - arming：默认指针 + 按下点圆环进度（350ms 蓄满）
   - dragging：仅此时显示 grabbing，表示系统拖动已生效 */
.pet-root.drag-arming,
.pet-root.drag-arming .model-host,
.pet-root.drag-arming .model-host :deep(canvas) {
  cursor: default;
}
.pet-root.drag-dragging,
.pet-root.drag-dragging .model-host,
.pet-root.drag-dragging .model-host :deep(canvas) {
  cursor: grabbing;
}
/* 可交互模型区悬停：不要提前 grab（拖动需长按蓄力） */
.pet-root .model-host,
.pet-root .model-host :deep(canvas) {
  cursor: default;
}

.drag-charge {
  position: fixed;
  z-index: 80;
  pointer-events: none;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.drag-charge-ring {
  width: 40px;
  height: 40px;
  display: block;
  filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.35));
}
.drag-charge-track {
  fill: rgba(20, 20, 32, 0.45);
  stroke: rgba(255, 255, 255, 0.18);
  stroke-width: 3;
}
.drag-charge-fill {
  fill: none;
  stroke: #ffb07c;
  stroke-width: 3;
  stroke-linecap: round;
  /* r=16 → 周长 ≈ 100.53 */
  stroke-dasharray: 100.53;
  stroke-dashoffset: 100.53;
  transform: rotate(-90deg);
  transform-origin: 50% 50%;
  animation-name: drag-charge-ring;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}
@keyframes drag-charge-ring {
  to {
    stroke-dashoffset: 0;
  }
}
/* 拖动中：根节点与命中框均为 grabbing（scoped 选择器需盖过 default） */
.pet-root.drag-dragging {
  cursor: grabbing !important;
}
.pet-root.drag-dragging .model-hitbox,
.pet-root.drag-dragging .model-host :deep(.model-hitbox) {
  cursor: grabbing !important;
}
.pet-root.drag-arming,
.pet-root.drag-arming .model-hitbox,
.pet-root.drag-arming .model-host :deep(.model-hitbox) {
  cursor: default !important;
}
.pet-root:not(.drag-dragging):not(.drag-arming) .model-hitbox,
.pet-root:not(.drag-dragging):not(.drag-arming) .model-host :deep(.model-hitbox),
.pet-root:not(.drag-dragging):not(.drag-arming) {
  cursor: default;
}
.drag-charge-hint {
  font-size: 11px;
  color: #ffe3c4;
  background: rgba(28, 29, 44, 0.88);
  border: 1px solid rgba(255, 176, 124, 0.35);
  border-radius: 999px;
  padding: 3px 8px;
  white-space: nowrap;
  letter-spacing: 0.02em;
}

/* ---------- 悬浮面板布局 ----------
 * 模型区全屏（居中）；消息流面板绝对定位悬浮在窗口一侧。
 * bubble-right：面板在右；bubble-left：面板在左（朝屏幕中心）。 */
.pet-root .model-area {
  flex: 1 1 100%;
  width: 100%;
}
.pet-root .bubble-area {
  position: absolute;
  top: 8px;
  bottom: 0;
  width: 383px;
  max-width: calc(100% - 16px);
  z-index: 15;
}
.pet-root.bubble-right .bubble-area {
  right: 8px;
}
.pet-root.bubble-left .bubble-area {
  left: 8px;
}

/* ---------- Live2D 模型区（全屏画布 + 角色命中框） ---------- */
.model-area {
  position: relative;
  min-height: 0;
  overflow: hidden;
  pointer-events: none;
}
.model-host {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.model-host :deep(canvas) {
  width: 100%;
  height: 100%;
  pointer-events: none;
}
/* 命中框由 live2d.ts 定位到角色包围盒；scoped 下仍要允许命中 */
.model-host :deep(.model-hitbox) {
  position: absolute;
  pointer-events: auto;
  z-index: 2;
}
.loading-hint,
.load-error {
  position: absolute;
  top: 40%;
  left: 50%;
  transform: translateX(-50%);
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  background: rgba(20, 20, 32, 0.6);
  padding: 6px 14px;
  border-radius: 12px;
  white-space: nowrap;
}
.load-error {
  color: #e8a3a3;
}
.runtime-errors {
  position: absolute;
  top: 8px;
  left: 8px;
  right: 8px;
  font-size: 10px;
  color: #ff9d9d;
  background: rgba(20, 10, 10, 0.85);
  border: 1px solid rgba(255, 100, 100, 0.4);
  border-radius: 8px;
  padding: 6px 8px;
  white-space: pre-wrap;
  word-break: break-all;
  z-index: 10;
}

/* ---------- 气泡区：消息流 + 输入框（跟随交互面板呼出） ---------- */
.bubble-area {
  position: relative;
  flex: 1 1 0%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-items: stretch;
  padding: 8px 8px;
  overflow: hidden;
}

/* 消息流面板：背景完全透明（仅细边框 + 阴影），消息气泡自身带颜色 */
.chat-flow {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.2);
  z-index: 8;
}
.chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
}
.chat-msg {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.55;
  word-break: break-word;
  padding: 6px 10px;
  border-radius: 12px;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}
.chat-msg.system {
  justify-content: center;
  background: transparent !important;
  padding: 2px 8px;
}
.chat-msg.system .system-text {
  color: #8d89a1;
  font-size: 11px;
}
.chat-msg.assistant {
  background: rgba(28, 29, 44, 0.75);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #eceaf5;
}
.chat-msg.user {
  background: rgba(74, 63, 110, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #f4f2fa;
}
.msg-label {
  font-size: 10px;
  opacity: 0.7;
  flex-shrink: 0;
  margin-top: 2px;
}
.msg-text {
  flex: 1;
  min-width: 0;
}
.chat-empty {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.35);
  text-align: center;
  padding: 24px 0;
}

/* 常态短暂气泡：贴角色头顶的紧凑预览卡（pet-root 绝对定位，由 layoutSpeechBubble 赋 left/top）。
 * 长文只露前几行；悬停暂停消失；点关闭或点正文展开面板。 */
.speech-bubble {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px 6px;
  border-radius: 14px;
  font-size: 12px;
  line-height: 1.55;
  word-break: break-word;
  white-space: pre-wrap;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  z-index: 40;
  box-sizing: border-box;
  width: max-content;
  max-width: min(280px, calc(100vw - 16px));
  max-height: min(38%, 180px);
  overflow: hidden;
  cursor: pointer;
  transition: box-shadow 0.15s ease, transform 0.15s ease;
}
.speech-bubble:hover {
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  transform: translateY(-1px);
}
.bubble-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 16px;
}
.speech-bubble.assistant {
  background: rgba(28, 29, 44, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #eceaf5;
}
.speech-bubble.user {
  background: linear-gradient(135deg, rgba(74, 63, 110, 0.95), rgba(91, 77, 138, 0.95));
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f4f2fa;
}
.bubble-label {
  font-size: 10px;
  opacity: 0.7;
  flex-shrink: 0;
}
.bubble-close {
  margin-left: auto;
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0.55;
  font-size: 14px;
  line-height: 1;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  cursor: pointer;
  padding: 0;
}
.bubble-close:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.12);
}
.bubble-text {
  flex: 1;
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.bubble-hint {
  align-self: flex-end;
  font-size: 10px;
  opacity: 0.55;
  line-height: 1.2;
  margin-top: 2px;
}
.speech-bubble:hover .bubble-hint {
  opacity: 0.9;
}
.cursor {
  color: #ffb07c;
  animation: pulse 0.9s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* 气泡浮现/淡出动画；过渡起止态不参与命中，避免透明层挡住点击 */
.bubble-enter-active,
.bubble-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.bubble-enter-from {
  opacity: 0;
  transform: translateY(-10px) scale(0.92);
  pointer-events: none !important;
}
.bubble-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.96);
  pointer-events: none !important;
}

/* ---------- 连接状态小圆点 ---------- */
.conn-dot {
  position: absolute;
  top: 6px;
  left: 6px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(255, 100, 100, 0.7);
  z-index: 12;
}

/* ---------- 提问卡片（ask_user_question） ---------- */
/* 固定宽度（不随窗口扩展拉伸），始终居中于窗口底部 */
.question-card {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 8px;
  width: min(340px, calc(100vw - 20px));
  background: rgba(28, 29, 44, 0.97);
  border: 1px solid rgba(255, 176, 124, 0.4);
  border-radius: 14px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  z-index: 21;
}
.q-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.q-text {
  font-size: 12px;
  color: #eceaf5;
  line-height: 1.5;
}
.q-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.q-opt {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  color: #d9d6e6;
  font-size: 11px;
  padding: 6px 10px;
  cursor: pointer;
  font-family: inherit;
}
.q-opt.picked {
  background: rgba(255, 176, 124, 0.18);
  border-color: rgba(255, 176, 124, 0.55);
  color: #ffe3c4;
}
.q-input {
  background: #141420;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  color: #e8e6f0;
  font-size: 12px;
  padding: 7px 10px;
  outline: none;
  font-family: inherit;
}
.q-actions {
  display: flex;
  justify-content: flex-end;
}

/* ---------- 消息流面板内的输入区（chat-flow 子元素） ---------- */
.chat-flow.drag-over {
  border-color: rgba(255, 176, 124, 0.55);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.2), 0 0 0 1px rgba(255, 176, 124, 0.25);
}
.msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0 0 4px;
}
.msg-image {
  max-width: min(140px, 42vw);
  max-height: 96px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  object-fit: contain;
  background: rgba(0, 0, 0, 0.25);
  display: block;
}
.panel-attach-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 10px 0;
}
.panel-attach-item {
  position: relative;
  width: 48px;
  height: 48px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  overflow: hidden;
  background: rgba(20, 20, 32, 0.8);
}
.panel-attach-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.panel-attach-remove {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.panel-input-row {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  align-items: center;
}
.attach-btn {
  background: rgba(20, 20, 32, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #9a96ad;
  border-radius: 12px;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
}
.attach-btn svg {
  width: 16px;
  height: 16px;
}
.attach-btn:hover {
  color: #ffb07c;
  border-color: rgba(255, 176, 124, 0.4);
}
.panel-input-row input {
  flex: 1;
  background: rgba(20, 20, 32, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  color: #e8e6f0;
  font-size: 12px;
  padding: 8px 12px;
  outline: none;
  font-family: inherit;
  min-width: 0;
}
.panel-input-row input:focus {
  border-color: rgba(255, 176, 124, 0.5);
}
.panel-input-row input::placeholder {
  color: #5d5973;
}
.panel-input-row input:disabled {
  opacity: 0.5;
}
.send-btn {
  background: linear-gradient(135deg, #ff9d6c, #c06ab3);
  color: #fff;
  border: none;
  border-radius: 12px;
  padding: 0;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-family: inherit;
  flex-shrink: 0;
}
.send-icon {
  width: 17px;
  height: 17px;
}
.send-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.busy-dots {
  font-size: 15px;
  line-height: 1;
}
/* ---------- ⋯ 菜单（收起面板等低频操作） ---------- */
.more-menu-wrap {
  position: relative;
  flex-shrink: 0;
}
.more-btn {
  background: rgba(255, 255, 255, 0.06);
  color: #b9b5cf;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  font-family: inherit;
}
.more-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #e8e6f0;
}
.more-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  min-width: 160px;
  background: rgba(28, 29, 44, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  z-index: 30;
}
.more-opt {
  background: transparent;
  border: none;
  border-radius: 7px;
  color: #d9d6e6;
  font-size: 11px;
  padding: 7px 10px;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 4px;
}
.more-opt:hover {
  background: rgba(255, 176, 124, 0.15);
  color: #ffe3c4;
}
.model-picker-panel {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(320px, calc(100vw - 32px));
  max-height: min(420px, calc(100vh - 40px));
  overflow-y: auto;
  background: rgba(28, 29, 44, 0.97);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 14px;
  padding: 14px;
  z-index: 50;
  pointer-events: auto;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
}
.model-picker-head {
  display: flex;
  align-items: center;
  margin-bottom: 10px;
}
.model-picker-title {
  flex: 1;
  font-size: 13px;
  color: #f0eef8;
}
.model-picker-close {
  background: transparent;
  border: none;
  color: #8d89a1;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  font-family: inherit;
}
.model-picker-close:hover {
  color: #ffe3c4;
}
.model-picker-hint {
  margin: 10px 0 0;
  font-size: 10px;
  line-height: 1.5;
  color: #6f6b85;
}

.panel-enter-active,
.panel-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
/* 消息流面板（chat-flow）从右侧滑入——它位于气泡区内部，无需 -50% 居中修正 */
.panel-enter-from,
.panel-leave-to {
  opacity: 0;
  transform: translateY(14px);
}
</style>

<!-- 非 scoped：点击穿透的可交互区 opt-in。
     scoped 的 data-v 属性选择器无法可靠作用于 PIXI 运行时创建的节点。
     仅命中框与 UI 面板可交互；画布/透明留白 pointer-events: none。 -->
<style>
.pet-root .model-hitbox,
.pet-root .speech-bubble,
.pet-root .speech-bubble *,
.pet-root .chat-flow,
.pet-root .model-picker-panel,
.pet-root .question-card,
.pet-root .conn-dot {
  pointer-events: auto;
}
/* 过渡起止态（透明）不参与命中，避免残留层挡住真实点击 */
.pet-root .speech-bubble.bubble-enter-from,
.pet-root .speech-bubble.bubble-leave-to {
  pointer-events: none !important;
}
/* PIXI 画布铺满窗口，必须不参与命中 */
.pet-root .model-host canvas {
  pointer-events: none !important;
  cursor: default !important;
}
.pet-root.drag-dragging .model-hitbox {
  cursor: grabbing !important;
}
/* 调试：打开后可看见角色命中框 */
.pet-root .model-hitbox.debug-hitbox {
  outline: 1px dashed rgba(255, 176, 124, 0.7);
  background: rgba(255, 176, 124, 0.08);
}
</style>
