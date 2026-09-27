<script setup lang="ts">
import { computed, ref } from "vue";
import type { ChatMessage, ToolActivity } from "../types";
import ThinkingBlock from "./ThinkingBlock.vue";
import AssistantAvatar from "./AssistantAvatar.vue";
import { renderMarkdownHtml } from "../markdown";
import { isImagePlaceholder } from "../composables/chat/echo";

const props = withDefaults(
  defineProps<{
    msg: ChatMessage;
    ttsVoice: string;
    tauri: boolean;
    /** 视图语境：群聊视图 = true（他方实例发言靠左、名字在气泡上方）；私聊 = false（与用户消息同侧靠右） */
    groupView?: boolean;
  }>(),
  { groupView: false },
);

defineEmits<{ speak: [msg: ChatMessage] }>();

const hasContent = computed(() => (props.msg.content ?? "").trim() !== "");
// 纯图片消息的「（图片）」占位只给模型上下文用，图已在气泡里，不重复渲染
const hideBody = computed(() => isImagePlaceholder(props.msg));
const contentHtml = computed(() => renderMarkdownHtml(props.msg.content ?? ""));
const hasThinking = computed(() => (props.msg.thinking ?? "") !== "");
// 静默痕迹在气泡层隐藏（拍板：UI 隐 + 可追溯）——完整记录仍在活动面板与会话日志。
const HIDDEN_TOOLS = new Set(["stay_silent"]);
const toolList = computed(() =>
  (props.msg.tools ?? []).filter((t) => !HIDDEN_TOOLS.has(t.name)),
);
const hasTools = computed(() => toolList.value.length > 0);
const metaOnly = computed(
  () =>
    !hasContent.value &&
    (props.msg.images?.length ?? 0) === 0 &&
    (hasThinking.value || hasTools.value),
);
const showBubble = computed(() => hasContent.value);
/** 他方实例的发言。展示按视图语境：群聊视图靠左、名字在气泡上方；私聊视图与用户消息同侧靠右。 */
const isPeer = computed(() => props.msg.origin === "peer");
const peerLeft = computed(() => isPeer.value && props.groupView);
const showSenderName = computed(() => {
  if (!props.groupView) return false;
  if (isPeer.value) return !!props.msg.from;
  // 群合并流里的 assistant 消息：按所属实例标注
  return props.msg.group === true && !!props.msg.from && props.msg.kind === "assistant";
});

/** 工具行展开态：key = callId ?? name#index */
const openTools = ref<Set<string>>(new Set());

function toolKey(t: ToolActivity, i: number): string {
  return t.callId ?? `${t.name}#${i}`;
}

