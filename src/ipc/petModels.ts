// 桌宠 Live2D 模型资源路径（模型外置为 bundle resources，不进 diver.exe）。
import { invoke } from "./core";

export function getPetModelPath(rel: string): Promise<string> {
  return invoke<string>("pet_model_path", { rel });
}
