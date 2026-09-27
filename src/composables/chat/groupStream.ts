// 群聊合并流（P2-3/P2-4）：跨实例会话池里挂 group 标的流量合并 + 按群分桶。
// 群视图与侧栏群行（预览/未读）共用同一份计算；纯私聊流量（含实例间私聊）不进群流。
// 同一消息的多实例副本按归属群+内容+来源+3s 时间窗去重。

import { computed } from "vue";
import { getChat } from "./index";
import { useInstances } from "../useInstances";
import type { ChatMessage } from "../../types";

export function createGroupStream() {
  const instancesState = useInstances();

  const nameOf = computed<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const m of instancesState.instances.value) {
      map[m.id] = m.name?.trim() || m.id;
    }
    return map;
  });

  const mergedMessages = computed<ChatMessage[]>(() => {
    const items: ChatMessage[] = [];
    for (const m of instancesState.instances.value) {
      const c = getChat(m.id);
      if (!c) continue;
      for (const msg of c.messages.value) {
        if (msg.group !== true) continue;
        const withGroup = { ...msg, groupId: msg.groupId ?? "general" };
        if (msg.origin === "peer" && msg.from) {
          items.push({ ...withGroup, from: nameOf.value[msg.from] ?? msg.from, fromId: msg.from });
        } else if (msg.kind === "assistant") {
          items.push({ ...withGroup, from: nameOf.value[m.id] ?? m.id, fromId: m.id });
        } else {
          items.push({ ...withGroup });
        }
      }
    }
    items.sort((a, b) => a.time - b.time);
    const out: ChatMessage[] = [];
    for (const m of items) {
      // 同 id = 同一条群消息的多实例副本（发送方落账 / 用户广播 fan-out / 各收方
      // 领取的注入副本共享 clientMsgId）：只留一条。成员忙时领取时间可差几分钟，
      // 时间窗去重靠不住，id 对账跨来源生效。
      if (out.some((k) => k.id === m.id)) continue;
      if (m.origin === "user" || m.origin === "peer") {
        const dup = out.some(
          (k) =>
            k.origin === m.origin &&
            k.from === m.from &&
            k.groupId === m.groupId &&
            k.content === m.content &&
            Math.abs(k.time - m.time) <= 3000,
        );
        if (dup) continue;
      }
      out.push(m);
    }
    return out;
  });

  const mergedByGroup = computed<Map<string, ChatMessage[]>>(() => {
    const map = new Map<string, ChatMessage[]>();
    for (const m of mergedMessages.value) {
      const arr = map.get(m.groupId ?? "general");
      if (arr) arr.push(m);
      else map.set(m.groupId ?? "general", [m]);
    }
    return map;
  });

  return { nameOf, mergedMessages, mergedByGroup };
}
