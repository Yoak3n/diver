import { invoke } from "@tauri-apps/api/core";

/** 群清单行（P2-4 多群聊）：侧栏群行 + 归属流分桶数据源。 */
export interface GroupRow {
  id: string;
  name: string;
  /** 系统全员群：成员动态跟随实例增删，不可删。 */
  system: boolean;
  /** 成员实例 id（system 群为空 = 全员）。 */
  members: string[];
}

/** 群清单（含系统全员群）。 */
export function listGroups(): Promise<GroupRow[]> {
  return invoke<GroupRow[]>("list_groups");
}
