// 共享视图状态：浅层 ref + 显式 commit。
// 业务数据（会话、消息流）不进 store；这里只放跨条目共享、跨重挂载存活的
// 视图状态（选中项、草稿、面板宽度）。

import { computed, markRaw, shallowRef, triggerRef } from "vue";
import type { Store } from "../types";

export function defineStore<State extends object, Actions extends object>(
  init: () => State,
  setup: (state: State, commit: () => void) => Actions,
): Store<State, Actions> {
  const inner = shallowRef(markRaw(init()));
  const actions = setup(inner.value, () => triggerRef(inner));
  return {
    state: inner.value,
    actions,
    useStore: (selector) => computed(() => selector(inner.value)),
  };
}
