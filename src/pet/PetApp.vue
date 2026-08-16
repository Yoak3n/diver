<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePetChat } from "./usePetChat";
import { speakText, tauriAvailable } from "../tauri";
import type { PetModelHandle } from "./live2d";

const modelHost = ref<HTMLElement | null>(null);
const panelInput = ref<HTMLInputElement | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const runtimeErrors = ref<string[]>([]);
let pet: PetModelHandle | null = null;
let stopMouth: (() => void) | null = null;
let speaking = false;

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

const { messages, busy, connected, composer, canSend, connect, send, startAutoRefresh, ttsEnabled, ttsVoice, pendingQuestion, submitQuestionAnswer } =
  usePetChat();

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

// ---------- 头顶对话气泡：消息以自然方式浮现，不占据模型空间 ----------
/** 交互面板（右键呼出）：声明前置，scheduleAutoResize 需要读取它。 */
const panelOpen = ref(false);
const bubbleText = ref("");
const bubbleKind = ref<"user" | "assistant">("assistant");
const bubbleVisible = ref(false);
const bubbleStreaming = ref(false);
/** 气泡水平偏移（px）：窗口在屏幕左半 → 向右偏，右半 → 向左偏，避免遮挡模型头部。 */
const bubbleShift = ref(0);
const BUBBLE_SHIFT_PX = 48;
let bubbleTimer: number | null = null;
let bubbleShiftTimer: number | null = null;

// ---------- 窗口自适应宽度（气泡按内容展开，避免长消息被 360px 限制） ----------
const PET_MIN_W = 360;
const PET_MAX_W = 640;
/** 气泡最大横向占比（贴边时）。模型固定在窗口中央（显示宽≈360px），
 *  头部约占窗口中央 260~380px 区域；气泡过宽会遮住模型头部，
 *  因此贴边上限取 45%（250px，止步于头部左缘前）。 */
const BUBBLE_MAX_RATIO = 0.45;
const BUBBLE_MAX_PX = 250;
let autoResizeTimer: number | null = null;
let currentPetW = PET_MIN_W;

/** 粗略估算一行文本的像素宽度（12px 字号：CJK/全角≈13px，ASCII≈6.5px）。 */
function estimateTextWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? 13 : 6.5;
  }
  return width;
}

/**
 * 估算气泡所需窗口宽度（取最长行 + 气泡 padding + 窗口边距）。
 * 受气泡横向比例上限约束：窗口宽 = 气泡实际可用宽 / 比例 + 边距，
 * 因此窗口不会无限变宽。
 *
 * 渐进策略：窗口宽度直接随内容增长而增长（气泡在窗口内占比稳定），
 * 而不是"短消息固定 360、超出才跳变"——消息刚变长窗口就开始扩展，
 * 避免突兀的突然拉宽。
 */
function estimateWindowWidth(text: string): number {
  const lines = text.split("\n");
  let maxLine = 0;
  for (const line of lines) {
    maxLine = Math.max(maxLine, estimateTextWidth(line));
  }
  // 气泡可用宽度（含 padding）的上限
  const bubbleContent = Math.min(maxLine + 24, BUBBLE_MAX_PX);
  // 窗口宽 = 气泡宽 / 占比 + 左右边距（贴边 6px×2）
  // 额外 +40px 余量：气泡在接近占满前窗口就先一步扩展，观感更平滑
  const want = Math.ceil(bubbleContent / BUBBLE_MAX_RATIO + 12 + 24 + 40);
  return Math.min(PET_MAX_W, Math.max(PET_MIN_W, want));
}

/**
 * 调整窗口宽度，保持窗口中心（= 模型位置）在屏幕上的坐标不变。
 * 窗口向两侧对称扩展/收缩，模型始终停留在屏幕原位——避免
 * "右下角锚定"导致窗口向左扩展时模型在屏幕上左移。
 *
 * 一次到位（无分段动画）：分段步进（每 60ms 一次 setSize+setPosition 两步
 * IPC）会持续触发 WebView2 重排/重投影，实际观感反而卡顿；单次跳变只触发
 * 一次重排，配合"消息开始即扩展"的时机（见 watch(messages)）整体更流畅。
 */
