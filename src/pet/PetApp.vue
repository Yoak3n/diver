<script setup lang="ts">
// 桌宠窗口壳：布局装配。逻辑在 composables/，子组件在 components/。
import "./pet-app.css";
import "./pet-panel.css";
import "./pet-widgets.css";
import { computed, reactive, ref, watch } from "vue";
import { usePetChat } from "./usePetChat";
import { tauriAvailable } from "../tauri";
import { hasVisibleMessageBody } from "../markdown";
import { usePetModel } from "./composables/usePetModel";
import { useSpeechBubble } from "./composables/useSpeechBubble";
import { usePetDrag } from "./composables/usePetDrag";
import { usePetEmotion } from "./composables/usePetEmotion";
import { useClickthrough } from "./composables/useClickthrough";
import { useLipSync } from "./composables/useLipSync";
import { usePetQuestion } from "./composables/usePetQuestion";
import { usePetPanel } from "./composables/usePetPanel";
import { usePetLifecycle } from "./composables/usePetLifecycle";
import { useMessageReactions } from "./composables/useMessageReactions";
import PetChatPanel from "./components/PetChatPanel.vue";
import PetSpeechBubble from "./components/PetSpeechBubble.vue";
import PetModelPickerPanel from "./components/PetModelPickerPanel.vue";
import PetQuestionCard from "./components/PetQuestionCard.vue";
import PetDragCharge from "./components/PetDragCharge.vue";

const runtimeErrors = ref<string[]>([]);
let emotionMapReady = false;
const {
  messages, busy, connected, composer, attachments, isReady, canSend,
  addAttachments, removeAttachment, connect, send, startAutoRefresh,
  ttsVoice, pendingQuestion, submitQuestionAnswer,
} = usePetChat();

const click = useClickthrough({ getPet: () => petModel.getPet() });
const bubble = reactive(useSpeechBubble({
  onAfterLayout: () => {
    const m = click.getLastMouse();
    if (m) void click.applyClickthroughAt(m.x, m.y);
  },
}));
const panel = reactive(usePetPanel({
  onSideChange: (side) => {
    if (panel.panelOpen) petModel.getPet()?.setRetreat(true, side);
  },
  onPanelToggle: (open) => {
    applyRetreat();
    if (open) {
      bubble.hideBubbleNow();
      panel.scrollChatToBottom();
      panel.panelInput?.focus();
      void focusWindow();
    }
  },
  afterOpen: () => panel.scrollChatToBottom(),
}));

const modelHost = ref<HTMLElement | null>(null);
const petModel = reactive(usePetModel({
  getPanelOpen: () => panel.panelOpen,
  getBubbleSide: () => panel.bubbleSide,
  getBubbleVisible: () => bubble.bubbleVisible,
  layoutSpeechBubble: () => bubble.layoutSpeechBubble(),
}));
watch(modelHost, (el) => {
  petModel.modelHost = el;
}, { immediate: true });

const lip = useLipSync({
  getTtsVoice: () => ttsVoice.value || "",
  startMouth: () => petModel.getPet()?.startMouth() ?? null,
});
const emotion = usePetEmotion({
  getPet: () => petModel.getPet(),
  getProfile: () => petModel.currentProfile(),
  isSpeaking: () => lip.isSpeaking(),
  isMapReady: () => emotionMapReady,
});
const drag = reactive(usePetDrag({
  getPet: () => petModel.getPet(),
  inPanelArea: (t) =>
    !!(t instanceof HTMLElement && t.closest(".chat-flow, .speech-bubble, .question-card, .model-picker-panel")),
  onDragIdle: () => void panel.updateBubbleSide(),
}));
const question = reactive(usePetQuestion(pendingQuestion, submitQuestionAnswer));
const visibleMessages = computed(() => messages.value.filter(hasVisibleMessageBody));

function applyRetreat() {
  petModel.getPet()?.setRetreat(panel.panelOpen, panel.bubbleSide);
}
async function focusWindow() {
  if (!tauriAvailable()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFocus();
  } catch { /* 忽略 */ }
}
function openPanel() {
  panel.openPanel();
}
function openModelPicker() {
  panel.moreMenuOpen = false;
  petModel.modelPickerOpen = !petModel.modelPickerOpen;
}
function setComposer(v: string) {
  composer.value = v;
}
function setCustom(qId: string, v: string) {
  question.qCustoms[qId] = v;
}

useMessageReactions({
  messages,
  panelOpen: () => panel.panelOpen,
  scrollChatToBottom: () => panel.scrollChatToBottom(),
  onUserMessage: (c) => {
    emotion.reactToText(c);
    bubble.showBubble("user", c, 3500);
  },
  onAssistantStreaming: (c) => {
    bubble.clearBubbleTimer();
    bubble.showBubbleStreaming(c);
  },
  onAssistantDone: (c) => bubble.showBubble("assistant", c),
  reactToText: emotion.reactToText,
});
watch(() => panel.panelOpen, () => applyRetreat());

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

