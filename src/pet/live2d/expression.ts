// 表情层：淡入 + 差分淡出（简化版 N.E.K.O smoothReset）。

type ExprParam = { id: string; value: number };

type ExprModel = {
  internalModel: {
    coreModel: unknown;
    motionManager?: {
      expressionManager?: {
        definitions?: unknown;
        setExpression?: (name: string) => void;
        resetExpression?: () => void;
      };
    };
  };
  expression?: (name?: string) => unknown;
};

const EXPR_FADE_IN_MS = 220;
const EXPR_FADE_OUT_MS = 320;

export function createExpressionController(model: ExprModel, modelBase: string) {
  let exprOverride: ExprParam[] | null = null;
  let exprWeight = 0;
  let exprTargetWeight = 0;
  let exprFadeSpeed = 0;
  let disposed = false;

  function setExpression(name?: string | null): boolean {
    if (disposed) return false;
    try {
      const manager = model.internalModel?.motionManager?.expressionManager;
      if (!name) {
        if (typeof model.expression === "function") void model.expression();
        else manager?.resetExpression?.();
        return true;
      }
      if (typeof model.expression === "function") {
        void model.expression(name);
        return true;
      }
      if (manager?.setExpression) {
        manager.setExpression(name);
        return true;
      }
      return false;
    } catch (err) {
      console.warn("[pet] setExpression 失败", name, err);
      return false;
    }
  }

  function loadExprParamsFromName(name: string): ExprParam[] {
    try {
      const em = model.internalModel?.motionManager?.expressionManager;
      const defs = (em?.definitions ?? []) as unknown;
      const list = Array.isArray(defs) ? defs : Object.values((defs ?? {}) as object);
      for (const d of list as Record<string, unknown>[]) {
        const n = d?.Name ?? d?.name ?? d?.id;
        if (n !== name) continue;
        const inline = (d?.Parameters ?? d?.parameters) as
          | { Id?: string; id?: string; Value?: number; value?: number }[]
          | undefined;
        if (Array.isArray(inline) && inline.length) {
          return inline
            .map((p) => ({
              id: String(p?.Id ?? p?.id ?? ""),
              value: Number(p?.Value ?? p?.value ?? 0),
            }))
            .filter((p: ExprParam) => p.id);
        }
      }
    } catch {
      /* 忽略 */
    }
    return [];
  }

  async function loadExprParamsFromFile(name: string): Promise<ExprParam[]> {
    try {
      const em = model.internalModel?.motionManager?.expressionManager;
      const defs = (em?.definitions ?? []) as unknown;
      const list = Array.isArray(defs) ? defs : Object.values((defs ?? {}) as object);
      let file: string | null = null;
      for (const d of list as Record<string, unknown>[]) {
        const n = d?.Name ?? d?.name ?? d?.id;
        if (n === name && d?.File) {
          file = String(d.File);
          break;
        }
      }
      if (!file) return [];
      const url = file.startsWith("http") ? file : modelBase + file.replace(/^\.\//, "");
      const res = await fetch(url);
      if (!res.ok) return [];
      const json = (await res.json()) as { Parameters?: { Id?: string; Value?: number }[] };
      return (json.Parameters ?? [])
        .map((p) => ({
          id: String(p?.Id ?? ""),
          value: Number(p?.Value ?? 0),
        }))
        .filter((p: ExprParam) => p.id);
    } catch {
      return [];
    }
  }

  function setExpressionFade(name?: string | null) {
    if (disposed) return;
    if (!name) {
      exprTargetWeight = 0;
      exprFadeSpeed = 1 / (EXPR_FADE_OUT_MS / 1000);
      return;
    }
    const ok = setExpression(name);
    void loadExprParamsFromFile(name)
      .then(async (fromFile) => {
        if (disposed) return;
        let params = fromFile.length ? fromFile : loadExprParamsFromName(name);
        if (!params.length) params = await loadExprParamsFromFile(name);
        if (params.length) {
          exprOverride = params;
          exprTargetWeight = 1;
          exprFadeSpeed = 1 / (EXPR_FADE_IN_MS / 1000);
        }
        console.log("[pet] setExpression", name, "native", ok, "params", params.length);
      })
      .catch(() => {
        console.log("[pet] setExpression", name, "native", ok, "params 0");
      });
  }

  function applyExprLayer(dtSec: number) {
    if (disposed) return;
    if (exprWeight === 0 && exprTargetWeight === 0) {
      exprOverride = null;
      return;
    }
    if (exprWeight < exprTargetWeight) {
      exprWeight = Math.min(exprTargetWeight, exprWeight + exprFadeSpeed * dtSec);
    } else if (exprWeight > exprTargetWeight) {
      exprWeight = Math.max(exprTargetWeight, exprWeight - exprFadeSpeed * dtSec);
      if (exprWeight === 0) exprOverride = null;
    }
    if (!exprOverride || exprWeight <= 0) return;
    try {
      const core = model.internalModel.coreModel as {
        addParameterValueById?: (id: string, v: number) => void;
        setParameterValueById?: (id: string, v: number) => void;
        getParameterValueById?: (id: string) => number;
      };
      for (const p of exprOverride) {
        if (typeof core.addParameterValueById === "function") {
          core.addParameterValueById(p.id, p.value * exprWeight);
        } else if (typeof core.setParameterValueById === "function") {
          const cur = core.getParameterValueById?.(p.id) ?? 0;
          core.setParameterValueById(p.id, cur + p.value * exprWeight);
        }
      }
    } catch {
      /* 忽略 */
    }
  }

  function destroy() {
    disposed = true;
    exprOverride = null;
    exprWeight = 0;
    exprTargetWeight = 0;
  }

  return { setExpressionFade, setExpression, applyExprLayer, destroy };
}