let resizeFrozen = false;
async function resizePetWindow(width: number) {
  if (!tauriAvailable()) return;
  if (resizeFrozen) return;
  width = Math.min(PET_MAX_W, Math.max(PET_MIN_W, width));
  if (width === currentPetW) return;
  currentPetW = width;
  try {
    const { getCurrentWindow, PhysicalPosition, PhysicalSize } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
    const centerX = pos.x + size.width / 2;
    const bottom = pos.y + size.height;
    await win.setSize(new PhysicalSize(currentPetW, size.height));
    await win.setPosition(new PhysicalPosition(Math.round(centerX - currentPetW / 2), Math.round(bottom - size.height)));
  } catch {
    /* 非 Tauri 环境忽略 */
  }
}

/**
 * 气泡内容变化 → 节流调整窗口宽度；气泡隐藏 → 恢复默认宽度。
 * 交互面板打开期间冻结窗口宽度：右键呼出面板时用户正在操作，
 * 窗口任何扩缩都会扰动模型与输入框；面板关闭后按当前气泡状态恢复。
 */
function scheduleAutoResize() {
  if (autoResizeTimer !== null) window.clearTimeout(autoResizeTimer);
  autoResizeTimer = window.setTimeout(() => {
    autoResizeTimer = null;
    if (resizeFrozen) return; // 面板打开：冻结窗口宽度
    if (!bubbleVisible.value || !bubbleText.value) {
      void resizePetWindow(PET_MIN_W);
    } else {
      void resizePetWindow(estimateWindowWidth(bubbleText.value));
    }
  }, 250);
}

// 面板开关 → 同步冻结/解冻窗口宽度；关闭后按当前气泡状态恢复
watch(panelOpen, (open) => {
  resizeFrozen = open;
  if (!open) scheduleAutoResize();
});

/** 依据窗口在屏幕中的位置计算气泡偏移方向。 */
async function updateBubbleShift() {
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
    // 窗口中心在屏幕中心左侧 → 气泡向右偏移；右侧 → 向左偏移
    bubbleShift.value = winCenter < screenCenter ? BUBBLE_SHIFT_PX : -BUBBLE_SHIFT_PX;
  } catch {
    // 检测失败时默认贴右（居中会遮住模型头部，贴边至少保留一侧视野）
    bubbleShift.value = BUBBLE_SHIFT_PX;
  }
}

/** 按内容长度估算气泡停留时长（短句 3s，长文本上限 12s）。 */
function bubbleDuration(text: string): number {
  const chars = text.replace(/\s/g, "").length;
  return Math.min(Math.max(3000, chars * 120), 12000);
}

function showBubble(kind: "user" | "assistant", text: string, holdMs?: number) {
  if (bubbleTimer !== null) window.clearTimeout(bubbleTimer);
  // 显示前根据窗口位置刷新偏移方向（不阻塞显示）
  void updateBubbleShift();
  bubbleKind.value = kind;
  bubbleText.value = text;
  bubbleVisible.value = true;
  bubbleStreaming.value = false;
  scheduleAutoResize();
  bubbleTimer = window.setTimeout(() => {
    bubbleVisible.value = false;
    scheduleAutoResize();
  }, holdMs ?? bubbleDuration(text));
}

function hideBubbleNow() {
  if (bubbleTimer !== null) window.clearTimeout(bubbleTimer);
  bubbleVisible.value = false;
  bubbleStreaming.value = false;
  scheduleAutoResize();
}

