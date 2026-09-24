// 角色命中框 DOM（仅覆盖模型本体，class interactive 供穿透检测）。

export function createHitboxEl(container: HTMLElement): HTMLDivElement {
  const hitboxEl = document.createElement("div");
  hitboxEl.className = "model-hitbox interactive";
  hitboxEl.style.pointerEvents = "auto";
  container.appendChild(hitboxEl);
  return hitboxEl;
}

export function readHitbox(hitboxEl: HTMLDivElement): {
  left: number;
  top: number;
  width: number;
  height: number;
} | null {
  const left = parseFloat(hitboxEl.style.left) || 0;
  const top = parseFloat(hitboxEl.style.top) || 0;
  const width = parseFloat(hitboxEl.style.width) || 0;
  const height = parseFloat(hitboxEl.style.height) || 0;
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

/**
 * 按角色包围盒（非整块画布）更新命中框。
 * 略放大：动作/头发会略超出静态顶点包围盒，避免边缘点不中。
 */
export function updateHitbox(
  hitboxEl: HTMLDivElement,
  opts: {
    screenWidth: number;
    screenHeight: number;
    currentScale: number;
    currentAnchorX: number;
    charWidth: number;
    charHeight: number;
  },
) {
  const scale = opts.currentScale;
  const charW = opts.charWidth * scale;
  const charH = opts.charHeight * scale;
  const padX = charW * 0.08;
  const padY = charH * 0.05;
  const centerX = opts.screenWidth * opts.currentAnchorX;
  const bottomY = opts.screenHeight;
  const left = centerX - charW / 2 - padX;
  const top = bottomY - charH - padY;
  const width = charW + padX * 2;
  const height = charH + padY * 2;
  hitboxEl.style.left = `${left}px`;
  hitboxEl.style.top = `${top}px`;
  hitboxEl.style.width = `${width}px`;
  hitboxEl.style.height = `${height}px`;
}
