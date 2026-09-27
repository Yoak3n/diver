// P2-5 多桌宠：实例桌宠窗口池 IPC（薄封装，同屏上限 3 只）。
import { invoke } from "./core";

/** 打开实例桌宠（幂等前置），返回在屏实例 id 列表。超上限报错并列明已在屏实例。 */
export function openInstancePet(id: string): Promise<string[]> {
  return invoke<string[]>("open_instance_pet", { id });
}

/** 收起实例桌宠（幂等），返回在屏实例 id 列表。 */
export function closeInstancePet(id: string): Promise<string[]> {
  return invoke<string[]>("close_instance_pet", { id });
}

/** 在屏实例桌宠清单（id 列表）。 */
export function listInstancePets(): Promise<string[]> {
  return invoke<string[]>("list_instance_pets");
}

/** 点谁互动谁：前置主窗并切换到该实例会话。 */
export function focusInstanceChat(id: string): Promise<void> {
  return invoke<void>("focus_instance_chat", { id });
}

/** 设置每实例桌宠模型 id（null = 跟随全局模型选择）。 */
export function setInstancePetModel(id: string, model: string | null): Promise<unknown> {
  return invoke("set_instance_pet_model", { id, model });
}
