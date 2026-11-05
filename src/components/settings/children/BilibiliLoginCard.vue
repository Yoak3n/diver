<script setup lang="ts">
// B 站扫码登录（只读）：只换取更完整的评论/字幕，不评论/点赞/私信。
// 凭据只落在 sidecar 的 COS_HOME（0600），本组件只拿状态，不接触 token。
import { computed, onMounted, onUnmounted, ref } from "vue";

import {
  getBilibiliStatusApi,
  logoutBilibiliApi,
  pollBilibiliQrApi,
  requestBilibiliQrApi,
  type BilibiliPollStatus,
  type BilibiliQr,
  type BilibiliStatus,
} from "../../../api/bilibili";

const status = ref<BilibiliStatus | null>(null);
const qr = ref<BilibiliQr | null>(null);
const pollState = ref<BilibiliPollStatus>("waiting");
const error = ref("");
const loading = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;
let deadline = 0;
let alive = true;

const pollHint = computed(() => {
  switch (pollState.value) {
    case "waiting":
      return "等待扫码…";
    case "scanned":
      return "已扫码，请在手机上确认";
    case "expired":
      return "二维码已过期，请重新获取";
    case "error":
      return "登录失败，请重试";
    default:
      return "";
  }
});

function stopPolling(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

async function refreshStatus(): Promise<void> {
  try {
    status.value = await getBilibiliStatusApi();
  } catch (err) {
    error.value = (err as Error)?.message ?? String(err);
  }
}

async function poll(): Promise<void> {
  if (!alive || qr.value === null) return;
  if (Date.now() > deadline) {
    pollState.value = "expired";
    stopPolling();
    return;
  }
  try {
    const res = await pollBilibiliQrApi(qr.value.key);
    if (!alive) return;
    pollState.value = res.status;
    if (res.status === "confirmed") {
      stopPolling();
      qr.value = null;
      status.value = {
        loggedIn: true,
        ...(res.name === undefined ? {} : { name: res.name }),
        ...(res.mid === undefined ? {} : { mid: res.mid }),
      };
      return;
    }
    if (res.status === "expired" || res.status === "error") {
      stopPolling();
      if (res.message !== undefined) error.value = res.message;
      return;
    }
    timer = setTimeout(() => {
      void poll();
    }, 2000);
  } catch (err) {
    error.value = (err as Error)?.message ?? String(err);
    stopPolling();
  }
}

async function startLogin(): Promise<void> {
  stopPolling();
  qr.value = null;
  error.value = "";
  loading.value = true;
  try {
    const data = await requestBilibiliQrApi();
    if (!alive) return;
    qr.value = data;
    pollState.value = "waiting";
    deadline = Date.now() + Math.max(60, data.expiresIn) * 1000;
    timer = setTimeout(() => {
      void poll();
    }, 2000);
  } catch (err) {
    error.value = (err as Error)?.message ?? String(err);
  } finally {
    loading.value = false;
  }
}

async function logout(): Promise<void> {
  stopPolling();
  qr.value = null;
  loading.value = true;
  try {
    await logoutBilibiliApi();
    status.value = { loggedIn: false };
    error.value = "";
  } catch (err) {
    error.value = (err as Error)?.message ?? String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refreshStatus();
});
onUnmounted(() => {
  alive = false;
  stopPolling();
});
</script>

<template>
  <section class="bili-login">
    <header class="head">
      <h3>B 站登录（只读）</h3>
      <span class="chip">{{ status?.loggedIn ? "已登录" : "未登录" }}</span>
    </header>

    <p v-if="status?.loggedIn" class="hint">
      登录为 <strong>{{ status.name || status.mid || "当前账号" }}</strong>。
      只用于更完整的评论与字幕；不会评论、点赞、私信或发动态。
      <span v-if="status.expired" class="warn">登录态可能已失效。</span>
    </p>
    <p v-else-if="status?.expired" class="hint warn">登录已失效，请重新扫码。</p>
    <p v-else-if="status" class="hint">
      登录 cookie（含自动续期凭据）只存本机 0600，用于读取评论/字幕与自动续期；失效会自动退回匿名并通知你，随时可退出。
    </p>

    <div v-if="qr" class="qr-box">
      <img :src="qr.qrDataUrl" alt="B 站登录二维码" width="180" height="180" />
      <p class="hint">{{ pollHint }}</p>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="actions">
      <button
        v-if="!status?.loggedIn"
        class="btn small"
        type="button"
        :disabled="loading"
        @click="startLogin"
      >
        {{ loading ? "获取二维码…" : qr ? "换一张二维码" : "扫码登录" }}
      </button>
      <button v-else class="btn small danger" type="button" :disabled="loading" @click="logout">
        退出登录
      </button>
    </div>
  </section>
</template>

<style scoped>
.bili-login {
  border: 1px solid var(--rule);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  background: var(--card, #fff);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.head h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-dim);
  letter-spacing: 0.04em;
}
.chip {
  font-size: 11px;
  color: var(--ink-soft);
  border: 1px solid var(--rule);
  border-radius: var(--radius-pill);
  padding: 2px 8px;
  background: var(--paper-sunken);
}
.qr-box {
  display: flex;
  align-items: center;
  gap: 12px;
}
.qr-box img {
  border: 1px solid var(--rule);
  border-radius: 6px;
  background: #fff;
}
.hint {
  font-size: 11px;
  color: var(--ink-dim);
  margin: 0;
  line-height: 1.6;
}
.warn {
  color: var(--warn, #b26a00);
}
.error {
  font-size: 11px;
  color: var(--danger, #c92a2a);
  margin: 0;
}
.actions {
  display: flex;
  gap: 8px;
}
</style>