// 监听消息流：用户消息立刻浮现；助手消息流式跟随，完成后停留再淡出。
// 窗口宽度在"消息开始之初"就扩展（不等节流）：用户消息内容已知 → 一次到位；
// 助手消息首个 chunk 即扩展，随后仅当内容需要更宽时才跳变（只扩不缩，
// 避免流式过程中的收缩抖动）。
watch(
  () => messages.value,
  (list) => {
    const last = list[list.length - 1];
    if (!last) return;
    if (last.kind === "user") {
      const want = estimateWindowWidth(last.content);
      if (want > currentPetW) void resizePetWindow(want);
      showBubble("user", last.content, 3500);
    } else if (last.kind === "assistant") {
      if (last.streaming) {
        // 流式输出中：持续跟随显示，不启动停留计时
        if (bubbleTimer !== null) window.clearTimeout(bubbleTimer);
        bubbleKind.value = "assistant";
        bubbleText.value = last.content;
        bubbleVisible.value = true;
        bubbleStreaming.value = true;
        const want = estimateWindowWidth(last.content);
        if (want > currentPetW) void resizePetWindow(want);
      } else if (last.content) {
        // 完成：停留后淡出
        showBubble("assistant", last.content);
      }
    }
  },
  { deep: true },
);

// ---------- 交互模型：长按拖动 / 点按互动 / 右键呼出交互面板 ----------
const LONG_PRESS_MS = 350;
/** 拖动状态：idle=默认 / arming=已按住未达阈值 / dragging=长按生效可移动 */
const dragState = ref<"idle" | "arming" | "dragging">("idle");
let pressTimer: number | null = null;
let longPressDragging = false;

function clearPressTimer() {
  if (pressTimer !== null) {
    window.clearTimeout(pressTimer);
    pressTimer = null;
  }
}

/** 是否点击在面板/气泡区域内（这些区域不参与长按拖动与点按互动）。 */
function inPanelArea(target: EventTarget | null): boolean {
  return !!(target instanceof HTMLElement && target.closest(".interact-panel, .speech-bubble"));
}

async function beginDrag() {
  if (!tauriAvailable()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startDragging();
  } catch {
    /* 拖动失败时忽略（如非 Tauri 环境） */
  }
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return; // 仅左键
  if (inPanelArea(e.target)) return;
  longPressDragging = false;
  dragState.value = "arming";
  clearPressTimer();
  // 长按超过阈值 → 进入窗口拖动
  pressTimer = window.setTimeout(() => {
    longPressDragging = true;
    dragState.value = "dragging";
    void beginDrag();
  }, LONG_PRESS_MS);
}

function onPointerUp(e: PointerEvent) {
  clearPressTimer();
  if (longPressDragging) {
    // 刚结束一次长按拖动：不触发互动
    longPressDragging = false;
    dragState.value = "idle";
    return;
  }
  dragState.value = "idle";
  if (e.button === 0 && !inPanelArea(e.target) && pet) {
    // 短按 → 互动（播放随机动作）
    pet.playMotion();
  }
}

function onPointerCancel() {
  clearPressTimer();
  longPressDragging = false;
  dragState.value = "idle";
}

/** 右键：呼出/收起交互面板（输入框常态隐藏）。 */
function onContextMenu(e: MouseEvent) {
  if (e.target instanceof HTMLElement && e.target.closest(".interact-panel")) {
    return; // 面板内保留原生菜单（如粘贴）
  }
  e.preventDefault();
  panelOpen.value = !panelOpen.value;
  if (panelOpen.value) {
    // 面板打开：冻结由 watch(panelOpen) 统一处理（resizeFrozen + 中断动画链）
    void nextTick(() => {
      panelInput.value?.focus();
      void focusWindow();
    });
  }
}

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

/** 发送后收起面板，回到常态（回复通过气泡 + 语音呈现）。 */
async function sendAndClose() {
  await send();
  panelOpen.value = false;
}

/** 打开主聊天窗口。 */
async function openMainWindow() {
  if (!tauriAvailable()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("show_main_window");
    panelOpen.value = false;
  } catch {
    /* 忽略 */
  }
}

