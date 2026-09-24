// 存在感状态机运行时状态：轮询 PresenceSnapshot（L0 叶子 + 上下文）。
// 状态机在壳进程内自迁（EVAL 补发时间事件），UI 侧用轻量轮询即可覆盖展示。

import { computed, onBeforeUnmount, onMounted, ref, unref, type MaybeRef } from "vue";
import {
  getPresenceSnapshot,
  presencePhaseLabel,
  presenceRegimeLabel,
  type PresenceSnapshot,
} from "../ipc/presence";
import { tauriAvailable } from "../ipc/core";

type ActiveSource = MaybeRef<boolean> | (() => boolean);

const POLL_MS = 1500;

export function usePresenceStatus(active: ActiveSource = true) {
  const snapshot = ref<PresenceSnapshot | null>(null);
  const lastError = ref<string | null>(null);
  let timer = 0;

  const phase = computed(() => snapshot.value?.phase_name || snapshot.value?.phase || "");
  const phaseLabel = computed(() => (phase.value ? presencePhaseLabel(phase.value) : "—"));
  const regimeLabel = computed(() =>
    snapshot.value ? presenceRegimeLabel(snapshot.value.regime) : "—",
  );
  const enabled = computed(() => snapshot.value?.enabled ?? false);
  const userInputActive = computed(() => snapshot.value?.user_input_active ?? false);

  function isActive(): boolean {
    return typeof active === "function" ? active() : unref(active);
  }

  async function refresh() {
    if (!isActive() || !tauriAvailable()) return;
    try {
      const s = await getPresenceSnapshot();
      if (s) {
        snapshot.value = s;
        lastError.value = null;
      }
    } catch (e) {
      lastError.value = e instanceof Error ? e.message : String(e);
    }
  }

  function stopPolling() {
    if (timer) {
      window.clearInterval(timer);
      timer = 0;
    }
  }

  onMounted(() => {
    if (!tauriAvailable()) return;
    void refresh();
    // interval 常开；refresh 内判 isActive，便于后续激活再展示。
    timer = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
  });

  onBeforeUnmount(stopPolling);

  return {
    snapshot,
    lastError,
    phase,
    phaseLabel,
    regimeLabel,
    enabled,
    userInputActive,
    refresh,
  };
}
