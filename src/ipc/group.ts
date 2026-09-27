// 群组 IPC（P2-4）：一期清单 + 二期管理面板（成员/改名/踢人/解散/邀请记录）。
// 改名/移出/解散由壳层发起，群系统事件经 services 统一 inject（收听不吵）。

import { invoke } from "@tauri-apps/api/core";

/** 群清单行（P2-4 多群聊）：侧栏群行 + 归属流分桶数据源。 */
export interface GroupRow {
  id: string;
  name: string;
  /** 系统全员群：成员动态跟随实例增删，不可改名/移出/解散。 */
  system: boolean;
  /** 成员实例 id（system 群为空 = 全员）。 */
  members: string[];
  /** 建群时间（Unix 秒）。 */
  createdAt?: number;
  /** 创建者实例 id（`user`/`system` 亦可）。 */
  createdBy?: string;
}

/** 邀请记录（groups.json invites 留痕；拒绝也留理由）。 */
export interface GroupInvite {
  id: string;
  groupId: string;
  groupName: string;
  /** 邀请方实例 id。 */
  from: string;
  /** 被邀方实例 id。 */
  to: string;
  message: string;
  status: "pending" | "accepted" | "declined";
  reason: string;
  /** 登记时间（Unix 秒）。 */
  at: number;
}

/** 管理操作结果：群系统事件送达/失败明细（失败不回滚，仅提示）。 */
export interface ManageOutcome {
  delivered: string[];
  failed: Array<{ to: string; error: string }>;
}

/** 群清单（含系统全员群）。 */
export function listGroups(): Promise<GroupRow[]> {
  return invoke<GroupRow[]>("list_groups");
}

/** 指定群的邀请记录（时间正序；已解散群的留痕仍可查）。 */
export function listGroupInvites(groupId: string): Promise<GroupInvite[]> {
  return invoke<GroupInvite[]>("list_group_invites", { groupId });
}

/** 群改名（系统群拒绝）。 */
export function renameGroup(groupId: string, name: string): Promise<ManageOutcome> {
  return invoke<ManageOutcome>("rename_group", { groupId, name });
}

/** 移出成员（拍板「用户事后可撤人」；系统群拒绝）。 */
export function removeGroupMember(groupId: string, memberId: string): Promise<ManageOutcome> {
  return invoke<ManageOutcome>("remove_group_member", { groupId, memberId });
}

/** 解散群（系统群拒绝；邀请记录保留）。 */
export function deleteGroup(groupId: string): Promise<ManageOutcome> {
  return invoke<ManageOutcome>("delete_group", { groupId });
}
