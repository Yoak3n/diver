// @diver/basic-tools — 会话级观察表（移植自 DSH 上游 fs-observation-policy 的内存版）。
//
// 上游用 ctx.emit('fs/observed') / ctx.waterfall('fs/write-intent') 事件系统实现
// read-first 守卫；diver 无该事件层，用一个按会话作用域的内存 Map（targetKey →
// version）替代：
// - read 成功 → 记录 targetKey 的当前版本；
// - write 无 createIfAbsent 意图且目标已存在、但本会话未读过 → FS_NOT_OBSERVED；
// - edit/write 的版本守卫 → 记录缺失或版本不符 → FS_STALE_VERSION。
//
// 守卫是可选的：插件配置 observationRequired=false 时无条件写入（与上游无
// policy 时的行为一致）。

import { DiverFsError, probe } from './fsio.ts'

export class ObservationTable {
  private readonly versions = new Map<string, string>()
  private readonly enabled: boolean

  constructor(enabled = true) {
    this.enabled = enabled
  }

  /** read 成功时记录目标的当前版本。 */
  set(targetKey: string, version: string): void {
    this.versions.set(targetKey, version)
  }

  /** 记录该目标被本会话创建/编辑过（此时已隐含观察）。 */
  markObserved(targetKey: string, version: string): void {
    this.versions.set(targetKey, version)
  }

  /** 目标是否已被本会话读过/写过。 */
  has(targetKey: string): boolean {
    return this.versions.has(targetKey)
  }

  /** 目标当前记录的观察版本；未观察返回 undefined。 */
  get(targetKey: string): string | undefined {
    return this.versions.get(targetKey)
  }

  /** 目标是否仍与记录一致（存在性 + 版本）。 */
  isCurrent(targetKey: string): boolean {
    return this.versions.get(targetKey) !== undefined
  }

  /** 守卫是否启用（false = 无条件写入，对应上游无 policy 时的行为）。 */
  isEnabled(): boolean {
    return this.enabled
  }

  /**
   * write 守卫：目标已存在且未观察 → FS_NOT_OBSERVED。
   * 返回 true 表示可以写入（无观察要求，或目标不存在，或已被观察）。
   */
  async guardWrite(targetKey: string, displayPath: string): Promise<boolean> {
    if (!this.enabled) return true
    const existing = await probe(targetKey)
    if (existing === null) return true
    if (existing.type !== 'file') {
      throw new DiverFsError(`cannot write "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if (!this.versions.has(targetKey)) {
      throw new DiverFsError(
        `cannot overwrite existing "${displayPath}" without reading it first — read the file, then retry`,
        'FS_NOT_OBSERVED',
      )
    }
    return true
  }

  /**
   * edit 守卫：目标缺失或版本不符 → FS_STALE_VERSION（缺失目标也用 stale 码，
   * 与上游一致）。禁用时跳过。
   */
  async guardEdit(targetKey: string, displayPath: string): Promise<void> {
    if (!this.enabled) return
    const existing = await probe(targetKey)
    if (existing === null) {
      throw new DiverFsError(
        `cannot edit "${displayPath}": file changed since it was read — re-read the file, then retry`,
        'FS_STALE_VERSION',
      )
    }
    if (existing.type !== 'file') {
      throw new DiverFsError(`cannot edit "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    const observed = this.versions.get(targetKey)
    if (observed === undefined || observed !== existing.version) {
      throw new DiverFsError(
        `cannot edit "${displayPath}": file changed since it was read — re-read the file, then retry`,
        'FS_STALE_VERSION',
      )
    }
  }
}
