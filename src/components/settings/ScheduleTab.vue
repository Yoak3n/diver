<script setup lang="ts">
// 日程提醒设置页：presence 主动问候的持久化配置（$COS_HOME/presence-schedule.json）。
// 到点 agent 主动发起问候，并弹原生通知；保存后热生效，无需重启。
import { onMounted, ref } from "vue";
import {
  getPresenceApi,
  savePresenceApi,
  type PresenceEntry,
} from "../../api";
import { tauriAvailable } from "../../tauri";

const entries = ref<PresenceEntry[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const hint = ref("");

// 新增表单
const newTime = ref("09:00");
const newPrompt = ref("");
const adding = ref(false);

async function refresh() {
  if (!tauriAvailable()) return;
  loading.value = true;
  error.value = "";
  try {
    const cfg = await getPresenceApi();
    entries.value = cfg.entries ?? [];
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (saving.value) return;
  saving.value = true;
  error.value = "";
  hint.value = "";
  try {
    const cfg = await savePresenceApi(entries.value);
    entries.value = cfg.entries ?? [];
    hint.value = "已保存，到点自动提醒（无需重启）";
  } catch (e) {
    error.value = String(e);
  } finally {
    saving.value = false;
  }
}

async function onAdd() {
  const prompt = newPrompt.value.trim();
  const time = newTime.value.trim();
  if (!prompt || !time || adding.value) return;
  adding.value = true;
  error.value = "";
  hint.value = "";
  try {
    entries.value.push({
      id: `s-${Date.now().toString(36)}`,
      time,
      prompt,
      enabled: true,
    });
    entries.value = [...entries.value];
    newPrompt.value = "";
    await save();
  } catch (e) {
    error.value = String(e);
  } finally {
    adding.value = false;
  }
}

function onRemove(index: number) {
  entries.value.splice(index, 1);
  entries.value = [...entries.value];
  void save();
}

onMounted(refresh);
</script>

<template>
  <p class="hint">
    到点 agent 会主动发起问候（聊天区显示为系统消息）并弹原生通知。保存后
    <b>立即生效</b>；时间格式 <code>HH:mm</code>（24 小时制，本地时区）。
  </p>

  <div v-if="loading && !entries.length" class="hint">加载中…</div>
  <div v-else-if="!tauriAvailable()" class="hint">不在 Tauri 环境，日程提醒不可用。</div>

  <div v-else class="entry-list">
    <div v-for="(e, i) in entries" :key="e.id" class="entry-row">
      <input
        class="time-input"
        type="time"
        :value="e.time"
        :disabled="saving"
        @change="e.time = ($event.target as HTMLInputElement).value"
      />
      <input
        class="prompt-input"
        :value="e.prompt"
        :disabled="saving"
        placeholder="提醒内容，如：该休息一下啦"
        @change="e.prompt = ($event.target as HTMLInputElement).value"
      />
      <label class="switch" :title="e.enabled ? '点击停用' : '点击启用'">
        <input
          type="checkbox"
          :checked="e.enabled"
          :disabled="saving"
          @change="e.enabled = ($event.target as HTMLInputElement).checked"
        />
        <span class="slider"></span>
      </label>
      <button class="btn small" :disabled="saving" @click="onRemove(i)">移除</button>
    </div>

    <div v-if="!entries.length" class="empty">暂无日程，添加一条开始。</div>
  </div>

  <div class="toolbar">
    <input v-model="newTime" class="time-input" type="time" />
    <input
      v-model="newPrompt"
      class="prompt-input"
      placeholder="提醒内容，如：记得喝水"
      @keyup.enter="onAdd"
    />
    <button class="btn small" :disabled="adding || !newPrompt.trim() || !newTime" @click="onAdd">
      新增
    </button>
  </div>

  <div v-if="entries.length" class="save-row">
    <button class="btn small primary" :disabled="saving" @click="save">
      {{ saving ? "保存中…" : "保存日程" }}
    </button>
  </div>

  <p v-if="hint" class="ok-msg">{{ hint }}</p>
  <p v-if="error" class="error-msg">{{ error }}</p>
</template>

<style scoped>
.entry-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.entry-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
}
.time-input {
  width: 86px;
  flex-shrink: 0;
  box-sizing: border-box;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  color: #eee;
  font-size: 13px;
  padding: 4px 8px;
  font-family: inherit;
  color-scheme: dark;
}
.prompt-input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: #eee;
  font-size: 13px;
  padding: 4px 8px;
  outline: none;
}
.prompt-input:focus {
  border-color: rgba(255, 255, 255, 0.25);
  background: rgba(255, 255, 255, 0.05);
}
.toolbar {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.save-row {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
}
.empty {
  font-size: 12px;
  opacity: 0.55;
  padding: 8px 0;
}
.hint {
  font-size: 12px;
  opacity: 0.65;
  line-height: 1.45;
  margin: 0 0 8px;
}
.error-msg {
  color: #f0a0a0;
  font-size: 12px;
  margin-top: 8px;
}
.ok-msg {
  color: #9dcea0;
  font-size: 12px;
  margin-top: 8px;
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  opacity: 0.9;
}
.switch {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 22px;
  flex-shrink: 0;
  margin-top: 2px;
}
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 999px;
  transition: 0.15s;
}
.slider:before {
  position: absolute;
  content: "";
  height: 16px;
  width: 16px;
  left: 3px;
  bottom: 3px;
  background: #ddd;
  border-radius: 50%;
  transition: 0.15s;
}
.switch input:checked + .slider {
  background: #6b8cce;
}
.switch input:checked + .slider:before {
  transform: translateX(18px);
}
.switch input:disabled + .slider {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn.small {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: #ddd;
  cursor: pointer;
}
.btn.small:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn.small.primary {
  background: linear-gradient(135deg, #ff9d6c, #c06ab3);
  border: none;
  color: #fff;
  font-weight: 600;
}
</style>
