// 角色可见图元顶点包围盒（模型局部坐标，y 向下）。

export type CharBounds = {
  charWidth: number;
  charHeight: number;
  /** 角色中心相对画布中心的 x 偏移（画布单位，右为正） */
  charCenterOffsetX: number;
  /** 角色底边相对画布底边的偏移（画布单位，0 = 脚贴画布底边） */
  charBottomOffset: number;
};

/**
 * 以「可见图元的顶点包围盒」为基准计算角色真实尺寸。
 * model.width 是画布宽（CanvasWidth），角色通常只占画布一部分；
 * 若按画布算缩放，角色实际显示宽度会远小于设计值。
 */
export function computeCharBounds(model: {
  internalModel: {
    width: number;
    height: number;
    coreModel: unknown;
    getDrawableVertices?: (i: number) => number[] | Float32Array | undefined;
  };
}): CharBounds {
  const wrapper = model.internalModel.coreModel as {
    getDrawableCount?: () => number;
    getDrawableOpacity?: (i: number) => number | undefined;
  };
  const internal = model.internalModel as {
    getDrawableVertices?: (i: number) => number[] | Float32Array | undefined;
  };
  const canvasW = model.internalModel.width;
  const canvasH = model.internalModel.height;
  let charWidth = canvasW;
  let charHeight = canvasH;
  let charCenterOffsetX = 0;
  let charBottomOffset = 0;
  try {
    const count = wrapper?.getDrawableCount?.() ?? 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const opacity = wrapper?.getDrawableOpacity?.(i);
      if (opacity === undefined || opacity <= 0) continue;
      const verts = internal?.getDrawableVertices?.(i);
      if (!verts) continue;
      for (let v = 0; v < verts.length; v += 2) {
        const x = verts[v], y = verts[v + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (isFinite(minX) && isFinite(maxX) && maxX > minX) {
      charWidth = maxX - minX;
      charHeight = maxY - minY;
      charCenterOffsetX = (minX + maxX) / 2 - canvasW / 2;
      charBottomOffset = canvasH - maxY;
    } else {
      console.warn(`[pet] 包围盒计算为空（count=${count}），回退画布尺寸`);
    }
  } catch (err) {
    console.warn("[pet] 计算角色包围盒失败，回退到画布尺寸:", err);
  }
  return { charWidth, charHeight, charCenterOffsetX, charBottomOffset };
}
