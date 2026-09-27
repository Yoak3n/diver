// 桌宠 Live2D 模型资源路径（模型外置为 bundle resources，不进 diver.exe）。
import { invoke } from "./core";

export function getPetModelPath(rel: string): Promise<string> {
  return invoke<string>("pet_model_path", { rel });
}

/** 全局模型 id 共享真源（壳层 pet-model.json；localStorage 因窗隔离不可用）。 */
export function getGlobalPetModel(): Promise<string | null> {
  return invoke<string | null>("get_global_pet_model");
}

export function setGlobalPetModel(model: string | null): Promise<boolean> {
  return invoke<boolean>("set_global_pet_model", { model });
}