function toggleTool(key: string) {
  const next = new Set(openTools.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  openTools.value = next;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function toolLabel(t: ToolActivity): string {
  if (t.status === "call") return "调用中";
  return t.isError ? "失败" : "完成";
}

function toolPreview(t: ToolActivity): string {
  const s = (t.summary ?? "").replace(/\s+/g, " ").trim();
  if (s === "") return "";
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function toolDetail(t: ToolActivity): string {
  return (t.summary ?? "").trim();
}
</script>

<template>
  <div
    class="msg-row"
    :data-mid="msg.id"
    :data-origin="msg.origin"
    :class="[
      msg.kind,
      {
        'meta-only': metaOnly,
        // 群聊视图：他方实例发言与其他 agent 消息统一靠左；私聊视图与用户消息同侧
        'from-peer': peerLeft,
      },
    ]"
  >
    <AssistantAvatar
      v-if="(msg.kind === 'assistant' || peerLeft) && !metaOnly"
      :size="26"
      variant="avatar"
      :instance-id="msg.fromId"
    />
    <div class="bubble-wrap" :class="{ 'with-thinking': hasThinking, 'with-tools': hasTools }">
      <div v-if="showSenderName" class="sender-name">{{ msg.from }}</div>
      <ThinkingBlock
        v-if="hasThinking"
        :text="msg.thinking!"
        :streaming="msg.thinkingStreaming"
      />
      <div v-if="hasTools" class="tool-records">
        <div
          v-for="(t, i) in toolList"
          :key="toolKey(t, i)"
          class="tool-record"
          :class="[t.status, { error: t.isError, open: openTools.has(toolKey(t, i)) }]"
        >
          <button
            class="tool-row"
            type="button"
            :title="toolDetail(t) ? '点击展开/收起结果' : undefined"
            @click="toggleTool(toolKey(t, i))"
          >
            <span class="tool-icon" aria-hidden="true">⚙</span>
            <span class="tool-name">{{ t.name }}</span>
            <span class="sep">·</span>
            <span class="tool-status">{{ toolLabel(t) }}</span>
            <span v-if="toolPreview(t)" class="sep">·</span>
            <span v-if="toolPreview(t)" class="tool-summary">{{ toolPreview(t) }}</span>
            <span v-if="toolDetail(t)" class="tool-chevron" :class="{ open: openTools.has(toolKey(t, i)) }">›</span>
          </button>
          <div v-if="openTools.has(toolKey(t, i)) && toolDetail(t)" class="tool-detail">
            <pre>{{ toolDetail(t) }}</pre>
          </div>
        </div>
      </div>
      <template v-if="showBubble || (msg.images?.length ?? 0) > 0">
        <div v-if="(msg.images?.length ?? 0) > 0" class="msg-images">
          <img
            v-for="(img, i) in msg.images"
            :key="i"
            class="msg-image"
            :src="`data:${img.mime};base64,${img.data}`"
            :alt="img.name || '图片'"
          />
        </div>
        <div v-if="showBubble" class="bubble" :class="{ streaming: msg.streaming }">
          <span v-if="msg.origin === 'presence'" class="origin-tag">主动</span>
          <span v-else-if="msg.origin === 'interaction'" class="origin-tag">互动</span>
          <span v-else-if="msg.origin === 'proactive'" class="origin-tag">主动</span>
          <!-- 私聊视图：他方实例的消息与用户消息同侧，用「来自 X」区分；群聊视图用气泡上方名字 -->
          <span v-else-if="isPeer && !groupView" class="origin-tag peer-tag">来自 {{ msg.from ?? "实例" }}</span>
          <div v-if="!hideBody" class="md-body" v-html="contentHtml"></div>
          <span v-if="msg.streaming" class="cursor">▍</span>
        </div>
        <div class="bubble-foot">
          <span class="time">{{ fmtTime(msg.time) }}</span>
          <button
            v-if="msg.kind === 'assistant' && msg.content && !msg.streaming"
            class="speak-btn"
            title="朗读"
            @click="$emit('speak', msg)"
          >
            朗读
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.msg-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  min-width: 0;
  max-width: 100%;
}
.msg-row.user {
  flex-direction: row-reverse;
}
/* 群/实例间来讯：kind 虽是 user，发言者是他方实例——与其他 agent 消息统一靠左。 */
.msg-row.user.from-peer {
  flex-direction: row;
}
.msg-row.system {
  justify-content: center;
}
.msg-row.system .bubble {
  background: transparent;
  border: none;
  color: var(--ink-dim);
  font-size: 12px;
  padding: 2px 8px;
}
.msg-row.meta-only .bubble-wrap {
  padding-left: 34px;
}
.bubble-wrap {
  max-width: 82%;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.bubble-wrap.with-thinking,
.bubble-wrap.with-tools {
  max-width: 100%;
  min-width: 0;
}
.bubble-wrap.with-thinking > *,
.bubble-wrap.with-tools > * {
  max-width: min(82%, 680px);
}
.msg-row.user .bubble-wrap {
  align-items: flex-end;
}
.msg-row.user.from-peer .bubble-wrap {
  align-items: flex-start;
}
.msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 6px;
}
.msg-row.user .msg-images {
  justify-content: flex-end;
}
.msg-row.user.from-peer .msg-images {
  justify-content: flex-start;
}
.msg-image {
  max-width: min(220px, 48vw);
  max-height: 180px;
  border-radius: var(--radius);
  border: 1px solid var(--rule);
  object-fit: contain;
  background: var(--paper-sunken);
  display: block;
}
/* 纸感：平面填色 + 细线，不用渐变气泡 */
.bubble {
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
}
.msg-row.assistant .bubble {
  background: var(--paper-raised);
  border: 1px solid var(--rule);
  border-radius: var(--radius-lg);
  color: var(--ink);
}
.msg-row.user .bubble {
  background: var(--user-fill);
  color: var(--user-ink);
  border: 1px solid transparent;
}
/* 他方实例来讯：气泡样式随 agent 消息（纸面浅起），来源由徽标注明。 */
.msg-row.user.from-peer .bubble {
  background: var(--paper-raised);
  border: 1px solid var(--rule);
  color: var(--ink);
}
.bubble.streaming {
  border-color: var(--rule-strong);
}
.cursor {
  color: var(--ink-dim);
  animation: pulse 0.9s ease infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
.origin-tag {
  display: inline-block;
  font-size: 10px;
  font-weight: 500;
  color: var(--ink-muted);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius-pill);
  padding: 0 7px;
  margin-right: 6px;
  vertical-align: 1px;
}
/* 群聊发言人名：气泡上方独立一行（头像右侧，QQ 式） */
.sender-name {
  font-size: 12px;
  line-height: 1.4;
  color: var(--ink-soft);
  padding: 0 2px 4px;
}
.peer-tag {
  color: #4080ff;
  border-color: rgba(64, 128, 255, 0.45);
  background: rgba(64, 128, 255, 0.08);
}
.tool-records {
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-muted);
}
.tool-record {
  min-width: 0;
}
.tool-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  width: 100%;
  padding: 4px 0;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.tool-icon {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ink-dim);
}
.tool-name {
  flex-shrink: 0;
  font-weight: 500;
  color: var(--ink-soft);
}
.tool-record .sep {
  flex-shrink: 0;
  color: var(--ink-faint);
}
.tool-status {
  flex-shrink: 0;
  color: var(--ink-dim);
}
.tool-record.call .tool-status {
  color: var(--warn);
}
.tool-record.error .tool-status {
  color: var(--err);
}
.tool-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-dim);
  flex: 1;
}
.tool-chevron {
  flex-shrink: 0;
  color: var(--ink-faint);
  transition: transform var(--dur-ui) var(--ease-out);
}
.tool-chevron.open {
  transform: rotate(90deg);
}
.tool-detail {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper-sunken);
  max-height: 240px;
  overflow: auto;
}
.tool-detail pre {
  margin: 0;
  font-family: ui-monospace, "Cascadia Code", "Consolas", monospace;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--ink-muted);
}
/* 步骤块（思考/工具）与正文气泡之间补一口气的间距：meta 行本身零外距，
   行距节奏全部由行内 padding 提供（4px 上/下），保证相邻行等距。 */
.bubble-wrap > .thinking-block + .bubble,
.bubble-wrap > .tool-records + .bubble {
  margin-top: 8px;
}
.bubble-foot {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 4px;
  padding: 0 2px;
}
.time {
  font-size: 11px;
  color: var(--ink-dim);
}
.speak-btn {
  background: none;
  border: none;
  color: var(--ink-dim);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
  font-family: inherit;
  transition:
    color var(--dur-hover) ease,
    transform var(--dur-press) var(--ease-out);
}
@media (hover: hover) and (pointer: fine) {
  .speak-btn:hover {
    color: var(--ink);
  }
}
.speak-btn:active {
  transform: scale(0.97);
}
/* 纸面印章式头像：墨色方章，无渐变 */
.avatar.small {
  width: 26px;
  height: 26px;
  font-size: 12px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: var(--paper);
  background: var(--ink);
  user-select: none;
  flex-shrink: 0;
  margin-top: 2px;
}
</style>
