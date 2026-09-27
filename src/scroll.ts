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

/**
 * 节点在滚动容器内容坐标系里的纵向位置（与 offsetParent 无关，
 * 用视口差值换算），供时间线定位与跳转。
 */
export function topWithin(scroller: HTMLElement, node: Element): number {
  return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}