usePetLifecycle({
  connect,
  startAutoRefresh,
  updateBubbleSide: panel.updateBubbleSide,
  bindPetMovedListener: drag.bindPetMovedListener,
  initInteractionHold: drag.initInteractionHold,
  startSideTimer: panel.startSideTimer,
  startClickthrough: click.startClickthrough,
  bindTts: lip.bindTts,
  initModel: petModel.initModel,
  onExternalModelChange: petModel.onExternalModelChange,
  setMapReady: () => {
    emotionMapReady = true;
  },
  onModelError: (err) => {
    petModel.loadError = err instanceof Error ? err.message : String(err);
    petModel.loading = false;
    console.error("[pet] model load failed:", err);
  },
  disposePanel: panel.dispose,
  disposeDrag: drag.dispose,
  stopClickthrough: click.stopClickthrough,
  disposeLip: lip.dispose,
  destroyPet: petModel.destroyPet,
  hideBubble: bubble.hideBubbleNow,
});

function onContextMenu(e: MouseEvent) {
  if (e.target instanceof HTMLElement && e.target.closest(".chat-flow")) return;
  e.preventDefault();
  if (!panel.panelOpen) openPanel();
  else panel.closePanel();
}
</script>

<template>
  <div
    class="pet-root"
    :class="[`bubble-${panel.bubbleSide}`, `drag-${drag.dragState}`]"
    @pointerdown="drag.onPointerDown"
    @pointermove="drag.onPointerMove"
    @pointerup="drag.onPointerUp"
    @pointercancel="drag.onPointerCancel"
    @contextmenu="onContextMenu"
  >
    <PetDragCharge
      v-if="drag.dragState === 'arming' && drag.chargeUiVisible"
      :x="drag.chargePos.x"
      :y="drag.chargePos.y"
    />
    <div class="model-area" :class="{ loading: petModel.loading }">
      <div ref="modelHost" class="model-host"></div>
      <div v-if="petModel.loading" class="loading-hint">加载桌宠…</div>
      <div v-if="petModel.loadError" class="load-error">模型加载失败：{{ petModel.loadError }}</div>
      <div v-if="runtimeErrors.length" class="runtime-errors">
        <div v-for="(e, i) in runtimeErrors.slice(-5)" :key="i">{{ e }}</div>
      </div>
    </div>
    <div class="bubble-area">
      <Transition name="panel">
        <PetChatPanel
          v-if="panel.panelOpen"
          :messages="visibleMessages"
          :composer="composer"
          :attachments="attachments"
          :busy="busy"
          :is-ready="isReady"
          :can-send="canSend"
          :drag-over="panel.panelDragOver"
          :more-menu-open="panel.moreMenuOpen"
          :switching-model="petModel.switchingModel"
          @update:composer="setComposer"
          @send="send"
          @attach-input="panel.onAttachFileInput($event, addAttachments)"
          @paste="panel.onPanelPaste($event, addAttachments)"
          @drag-over="panel.onPanelDragOver"
          @drop="panel.onPanelDrop($event, addAttachments)"
          @leave-drag="panel.panelDragOver = false"
          @remove-attachment="removeAttachment"
          @toggle-more="panel.toggleMoreMenu"
          @open-model-picker="openModelPicker"
          @close-panel="panel.closePanelFromMenu"
        />
      </Transition>
      <Transition name="panel">
        <PetModelPickerPanel
          v-if="petModel.modelPickerOpen"
          :models="petModel.modelProfiles"
          :active-id="petModel.activeModelId"
          :switching="petModel.switchingModel"
          @select="petModel.switchModel"
          @close="petModel.modelPickerOpen = false"
        />
      </Transition>
    </div>
    <Transition name="bubble">
      <PetSpeechBubble
        v-if="!panel.panelOpen && bubble.bubbleVisible && bubble.bubbleText"
        :kind="bubble.bubbleKind"
        :text="bubble.bubbleText"
        :streaming="bubble.bubbleStreaming"
        :pos="bubble.bubblePos"
        @expand="openPanel"
        @close="bubble.hideBubbleNow"
        @enter="bubble.onBubbleEnter"
        @leave="bubble.onBubbleLeave"
      />
    </Transition>
    <div v-if="!connected" class="conn-dot" title="离线"></div>
    <Transition name="panel">
      <PetQuestionCard
        v-if="pendingQuestion"
        :questions="pendingQuestion.questions"
        :selections="question.qSelections"
        :customs="question.qCustoms"
        @toggle="question.toggleQOption"
        @update:custom="setCustom"
        @answer="question.answerPending"
      />
    </Transition>
  </div>
</template>
