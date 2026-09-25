// Diver 桌宠：模型目录加载与情绪动作组解析
//
// model-catalog.json 描述可用模型（Hiyori / YUI…）；emotion-map 的逻辑动作组
// （Happy/Sad/…）经各模型 groupAliases 解析到 model3.json 的真实组名。

import { convertFileSrc } from "@tauri-apps/api/core";
import { getPetModelPath } from "../ipc/petModels";
import catalogJson from "./model-catalog.json";

export interface PetModelProfile {
  id: string;
  label: string;
  model3: string;
  heightRatio: number;
  installHint?: string;
  note?: string;
  /** 逻辑组（Happy/Sad/TapBody…）→ 候选真实组名（取第一个存在的） */
  groupAliases: Record<string, string[]>;
  /** 情绪名 → 候选表情名（pixi-live2d-display expression） */
  expressionMap?: Record<string, string[]>;
}

export interface PetModelCatalog {
  version: number;
  defaultModelId: string;
  models: PetModelProfile[];
}

const STORAGE_KEY = "diver.pet.modelId";
/** 跨窗口同步：设置页改模型后通知桌宠窗口（Tauri event + 同窗口 CustomEvent）。 */
export const PET_MODEL_CHANGED_EVENT = "pet://model-changed";

const catalog = catalogJson as PetModelCatalog;

/**
 * 模型文件 URL 解析：dev 由 vite 从 public/pet/models 提供；release 模型外置为
 * bundle resources（不进 diver.exe），经 asset 协议读安装目录明文文件。
 * 绝对路径由 Rust 侧拼接（剥 `\\?\` 前缀 + 按段拼），前端只递相对路径。
 */
export async function resolveModelUrl(model3: string): Promise<string> {
  if (import.meta.env.DEV) return model3;
  const rel = model3.replace(/^\/?pet\/models\//, "");
  return convertFileSrc(await getPetModelPath(rel));
}

export async function loadModelCatalog(): Promise<PetModelCatalog> {
  return catalog;
}

export function getStoredModelId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeModelId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* 忽略 */
  }
}

/** 持久化选择并广播（同窗口 CustomEvent + Tauri 跨窗口）。 */
export function selectModelId(id: string): void {
  storeModelId(id);
  try {
    window.dispatchEvent(
      new CustomEvent(PET_MODEL_CHANGED_EVENT, { detail: { id } }),
    );
  } catch {
    /* 忽略 */
  }
  void emitModelChanged(id);
}

async function emitModelChanged(id: string): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(PET_MODEL_CHANGED_EVENT, { id });
  } catch {
    /* 浏览器调试或 Tauri 不可用 */
  }
}

export function pickModelProfile(
  cat: PetModelCatalog,
  preferredId?: string | null,
): PetModelProfile {
  const id = preferredId || getStoredModelId() || cat.defaultModelId;
  return cat.models.find((m) => m.id === id) ?? cat.models[0];
}

/** 把逻辑动作组名解析为模型真实组候选（保持顺序）。 */
export function resolveMotionGroups(
  profile: PetModelProfile,
  logicalGroup: string,
): string[] {
  const mapped = profile.groupAliases?.[logicalGroup];
  if (mapped?.length) return mapped;
  return [logicalGroup];
}
