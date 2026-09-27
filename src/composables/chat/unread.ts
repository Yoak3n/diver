// 未读计数（P2-3 待办收尾）：按会话（实例 id / `@group:<gid>`）跟踪「最后一条
// 消息」签名。签名变化、且最后一条是他人消息（助手/peer/系统）、且该会话
// 当前未在看 → 计 1；首次观测只记基线（历史加载/重连重取不因存量消息误报）；
// 切到会话即清零；会话消失（实例删除/群解散）随 observe 剪除。

import { ref, type Ref } from "vue";

/** 会话最后一条消息的观测信号。 */
export interface ConvSignal {
  /** 最后一条消息 id（签名；同 id 视为无新消息）。 */
  sid: string;
  /** 最后一条是他人消息（可计入未读）。 */
  incoming: boolean;
}

export type UnreadCounts = Record<string, number>;

/** 他人消息判定（实例行与群行共用）：自己的发言与本地合成的活动摘要不算。 */
export function isIncomingMessage(m: {
  origin: string;
  kind: string;
  group?: boolean;
}): boolean {
  return m.origin !== "user" && m.kind !== "activity-summary" && m.group !== true;
}

export function createUnreadTracker(currentId: Ref<string>) {
  const counts = ref<UnreadCounts>({});
  const seen = new Map<string, string>();

  /** 每轮把全部会话的最新信号喂进来；内部 diff 出增量。 */
  function observe(signals: Record<string, ConvSignal>) {
    for (const [conv, sig] of Object.entries(signals)) {
      const prev = seen.get(conv);
      seen.set(conv, sig.sid);
      if (prev === undefined || prev === sig.sid) continue;
      if (sig.incoming && conv !== currentId.value) {
        counts.value[conv] = (counts.value[conv] ?? 0) + 1;
      }
    }
    for (const conv of seen.keys()) {
      if (!(conv in signals)) {
        seen.delete(conv);
        delete counts.value[conv];
      }
    }
  }

  /** 查看会话：清零。 */
  function clear(conv: string) {
    if (counts.value[conv]) counts.value[conv] = 0;
  }

  return { counts, observe, clear };
}
