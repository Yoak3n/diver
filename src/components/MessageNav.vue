<script setup lang="ts">
// 聊天区「消息时间线」导航（右缘刻度轨，minimap 式）：
// 锚点 = 用户消息（轮次起点）；工具调用 / 思考 / 折叠摘要不是锚点，不占刻度。
// 当前阅读位置所处轮次的刻度高亮；悬停出正文预览气泡；点击跳到那轮对话。
// 刻度按固定间距 JS 定位（严格等距），轨道为垂直居中的紧凑小条，不随窗口拉伸。
import { computed } from "vue";
import type { ChatMessage } from "../types";

const props = defineProps<{
  visible: boolean;
  messages: ChatMessage[];
  /** 当前阅读位置所处轮次（user 消息 id，滚动同步，高亮用） */
  current: string | null;
}>();

const emit = defineEmits<{ jump: [id: string] }>();

/** 刻度定位键：与行上 data-mid 一致。 */
function midOf(m: ChatMessage): string {
  return m.activityGroupId ?? m.id;
}

/** 刻度宽窄反映消息体量（短消息细线、长提问宽线）。 */
function tickWidth(m: ChatMessage): string {
  const len = (m.content?.length ?? 0) + (m.images?.length ?? 0) * 120;
  if (len > 400) return "18px";
  if (len > 120) return "12px";
  return "7px";
}

/** 悬停预览：正文摘要；无正文给占位描述。 */
function excerpt(m: ChatMessage): string {
  const t = (m.content ?? "").replace(/\s+/g, " ").trim();
  if (t !== "") return t.length > 100 ? `${t.slice(0, 100)}…` : t;
  if ((m.images?.length ?? 0) > 0) return "（图片）";
  return "（无正文）";
}

// 锚点只认真人发言（origin=user）：群聊里他方实例的发言（peer）不是锚点，
// 实例回复 / 工具 / 思考同样不算——刻度只标「用户开的一轮」。
const MAX_TICKS = 36;
const anchors = computed<ChatMessage[]>(() => {
  const list = props.messages.filter((m) => m.kind === "user" && m.origin === "user");
  if (list.length <= MAX_TICKS) return list;
  // 超出容量等距抽样（保序，且始终包含当前刻度）
  const step = Math.ceil(list.length / MAX_TICKS);
  const out: ChatMessage[] = [];
  for (let i = 0; i < list.length; i += step) out.push(list[i]);
  if (out[out.length - 1] !== list[list.length - 1]) out.push(list[list.length - 1]);
  const cur = props.current;
  if (cur && !out.some((m) => midOf(m) === cur)) {
    const curIdx = list.findIndex((m) => midOf(m) === cur);
    const slot = out.findIndex((m) => list.indexOf(m) > curIdx);
    if (slot < 0) out.push(list[curIdx]);
    else out.splice(slot, 0, list[curIdx]);
  }
  return out;
});

// 固定间距，轨道高度随锚点数收缩（无锚点时不渲染）
const PITCH = 14;
const railH = computed(() => anchors.value.length * PITCH);
</script>

<template>
  <Transition name="msg-nav">
    <div v-if="visible && anchors.length > 0" class="msg-nav" role="navigation" aria-label="消息时间线">
      <div class="msg-rail" :style="{ height: railH + 'px' }">
        <button
          v-for="(m, i) in anchors"
          :key="midOf(m)"
          type="button"
          class="msg-tick"
          :class="{ active: midOf(m) === current }"
          :style="{ width: tickWidth(m), top: i * PITCH + 'px' }"
          :aria-label="excerpt(m)"
          @click="emit('jump', midOf(m))"
        >
          <span class="msg-tick-tip">{{ excerpt(m) }}</span>
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.msg-nav {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 6;
  pointer-events: none;
}
.msg-rail {
  position: relative;
  width: 18px;
  pointer-events: auto;
}
.msg-tick {
  position: absolute;
  right: 0;
  height: 12px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: flex-end;
}
.msg-tick::before {
  content: "";
  display: block;
  width: 100%;
  height: 2px;
  border-radius: 1px;
  background: var(--ink-dim);
  opacity: 0.55;
  transition:
    background var(--dur-hover) ease,
    opacity var(--dur-hover) ease;
}
.msg-tick:hover::before {
  opacity: 1;
}
.msg-tick.active::before {
  background: var(--ink);
  opacity: 1;
  height: 3px;
}
/* 悬停预览气泡：刻度左侧（深色小气泡 + 正文摘要） */
.msg-tick-tip {
  position: absolute;
  right: 20px;
  top: 50%;
  transform: translateY(-50%);
  width: max-content;
  max-width: 240px;
  padding: 8px 11px;
  border-radius: 10px;
  background: rgba(42, 39, 64, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #e9e6f4;
  font-size: 12px;
  line-height: 1.55;
  text-align: left;
  white-space: normal;
  word-break: break-word;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-ui) var(--ease-out);
  z-index: 7;
}
@media (hover: hover) and (pointer: fine) {
  .msg-tick:hover .msg-tick-tip {
    opacity: 1;
  }
}

.msg-nav-enter-active,
.msg-nav-leave-active {
  transition: opacity var(--dur-ui) var(--ease-out);
}
.msg-nav-enter-from,
.msg-nav-leave-to {
  opacity: 0;
}
</style>
