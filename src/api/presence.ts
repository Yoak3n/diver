// presence 日程提醒域端点（持久化于 $COS_HOME/presence-schedule.json，热生效）。

import { json } from "./base";

export interface PresenceEntry {
  id: string;
  /** "HH:mm"（24 小时制，本地时区） */
  time: string;
  /** 主动问候提示（agent 收到后以 presence 前缀消息触发） */
  prompt: string;
  enabled: boolean;
}

export interface PresenceConfig {
  entries: PresenceEntry[];
}

/** 读取日程提醒配置。 */
export function getPresenceApi(): Promise<PresenceConfig> {
  return json<PresenceConfig>("/presence");
}

/** 保存日程提醒配置（整个数组替换，无需重启 sidecar）。 */
export function savePresenceApi(entries: PresenceEntry[]): Promise<PresenceConfig> {
  return json<PresenceConfig>("/presence", {
    method: "POST",
    body: JSON.stringify({ entries }),
  });
}
