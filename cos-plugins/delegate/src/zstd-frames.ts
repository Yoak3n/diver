// @diver/delegate —— zstd 多帧切分（纯函数）。
//
// dsh 会话日志（session-persistence-jsonl）是「多帧追加」的 zstd 流：每次
// 落盘批次一个独立帧。Node 的 `zstdDecompressSync` / `ZstdDecompress` 都只
// 解第一个帧（实测 2026-09-29），必须先按帧边界切开再逐帧解。
//
// 帧边界按 Zstandard 规范精确走：帧头（描述符→窗口→字典 ID→内容长度）
// + 块头链（3 字节头：末块位/块型/块长）+ 可选校验和。坏帧（撕裂尾帧等）
// 跳到下一个魔数重试；彻底无解则丢弃尾部——与「撕裂尾帧只留完整记录」的
// 落盘语义一致。

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 从 `start`（指向魔数）解析整帧字节长度；不完整/非法返回 null。 */
export function zstdFrameLength(buf: Buffer, start: number): number | null {
  if (start + 5 > buf.length) return null
  const descriptor = buf[start + 4]
  const fcsFlag = (descriptor >> 6) & 0x03
  const singleSegment = (descriptor >> 5) & 0x01
  const checksum = (descriptor >> 2) & 0x01
  const didFlag = descriptor & 0x03
  let p = start + 5
  if (!singleSegment) p += 1 // Window_Descriptor
  p += didFlag === 0 ? 0 : didFlag === 1 ? 1 : didFlag === 2 ? 2 : 4
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
  for (;;) {
    if (p + 3 > buf.length) return null
    const header = buf.readUIntLE(p, 3)
    const last = header & 0x01
    const type = (header >> 1) & 0x03
    const size = header >> 3
    p += 3
    if (type === 3) return null // Reserved 块型：非法
    p += type === 1 ? 1 : size // RLE 块内容固定 1 字节
    if (p > buf.length) return null
    if (last) break
  }
  return checksum ? p + 4 : p
}

/** 切出全部完整帧；解析失败从下一个魔数兜底重试，尾部残帧丢弃。 */
export function splitZstdFrames(buf: Buffer): Buffer[] {
  const frames: Buffer[] = []
  let pos = buf.indexOf(MAGIC)
  while (pos !== -1) {
    const end = zstdFrameLength(buf, pos)
    if (end !== null && end > pos) {
      frames.push(buf.subarray(pos, end))
      pos = buf.indexOf(MAGIC, end)
      continue
    }
    // 该起点解析不出完整帧（撕裂/脏数据）：跳下一个魔数。
    pos = buf.indexOf(MAGIC, pos + MAGIC.length)
  }
  return frames
}
