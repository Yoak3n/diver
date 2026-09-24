// 头顶对话气泡：自然浮现/淡出 + 定位。

import { nextTick, ref } from "vue";
import { markdownToPlainText } from "../../markdown";

export function useSpeechBubble(opts: {
  onAfterLayout: () => void;
}) {
  const bubbleText = ref("");
  const bubbleKind = ref<"user" | "assistant">("assistant");
  const bubbleVisible = ref(false);
  const bubbleStreaming = ref(false);
  const bubblePos = ref<{ left: number; top: number } | null>(null);

  let bubbleTimer: number | null = null;
  let bubbleHovering = false;

  function bubbleDuration(text: string): number {
    const chars = text.replace(/\s+/g, "").length;
    return Math.min(Math.max(3000, chars * 120), 12000);
  }

  function layoutSpeechBubble() {
    bubblePos.value = { left: 12, top: 12 };
  }

  function scheduleBubbleDismiss(ms: number) {
    if (bubbleTimer !== null) window.clearTimeout(bubbleTimer);
    bubbleTimer = window.setTimeout(() => {
      bubbleTimer = null;
      if (bubbleHovering) return;
      bubbleVisible.value = false;
      bubbleStreaming.value = false;
    }, ms);
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
      opts.onAfterLayout();
    });
  }

  function hideBubbleNow() {
    if (bubbleTimer !== null) window.clearTimeout(bubbleTimer);
    bubbleTimer = null;
    bubbleVisible.value = false;
    bubbleStreaming.value = false;
    bubbleHovering = false;
    void nextTick(() => {
      opts.onAfterLayout();
    });
  }

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

  /** 流式跟随显示，不启动停留计时。 */
  function showBubbleStreaming(text: string) {
    if (bubbleTimer !== null) window.clearTimeout(bubbleTimer);
    bubbleTimer = null;
    bubbleKind.value = "assistant";
    bubbleText.value = markdownToPlainText(text);
    bubbleVisible.value = true;
    bubbleStreaming.value = true;
    layoutSpeechBubble();
  }

  function clearBubbleTimer() {
    if (bubbleTimer !== null) {
      window.clearTimeout(bubbleTimer);
      bubbleTimer = null;
    }
  }

  return {
    bubbleText,
    bubbleKind,
    bubbleVisible,
    bubbleStreaming,
    bubblePos,
    layoutSpeechBubble,
    showBubble,
    hideBubbleNow,
    onBubbleEnter,
    onBubbleLeave,
    showBubbleStreaming,
    clearBubbleTimer,
  };
}
