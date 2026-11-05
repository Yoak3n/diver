// B 站扫码登录（只读账号）：二维码 → 轮询 → 状态/退出。

import { json } from "./base";

export interface BilibiliStatus {
  loggedIn: boolean;
  expired?: boolean;
  name?: string;
  mid?: string;
}

export interface BilibiliQr {
  key: string;
  qrDataUrl: string;
  expiresIn: number;
}

export type BilibiliPollStatus = "waiting" | "scanned" | "confirmed" | "expired" | "error";

export interface BilibiliPoll {
  status: BilibiliPollStatus;
  loggedIn: boolean;
  name?: string;
  mid?: string;
  message?: string;
}

export function getBilibiliStatusApi(): Promise<BilibiliStatus> {
  return json<BilibiliStatus>("/bilibili/status");
}

export function requestBilibiliQrApi(): Promise<BilibiliQr> {
  return json<BilibiliQr>("/bilibili/login/qrcode", { method: "POST" });
}

export function pollBilibiliQrApi(key: string): Promise<BilibiliPoll> {
  return json<BilibiliPoll>(`/bilibili/login/poll?key=${encodeURIComponent(key)}`);
}

export function logoutBilibiliApi(): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>("/bilibili/logout", { method: "POST" });
}
