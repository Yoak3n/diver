// 本轮过程折叠（最终输出后收起思考/工具）。

import type { Ref } from "vue";
import type { ChatMessage } from "../../types";

export function createActivityOps(
  messages: Ref<ChatMessage[]>,
  scrollToBottom: () => void,
) {
  /**
   * 把每一轮「用户 → 过程（思考/工具/中间步骤）→ 最终答复」里的过程
   * 收成一条 activity-summary（默认折叠）。从后往前扫，避免插入 summary
   * 后下标漂移；已折叠过的轮次（成员带 activityGroupId）会跳过。
   */
  function collapseTurnActivity() {
    const list = messages.value;
    if (list.length === 0) return;

    let turnEnd = list.length;
    while (turnEnd > 0) {
      let userIdx = -1;
      for (let i = turnEnd - 1; i >= 0; i--) {
        if (list[i].kind === "user") {
          userIdx = i;
          break;
        }
      }
      const start = userIdx + 1;
      if (start >= turnEnd) {
        turnEnd = userIdx;
        if (userIdx < 0) break;
        continue;
      }

      let finalIdx = -1;
      for (let i = turnEnd - 1; i >= start; i--) {
        const m = list[i];
        if (m.kind === "assistant" && m.content.trim() !== "" && !m.activityGroupId) {
          finalIdx = i;
          break;
        }
      }
      if (finalIdx < 0) {
        turnEnd = userIdx;
        if (userIdx < 0) break;
        continue;
      }

      const members: ChatMessage[] = [];
      for (let i = start; i < finalIdx; i++) {
        const m = list[i];
        if (m.kind === "activity-summary" || m.kind === "user" || m.kind === "system" || m.activityGroupId) {
          continue;
        }
        members.push(m);
      }

      let toolCount = 0;
      for (const m of members) {
        toolCount += m.tools?.length ?? 0;
      }
      const messageCount = members.length;
      if (!(toolCount === 0 && messageCount <= 1) && members.length > 0) {
        const groupId = `act-${Date.now()}-${turnEnd}`;
        for (const m of members) {
          m.activityGroupId = groupId;
        }
        const summary: ChatMessage = {
          id: groupId,
          kind: "activity-summary",
          content: "",
          origin: "assistant",
          time: members[0].time,
          toolCount,
          messageCount,
          activityExpanded: false,
          activityGroupId: groupId,
        };
        const insertAt = list.indexOf(members[0]);
        list.splice(insertAt, 0, summary);
      }

      turnEnd = userIdx;
      if (userIdx < 0) break;
    }
    scrollToBottom();
  }

  /** 切换活动组展开/收起。 */
  function toggleActivity(groupId: string) {
    const summary = messages.value.find(
      (m) => m.kind === "activity-summary" && m.activityGroupId === groupId,
    );
    if (!summary) return;
    summary.activityExpanded = !summary.activityExpanded;
  }

  return { collapseTurnActivity, toggleActivity };
}
