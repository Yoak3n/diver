// 好奇心清单域端点（只读；探索开关在「插件 → 记忆」配置里）。

import { json } from "./base";

export type CuriosityStatus = "open" | "claimed" | "done" | "skipped" | "expired";

export interface CuriosityItem {
  id: string;
  term: string;
  source: string;
  reason: string;
  priority: number;
  status: CuriosityStatus;
  occurrences: number;
  attempts: number;
  createdAt: number;
  lastSeenAt: number;
  doneAt: number | null;
  topicId: string | null;
  note: string;
  score: number;
}

export interface CuriosityCounts {
  open: number;
  claimed: number;
  done: number;
  skipped: number;
  expired: number;
}

export interface CuriosityReport {
  lastReportAt: number;
  lastAttemptAt: number;
  attempts: number;
}

export interface CuriosityView {
  items: CuriosityItem[];
  counts: CuriosityCounts;
  report: CuriosityReport | null;
  lastScanAt: number;
}

/** 读取队列（status 省略 = 全部状态；UI 默认看 open）。 */
export function getCuriosityApi(status?: CuriosityStatus, limit = 50): Promise<CuriosityView> {
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  query.set("limit", String(limit));
  return json<CuriosityView>(`/memory/curiosity?${query.toString()}`);
}
