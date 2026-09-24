// 聊天区滚动几何纯函数。

/** 距底部不超过 threshold 像素视为「贴近底部」。 */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 72,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