// ---------- 语音朗读 + 口型同步 ----------
async function speak(text: string) {
  // 受设置面板的 TTS 总开关控制（与主窗口一致），关闭时不朗读
  if (!ttsEnabled.value || !pet || !tauriAvailable() || speaking) return;
  speaking = true;
  stopMouth?.();
  stopMouth = pet.startMouth();
  try {
    await speakText(text, ttsVoice.value);
  } catch {
    /* 忽略 */
  }
  const duration = Math.max(800, Math.min(text.length * 220, 20000));
  window.setTimeout(() => {
    speaking = false;
    stopMouth?.();
    stopMouth = null;
  }, duration);
}

// 助手最终消息到达时自动朗读
watch(
  () => messages.value,
  (list) => {
    const last = list[list.length - 1];
    if (last && last.kind === "assistant" && !last.streaming && last.content) {
      const prev = list[list.length - 2];
      // 只朗读新到达的最终消息（避免重放历史）
      if (!prev || prev.id !== last.id) {
        void speak(last.content);
      }
    }
  },
  { deep: true },
);

onMounted(async () => {
  console.log("[pet] mounted");
  connect();
  startAutoRefresh();
  void updateBubbleShift();
  // 窗口被拖动后位置会变化：定时重新检测偏移方向
  bubbleShiftTimer = window.setInterval(() => void updateBubbleShift(), 5000);
  try {
    if (modelHost.value) {
      // Live2D 懒加载：即使模型/渲染失败，页面主体仍可用
      const mod = await import("./live2d");
      pet = await mod.createPetModel(modelHost.value, PET_MIN_W);
      loading.value = false;
      console.log("[pet] model ready");
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
    loading.value = false;
    console.error("[pet] model load failed:", err);
  }
});

onBeforeUnmount(() => {
  if (bubbleShiftTimer !== null) window.clearInterval(bubbleShiftTimer);
  stopMouth?.();
  pet?.destroy();
  pet = null;
  hideBubbleNow();
});
</script>

<template>
  <div
    class="pet-root"
    :class="`drag-${dragState}`"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @contextmenu="onContextMenu"
  >
    <!-- Live2D 区域（气泡悬浮其上，不挤压模型） -->
    <div class="model-area" :class="{ loading }">
      <div ref="modelHost" class="model-host"></div>
      <div v-if="loading" class="loading-hint">加载桌宠…</div>
      <div v-if="loadError" class="load-error">模型加载失败：{{ loadError }}</div>
      <div v-if="runtimeErrors.length" class="runtime-errors">
        <div v-for="(e, i) in runtimeErrors.slice(-5)" :key="i">{{ e }}</div>
      </div>

      <!-- 头顶对话气泡：按窗口位置向侧边偏移，自然浮现/淡出 -->
      <Transition name="bubble">
        <div
          v-if="bubbleVisible && bubbleText"
          class="speech-bubble"
          :class="[bubbleKind, { 'shift-right': bubbleShift > 0, 'shift-left': bubbleShift < 0 }]"
          @pointerdown.stop
        >
          <span v-if="bubbleKind === 'user'" class="bubble-label">我</span>
          <span class="bubble-text">
            {{ bubbleText }}
            <span v-if="bubbleStreaming" class="cursor">▍</span>
          </span>
        </div>
      </Transition>
    </div>

    <!-- 连接状态（左上角小圆点，平时几乎不可见） -->
    <div class="conn-dot" :class="{ on: connected }" :title="connected ? '在线' : '离线'"></div>

    <!-- 提问卡片：小潜通过 ask_user_question 询问时出现 -->
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

    <!-- 交互面板：右键呼出 -->
    <Transition name="panel">
      <div v-if="panelOpen" class="interact-panel">
        <div class="panel-input-row">
          <input
            ref="panelInput"
            v-model="composer"
            type="text"
            :placeholder="canSend ? '和小潜说点什么…' : busy ? '小潜正在思考…' : '连接中…'"
            :disabled="!canSend"
            @keydown.enter="sendAndClose"
          />
          <button class="send-btn" :disabled="!canSend || !composer.trim()" @click="sendAndClose">
            <span v-if="busy">…</span>
            <span v-else>发</span>
          </button>
        </div>
        <div class="panel-actions">
          <button class="ghost-btn" @click="openMainWindow">主窗口</button>
          <button class="ghost-btn" @click="panelOpen = false">收起</button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.pet-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background: transparent;
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  overflow: hidden;
  cursor: default;
  user-select: none;
}
/* 长按拖动反馈：按住（未达阈值）→ 抓取手势；拖动中 → 握紧手势 */
.pet-root.drag-arming {
  cursor: grab;
}
.pet-root.drag-dragging {
  cursor: grabbing;
}

