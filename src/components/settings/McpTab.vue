<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { SettingsState } from "../../composables/useSettings";
import { getMcpConfig, saveMcpConfig, tauriAvailable, type McpConfig } from "../../tauri";

defineProps<{
  state: SettingsState;
}>();

defineEmits<{
  restart: [];
}>();

/** 配置文件读取失败等本地状态（不走全局 save 流程）。 */
const localError = ref("");
const saving = ref(false);
const savedMsg = ref("");
const configText = ref("");

/** 把当前 JSON 文本渲染成文本域内容。 */
function render(config: unknown): string {
  try {
    return JSON.stringify(config, null, 2);
  } catch {
    return "";
  }
}

onMounted(async () => {
  if (!tauriAvailable()) {
    localError.value = "当前不在 Tauri 环境中，无法读取 MCP 配置";
    return;
  }
  try {
    const cfg = await getMcpConfig();
    configText.value = render(cfg);
  } catch (err) {
    localError.value = err instanceof Error ? err.message : String(err);
  }
});

/** 解析文本域内容并回写；语法错误时本地报错不落盘。 */
async function handleSave(): Promise<void> {
  localError.value = "";
  savedMsg.value = "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText.value);
  } catch (err) {
    localError.value = `JSON 语法错误：${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { servers?: unknown }).servers)
  ) {
    localError.value = "配置必须是 { \"servers\": [...] } 结构";
    return;
  }
  saving.value = true;
  try {
    const ok = await saveMcpConfig(parsed as McpConfig);
    if (!ok) {
      localError.value = "保存失败，请查看应用日志";
      return;
    }
    savedMsg.value = "已保存 — 新配置将自动热重载生效";
  } catch (err) {
    localError.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <label class="group-title">MCP 服务配置</label>
  <p class="hint">
    在此直接编辑 MCP 配置文件（JSON），决定 sidecar 连接哪些外部 MCP 服务。
    保存后自动热重载生效，无需重启。格式：
    <code>{ "servers": [ { "serverName": "...", "command": "..." } ] }</code>
  </p>
  <textarea
    v-model="configText"
    class="mcp-editor"
    spellcheck="false"
    :disabled="!tauriAvailable() || saving"
  ></textarea>
  <div v-if="savedMsg" class="ok-msg">{{ savedMsg }}</div>
  <div v-if="localError" class="error-msg">{{ localError }}</div>
  <div class="mcp-actions">
    <button class="btn small" :disabled="!tauriAvailable() || saving" @click="handleSave">
      {{ saving ? "保存中…" : "保存 MCP 配置" }}
    </button>
    <button v-if="tauriAvailable()" class="btn small" @click="$emit('restart')">重启 Sidecar</button>
  </div>
</template>

<style scoped>
.group-title {
  display: block;
  font-size: 12px;
  color: #8d89a1;
  letter-spacing: 1px;
  margin-top: 4px;
}
.hint {
  font-size: 11px;
  color: #6f6b85;
  margin: 0;
  line-height: 1.7;
}
.hint code {
  color: #9a96ad;
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 4px;
  border-radius: 4px;
}
.mcp-editor {
  width: 100%;
  min-height: 220px;
  background: #141420;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: #e8e6f0;
  font-family: "Cascadia Code", Consolas, "Courier New", monospace;
  font-size: 12px;
  line-height: 1.5;
  padding: 10px;
  resize: vertical;
  box-sizing: border-box;
  margin-top: 8px;
}
.mcp-editor:disabled {
  opacity: 0.5;
}
.mcp-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.btn.small {
  padding: 5px 14px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #e8e6f0;
  border-radius: 10px;
  cursor: pointer;
  font-family: inherit;
}
.btn.small:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
}
.btn.small:disabled {
  opacity: 0.5;
  cursor: default;
}
.ok-msg {
  color: #59d99a;
  font-size: 12px;
  margin-top: 8px;
}
.error-msg {
  color: #e8a3a3;
  font-size: 12px;
  margin-top: 8px;
  word-break: break-all;
}
</style>
