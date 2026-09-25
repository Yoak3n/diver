// 桌宠 Live2D 模型资源目录（模型外置为 bundle resources，不进 diver.exe）。
import { invoke } from "./core";

export function getPetModelsDir(): Promise<string> {
  return invoke<string>("pet_models_dir");
}
