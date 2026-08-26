<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { usePetChat } from "./usePetChat";
import { inferEmotion, loadEmotionMap, motionGroupsFor } from "./emotion";
import type { PetEmotion } from "./emotion";
import { speakText, tauriAvailable, getCursorScreenPoint, listMonitors, movePetToMonitor } from "../tauri";
import type { MonitorInfo } from "../tauri";
import type { PetModelHandle } from "./live2d";

const modelHost = ref<HTMLElement | null>(null);
const panelInput = ref<HTMLInputElement | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const runtimeErrors = ref<string[]>([]);
let pet: PetModelHandle | null = null;
let stopMouth: (() => void) | null = null;
let speaking = false;

// ---------- 转移到指定屏幕（多屏场景下替代拖动限位，无跨屏闪动） ----------
const monitors = ref<MonitorInfo[]>([]);
const monitorMenuOpen = ref(false);

async function toggleMonitorMenu() {
  monitorMenuOpen.value = !monitorMenuOpen.value;
  if (monitorMenuOpen.value && monitors.value.length === 0) {
    monitors.value = await listMonitors();
  }
}

async function moveToMonitor(index: number) {
  await movePetToMonitor(index);
  monitorMenuOpen.value = false;
}

/** ⋯ 菜单里的"收起面板"：关闭面板 + 菜单。 */
function closePanelFromMenu() {
  monitorMenuOpen.value = false;
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

// ---------- 布局：模型全屏 + 消息流悬浮面板 ----------
// 模型占满窗口（居中），消息流面板悬浮在窗口一侧（宽 ~383px）。
// 面板在屏幕中心一侧（bubbleSide）：窗口在屏幕左半 → 面板在右；右半 → 面板在左。
// 面板打开时模型缩小让位（setRetreat），避免遮挡；关闭时恢复。
/** 模型高度占窗口高度的比例（0.8 = 占 80%）。
 *  配合窗口高 560：模型 ≈ 448px，与之前 640×0.7 相同 —— 窗口变小但模型不缩水。 */
const MODEL_HEIGHT_RATIO = 0.8;
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
  } catch {
    // 检测失败时默认面板在右
    bubbleSide.value = "right";
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
  bubbleKind.value = kind;
  bubbleText.value = text;
  bubbleVisible.value = true;
  bubbleStreaming.value = false;
  bubbleTimer = window.setTimeout(() => {
    bubbleVisible.value = false;
  }, holdMs ?? bubbleDuration(text));
}

function hideBubbleNow() {
  if (bubbleTimer !== null) window.clearTimeout(bubbleTimer);
  bubbleVisible.value = false;
  bubbleStreaming.value = false;
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
        bubbleKind.value = "assistant";
        bubbleText.value = last.content;
        bubbleVisible.value = true;
        bubbleStreaming.value = true;
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
  return !!(target instanceof HTMLElement && target.closest(".chat-flow, .speech-bubble, .question-card"));
}

async function beginDrag() {
  if (!tauriAvailable()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    // startDragging 是异步系统拖动：发送拖动消息后立即返回（不代表拖动结束）。
    // 拖动结束后按最新窗口位置刷新面板方向 —— 若面板开着且方向变化，
    // 立即让模型换边（避免面板遮住模型）；3 秒定时器兜底。
    await getCurrentWindow().startDragging();
    window.setTimeout(() => void updateBubbleSide(), 350);
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
    // 短按 → 互动（播放随机动作，force 优先级：可打断正在播放的情绪动作）
    pet.playEmotion("TapBody", { priority: "force" });
  }
}

function onPointerCancel() {
  clearPressTimer();
  longPressDragging = false;
  dragState.value = "idle";
}

