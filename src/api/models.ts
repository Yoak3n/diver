// 模型提供商域端点：自定义 OpenAI 兼容提供商（身份 / 凭据 / 模型目录）。
// 走通用 provider 配置通道（active 实例），per-instance 模型配置随实例设置页另行设计。

import { json } from "./base";

/** 自定义提供商身份（配置值走通用 provider 配置通道）。 */
export interface CustomProviderIdentity {
  id: string;
  name: string;
}

export function getCustomProviders(): Promise<{ providers: CustomProviderIdentity[] }> {
  return json("/custom-providers");
}

export function saveCustomProvider(body: {
  action: "add" | "update";
  id?: string;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string;
}): Promise<{ ok: boolean; provider: CustomProviderIdentity }> {
  return json("/custom-providers", { method: "POST", body: JSON.stringify(body) });
}

export function removeCustomProvider(id: string): Promise<{ ok: boolean }> {
  return json("/custom-providers", {
    method: "POST",
    body: JSON.stringify({ action: "remove", id }),
  });
}

/** 「拉取模型」：探端点 {baseUrl}/models 目录。 */
export function fetchCustomProviderModels(
  baseUrl: string,
  apiKey?: string,
): Promise<{ models: string[] }> {
  return json("/custom-providers/models", {
    method: "POST",
    body: JSON.stringify({ baseUrl, ...(apiKey ? { apiKey } : {}) }),
  });
}
