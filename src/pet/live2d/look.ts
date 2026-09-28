// 视线追踪（对齐 N.E.K.O 的 focus / LookAt）。

type LookModel = {
  focus?: (x: number, y: number, instant?: boolean) => void;
};

export function createLookController(model: LookModel) {
  let lookEnabled = true;
  let lookTarget: { x: number; y: number } | null = null;
  /** 视线钉定（思考游移等）：钉住期间忽略鼠标跟随，直到清空。 */
  let pinned: { x: number; y: number } | null = null;
  let disposed = false;

  function setLookAt(x: number, y: number) {
    if (pinned) return;
    lookTarget = { x, y };
  }

  function setLookPinned(target: { x: number; y: number } | null) {
    pinned = target;
    if (target) lookTarget = { ...target };
  }

  function setLookEnabled(on: boolean) {
    lookEnabled = on;
  }

  function applyLook() {
    const target = pinned ?? lookTarget;
    if (disposed || !lookEnabled || !target) return;
    try {
      model.focus?.(target.x, target.y);
    } catch {
      /* 忽略 */
    }
  }

  function destroy() {
    disposed = true;
    lookTarget = null;
    pinned = null;
  }

  return { setLookAt, setLookPinned, setLookEnabled, applyLook, destroy };
}