/* ---------- Live2D 区域 ---------- */
.model-area {
  position: relative;
  flex: 1;
  min-height: 0;
}
.model-host {
  position: absolute;
  inset: 0;
}
.model-host :deep(canvas) {
  width: 100%;
  height: 100%;
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

/* ---------- 头顶对话气泡 ---------- */
.speech-bubble {
  --bubble-x: -50%;
  position: absolute;
  top: 4%;
  left: 50%;
  max-width: min(52%, 300px);
  max-height: 32%;
  overflow-y: auto;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 14px;
  font-size: 12px;
  line-height: 1.55;
  word-break: break-word;
  white-space: pre-wrap;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
  z-index: 8;
  transform: translateX(var(--bubble-x));
  transition: transform 0.4s ease;
}
/* 窗口在屏幕右半：气泡贴左边缘（完全避开居中的模型头部） */
.speech-bubble.shift-left {
  left: 6px;
  --bubble-x: 0%;
  max-width: min(45%, 250px);
}
/* 窗口在屏幕左半：气泡贴右边缘 */
.speech-bubble.shift-right {
  left: auto;
  right: 6px;
  --bubble-x: 0%;
  max-width: min(45%, 250px);
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
  margin-top: 2px;
}
.bubble-text {
  flex: 1;
}
.cursor {
  color: #ffb07c;
  animation: pulse 0.9s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

/* 气泡浮现/淡出动画（水平位置随 --bubble-x 保持偏移） */
.bubble-enter-active,
.bubble-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.bubble-enter-from {
  opacity: 0;
  transform: translate(var(--bubble-x), -10px) scale(0.92);
}
.bubble-leave-to {
  opacity: 0;
  transform: translate(var(--bubble-x), -6px) scale(0.96);
}

/* ---------- 连接状态小圆点 ---------- */
.conn-dot {
  position: absolute;
  top: 6px;
  left: 6px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(255, 100, 100, 0.55);
  transition: background 0.3s ease;
  z-index: 12;
}
.conn-dot.on {
  background: rgba(120, 220, 140, 0.75);
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

/* ---------- 交互面板（右键呼出） ---------- */
/* 固定宽度（不随窗口扩展拉伸），始终居中于窗口底部 */
.interact-panel {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 8px;
  width: min(340px, calc(100vw - 20px));
  background: rgba(26, 27, 41, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  padding: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  z-index: 20;
}
.panel-input-row {
  display: flex;
  gap: 6px;
}
.panel-input-row input {
  flex: 1;
  background: #141420;
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
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  flex-shrink: 0;
}
.send-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.panel-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.ghost-btn {
  flex: 1;
  background: rgba(255, 255, 255, 0.06);
  color: #b9b5cf;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 6px 10px;
  font-size: 11px;
  cursor: pointer;
  font-family: inherit;
}
.ghost-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #e8e6f0;
}

.panel-enter-active,
.panel-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
/* 从下滑入/退出：translate 必须保留 -50% 水平居中修正——
   若被 translateY 单独覆盖，动画期间面板失去居中（left:50% 处右缘超出窗口），
   触发 WebView2 合成器对整棵渲染树（canvas/状态灯等）的瞬态重投影，
   表现为"整个容器左移又恢复"。 */
.panel-enter-from,
.panel-leave-to {
  opacity: 0;
  transform: translate(-50%, 14px);
}
</style>
