// OneBot 连接状态 → 展示文案（纯函数，可单测）。
// 从原 OnebotTab.vue 的三个 computed 原样抽出。

import type { OnebotStatus } from "@diver/plugin-ui";

export type StatusTone = "ok" | "warn" | "bad" | "idle";

export interface StatusInput {
  owner: string | null;
  ownerRunning: boolean;
  status: OnebotStatus | null;
  error: string;
}

export interface StatusView {
  tone: StatusTone;
  title: string;
  detail: string;
}

export function describeStatus(input: StatusInput): StatusView {
  return {
    tone: toneOf(input),
    title: titleOf(input),
    detail: detailOf(input),
  };
}

function toneOf({ error, status }: StatusInput): StatusTone {
  if (error !== "") return "bad";
  if (status === null || !status.available) return "idle";
  if (status.state === "online") return "ok";
  if (status.state === "connecting") return "warn";
  if (status.state === "offline") return "bad";
  return "idle";
}

function titleOf({ owner, ownerRunning, status, error }: StatusInput): string {
  if (owner === null) return "未绑定归属实例";
  if (!ownerRunning) return "归属实例未运行";
  if (error !== "") return "状态读取失败";
  if (status === null) return "正在读取连接状态…";
  if (!status.available || status.state === "unavailable") {
    return "OneBot 插件未加载";
  }
  if (status.state === "sleeping") return "插件休眠";
  if (status.state === "online") return "已连接";
  if (status.state === "connecting") return "连接中…";
  return "未连接";
}

function detailOf({ owner, ownerRunning, status, error }: StatusInput): string {
  if (owner === null) {
    return "先选择归属实例；绑定后这里显示它的 OneBot 连接状态。";
  }
  if (!ownerRunning) return "启用归属实例并重启应用后，这里会显示连接状态。";
  if (error !== "") return error;
  if (status === null) return "";
  if (!status.available || status.state === "unavailable") {
    return "实例里没有可用的 onebot 插件（可能被停用或未安装）。";
  }
  if (status.state === "sleeping") return status.reason ?? "插件未接线";
  const target = status.url ?? "";
  if (status.state === "online") {
    const who =
      status.nickname !== undefined && status.nickname !== ""
        ? `${status.nickname}${status.selfId !== undefined ? `（${status.selfId}）` : ""}`
        : status.selfId !== undefined
          ? `QQ ${status.selfId}`
          : "OneBot";
    return [who, target].filter(Boolean).join(" · ");
  }
  if (status.state === "connecting") {
    const why =
      status.lastError !== undefined && status.lastError !== ""
        ? `上次失败：${status.lastError}`
        : "";
    return [target, why].filter(Boolean).join(" · ");
  }
  const retry =
    status.retryInMs !== undefined
      ? `${Math.max(1, Math.ceil(status.retryInMs / 1000))} 秒后重连`
      : "等待重连";
  const attempts =
    status.attempts !== undefined && status.attempts > 0
      ? `第 ${status.attempts} 次`
      : "";
  return [status.lastError ?? "连接已断开", attempts, retry, target]
    .filter(Boolean)
    .join(" · ");
}