/** 右键：呼出/收起交互面板（输入框常态隐藏）。 */
function onContextMenu(e: MouseEvent) {
  if (e.target instanceof HTMLElement && e.target.closest(".chat-flow")) {
    return; // 面板内保留原生菜单（如粘贴）
  }
  e.preventDefault();
  // 呼出前先按最新窗口位置刷新面板方向（防止窗口贴屏幕边缘时
  // 让位方向把模型挤出屏幕外）
  if (!panelOpen.value) {
    void updateBubbleSide().then(() => {
      panelOpen.value = true;
      void nextTick(() => {
        scrollChatToBottom();
        panelInput.value?.focus();
        void focusWindow();
      });
    });
    return;
  }
  panelOpen.value = false;
}

/** 消息流滚动到底部（最新消息）。 */
function scrollChatToBottom() {
  const el = chatMessagesRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

// 面板打开 → 模型缩小让位（偏到面板对侧）+ 滚到最新消息；关闭 → 模型恢复
watch(panelOpen, (open) => {
  pet?.setRetreat(open, bubbleSide.value);
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

// ---------- 聊天内容 → 情绪 → Live2D 动作 ----------
// 借鉴 N.E.K.O：对聊天气泡文本做轻量情绪推断，触发对应动作组
// （Happy/Sad/Angry/Surprised/Shy/Nod/Wave...）。纯前端启发式，零延迟。
let emotionMapReady = false;
/** 上次情绪动作触发时刻（避免连续消息触发过密）。 */
let lastEmotionAt = 0;
const EMOTION_MIN_INTERVAL_MS = 2500;

/** 情绪→动作触发：推断文本情绪并播放对应动作组（随机选一组）。 */
function reactToText(text: string) {
  if (!pet || !emotionMapReady) return;
  const now = performance.now();
  if (now - lastEmotionAt < EMOTION_MIN_INTERVAL_MS) return;
  // 朗读期间不触发大动作（避免动作与口型/声音打架）
  if (speaking) return;
  const emotion: PetEmotion = inferEmotion(text);
  if (emotion === "neutral") return;
  const groups = motionGroupsFor(emotion);
  if (!groups.length || groups[0] === "Idle") return;
  pet.playEmotion(groups[Math.floor(Math.random() * groups.length)]);
  lastEmotionAt = now;
}

/** 用户消息到达：先推断情绪并触发动作，再显示气泡。 */
function onUserMessage(content: string) {
  reactToText(content);
  showBubble("user", content, 3500);
}

/** 助手消息完成：朗读 + 根据助手内容触发情绪动作（如安慰、开心回应）。 */
function onAssistantDone(content: string) {
  reactToText(content);
  void speak(content);
}

// ---------- 点击穿透：默认穿透，命中可交互区则解除 ----------
// 原理参考 N.E.K.O：透明窗口不应挡鼠标。窗口默认 setIgnoreCursorEvents(true)，
// 前端以低频轮询（~80ms）读取全局鼠标坐标，换算到窗口内 client 坐标后，
// 用 elementFromPoint 检测命中可交互元素（模型 canvas / 气泡 / 面板 / 提问卡片）；
// 命中则解除穿透（可交互），否则保持穿透。轮询始终运行（不能只在穿透态跑，
// 否则鼠标离开交互区后无法恢复穿透），但坐标不变时跳过窗口查询，静止开销趋近于零。
const CLICKTHROUGH_POLL_MS = 80;
/** 穿透轮询句柄 */
let clickthroughTimer: number | null = null;
/** 最近一次穿透态（避免重复 IPC） */
let clickthroughActive = true;
/** 最近一次鼠标坐标（去重用） */
let lastCursor = { x: -1, y: -1 };

/** 命中可交互区域 → 不需要穿透 */
function isInteractiveAt(clientX: number, clientY: number): boolean {
  try {
    const el = document.elementFromPoint(clientX, clientY);
    if (!el) return false;
    return !!(
      el.closest(".pet-root .interactive") ||
      el.closest(".speech-bubble") ||
      el.closest(".chat-flow") ||
      el.closest(".question-card")
    );
  } catch {
    return false;
  }
}

async function applyClickthrough() {
  const p = await getCursorScreenPoint();
  if (!p) return;
  if (p.x === lastCursor.x && p.y === lastCursor.y) return; // 鼠标静止：跳过
  lastCursor = p;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    // 屏幕物理坐标 → 窗口内 client（CSS）坐标
    const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
    const dpr = window.devicePixelRatio || 1;
    const clientX = (p.x - pos.x) / dpr;
    const clientY = (p.y - pos.y) / dpr;
    // 鼠标不在窗口内 → 保持穿透
    if (clientX < 0 || clientY < 0 || clientX >= size.width / dpr || clientY >= size.height / dpr) {
      if (!clickthroughActive) {
        clickthroughActive = true;
        await win.setIgnoreCursorEvents(true);
      }
      return;
    }
    const wantIgnore = !isInteractiveAt(clientX, clientY);
    if (wantIgnore === clickthroughActive) return; // 状态无变化
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
    // 初始置为穿透态（透明窗口不挡鼠标）。
    // 注：Tauri 2 的 setIgnoreCursorEvents 在 Windows 是 WS_EX_TRANSPARENT，
    // 鼠标事件仍可能进入 webview —— 所以 CSS 侧另有 pointer-events 双保险
    // （.pet-root 默认 none，可交互区 opt-in auto），穿透态下透明区不响应。
    clickthroughActive = true;
    await getCurrentWindow().setIgnoreCursorEvents(true);
  } catch {
    /* 忽略 */
  }
  if (clickthroughTimer !== null) window.clearInterval(clickthroughTimer);
  clickthroughTimer = window.setInterval(() => void applyClickthrough(), CLICKTHROUGH_POLL_MS);
}

function stopClickthrough() {
  if (clickthroughTimer !== null) {
    window.clearInterval(clickthroughTimer);
    clickthroughTimer = null;
  }
  clickthroughActive = true;
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

// 助手最终消息到达时自动朗读（历史加载/重启恢复的消息不朗读，避免重放）
// 注：朗读 + 情绪动作统一由 onAssistantDone 触发（在消息流 watch 中调用），
// 这里不再重复监听，避免双重朗读。
onMounted(async () => {
  console.log("[pet] mounted");
  connect();
  startAutoRefresh();
  void updateBubbleSide();
  // 窗口被拖动后位置会变化：定时重新检测气泡区方向 + 模型偏置
  bubbleSideTimer = window.setInterval(() => void updateBubbleSide(), 3000);
  void startClickthrough();
  try {
    if (modelHost.value) {
      // Live2D 懒加载：即使模型/渲染失败，页面主体仍可用
      const mod = await import("./live2d");
      pet = await mod.createPetModel(modelHost.value, {
        heightRatio: MODEL_HEIGHT_RATIO,
        anchorXRatio: 0.5, // 模型全屏居中
      });
      loading.value = false;
      console.log("[pet] model ready");
      // 情绪映射（聊天气泡 → 动作）懒加载；失败时回退内置缺省表
      try {
        await loadEmotionMap();
      } finally {
        emotionMapReady = true;
      }
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
    loading.value = false;
    console.error("[pet] model load failed:", err);
  }
});

onBeforeUnmount(() => {
  if (bubbleSideTimer !== null) window.clearInterval(bubbleSideTimer);
  stopClickthrough();
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
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @contextmenu="onContextMenu"
  >
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
        <div v-if="panelOpen" class="chat-flow" @pointerdown.stop>
          <!-- 消息流：透明背景，可滚动回看历史 -->
          <div ref="chatMessagesRef" class="chat-messages">
            <div
              v-for="(m, i) in messages"
              :key="m.id + '-' + i"
              class="chat-msg"
              :class="[m.kind, { streaming: m.streaming }]"
            >
              <span v-if="m.kind === 'user'" class="msg-label">我</span>
              <span v-else class="msg-label">✦</span>
              <span class="msg-text">
                {{ m.content }}
                <span v-if="m.streaming" class="cursor">▍</span>
              </span>
            </div>
            <div v-if="!messages.length" class="chat-empty">说点什么吧…</div>
          </div>
          <!-- 输入行 -->
          <div class="panel-input-row">
            <input
              ref="panelInput"
              v-model="composer"
              type="text"
              :placeholder="canSend ? '说点什么吧…' : busy ? '正在思考…' : '连接中…'"
              :disabled="!canSend"
              @keydown.enter="sendAndClose"
            />
            <button
              class="send-btn"
              :class="{ busy }"
              :disabled="!canSend || !composer.trim()"
              :title="busy ? '正在思考…' : '发送'"
              @click="sendAndClose"
            >
              <svg v-if="!busy" class="send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 2 11 13" />
                <path d="M22 2 15 22 11 13 2 9 22 2Z" />
              </svg>
              <span v-else class="busy-dots">…</span>
            </button>
            <!-- ⋯ 菜单：低频操作收纳在此，面板保持简洁 -->
            <div class="more-menu-wrap">
              <button class="more-btn" title="更多" @click="toggleMonitorMenu">⋯</button>
              <Transition name="panel">
                <div v-if="monitorMenuOpen" class="more-menu">
                  <button class="more-opt" @click="closePanelFromMenu">收起面板</button>
                  <div class="more-divider"></div>
                  <div v-for="(m, i) in monitors" :key="i">
                    <button class="more-opt" @click="moveToMonitor(i)">
                      转到屏幕 {{ i + 1 }}{{ m.name ? ` · ${m.name}` : "" }}
                    </button>
                  </div>
                  <div v-if="!monitors.length" class="monitor-empty">未检测到显示器</div>
                </div>
              </Transition>
            </div>
          </div>
        </div>
      </Transition>
      <!-- 常态气泡：面板关闭时，新消息仍以短暂气泡提示 -->
      <Transition name="bubble">
        <div
          v-if="!panelOpen && bubbleVisible && bubbleText"
          class="speech-bubble"
          :class="bubbleKind"
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
/* 长按拖动反馈：按住（未达阈值）→ 抓取手势；拖动中 → 握紧手势 */
.pet-root.drag-arming {
  cursor: grab;
}
.pet-root.drag-dragging {
  cursor: grabbing;
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

/* ---------- Live2D 模型区（全屏） ---------- */
.model-area {
  position: relative;
  min-height: 0;
  overflow: hidden;
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
  white-space: pre-wrap;
  padding: 6px 10px;
  border-radius: 12px;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
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
}
.chat-empty {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.35);
  text-align: center;
  padding: 24px 0;
}

/* 常态短暂气泡（面板关闭时新消息提示） */
.speech-bubble {
  position: absolute;
  top: 8px;
  left: 8px;
  right: 8px;
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
  z-index: 8;
  max-height: calc(100% - 16px);
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.15) transparent;
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

/* 气泡浮现/淡出动画 */
.bubble-enter-active,
.bubble-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.bubble-enter-from {
  opacity: 0;
  transform: translateY(-10px) scale(0.92);
}
.bubble-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.96);
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
.panel-input-row {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
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
/* ---------- ⋯ 菜单（收起/转移屏幕等低频操作收纳） ---------- */
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
}
.more-opt:hover {
  background: rgba(255, 176, 124, 0.15);
  color: #ffe3c4;
}
.more-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.08);
  margin: 3px 4px;
}
.monitor-empty {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  padding: 8px;
  text-align: center;
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
     scoped 的 data-v 属性选择器无法可靠作用于 PIXI 运行时创建的 canvas
     和 Transition 动画包装节点，因此这条规则必须全局生效。 -->
<style>
.pet-root .interactive,
.pet-root .speech-bubble,
.pet-root .chat-flow,
.pet-root .question-card,
.pet-root .conn-dot {
  pointer-events: auto;
}
</style>
