// 视线追踪（对齐 N.E.K.O 的 focus / LookAt）。

type LookModel = {
  focus?: (x: number, y: number, instant?: boolean) => void;
};

export function createLookController(model: LookModel) {
  let lookEnabled = true;
  let lookTarget: { x: number; y: number } | null = null;
  let disposed = false;

  function setLookAt(x: number, y: number) {
    lookTarget = { x, y };
  }

  function setLookEnabled(on: boolean) {
    lookEnabled = on;
  }

  function applyLook() {
    if (disposed || !lookEnabled || !lookTarget) return;
    try {
      model.focus?.(lookTarget.x, lookTarget.y);
    } catch {
      /* 忽略 */
    }
  }

  function destroy() {
    disposed = true;
    lookTarget = null;
  }

  return { setLookAt, setLookEnabled, applyLook, destroy };
}
