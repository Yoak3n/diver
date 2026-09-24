// 情绪 → 表情名软映射 + react 入口（动作 + 表情同播）。

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** 情绪 → 候选表情名（模型无关的软映射，调用方可覆盖）。 */
export function emotionToExprName(emotion: string): string | null {
  const map: Record<string, string[]> = {
    happy: ["expression3", "expression4", "yyy", "xxy", "by"],
    excited: ["expression3", "expression4", "yyy", "xxy"],
    sad: ["by", "expression5", "wy"],
    angry: ["expression2", "expression9", "bzy"],
    surprised: ["expression6", "expression7", "k1", "z1"],
    shy: ["expression11", "expression12", "s1", "syhs"],
    love: ["expression4", "expression11", "xxy"],
    grateful: ["expression3", "by", "yyy"],
    greeting: ["expression3", "yyy"],
    farewell: ["by"],
    agree: ["expression3", "001"],
    neutral: ["by", "expression3", "001"],
    TapBody: ["expression3", "happy"],
  };
  const list = map[emotion] ?? map.neutral;
  return pick(list);
}

export type ReactDeps = {
  resolveGroup: (logical: string) => string | null;
  setExpressionFade: (name?: string | null) => void;
  playEmotion: (group: string, opts?: { priority?: "normal" | "force" }) => void;
  isDisposed: () => boolean;
};

export function createReact(deps: ReactDeps) {
  return function react(
    emotion: string,
    opts?: { force?: boolean; zone?: "head" | "body" | "auto"; expressions?: string[] },
  ) {
    if (deps.isDisposed()) return;
    const force = opts?.force === true;
    const zone = opts?.zone ?? "auto";

    const firstGroup = (...names: string[]): string => {
      for (const n of names) {
        const g = deps.resolveGroup(n);
        if (g) return g;
      }
      return (
        deps.resolveGroup("happy") ??
        deps.resolveGroup("neutral") ??
        deps.resolveGroup("Idle") ??
        "Idle"
      );
    };

    let logical = emotion;
    if (zone === "head" && emotion === "neutral") {
      logical = firstGroup("shy", "Shy", "surprised", "happy");
    } else if (zone === "body" && emotion === "neutral") {
      logical = firstGroup("TapBody", "happy", "neutral");
    } else if (!deps.resolveGroup(logical)) {
      logical = firstGroup(logical, "happy", "neutral");
    }

    const faceKey =
      logical === "shy" || logical === "Shy"
        ? "shy"
        : logical === "surprised"
          ? "surprised"
          : logical === "TapBody" || logical === "happy"
            ? "happy"
            : logical;
    const exprName = opts?.expressions?.length
      ? pick(opts.expressions)
      : emotionToExprName(faceKey);
    if (exprName) deps.setExpressionFade(exprName);

    console.log("[pet] react", { emotion, zone, logical, faceKey, exprName, force });
    deps.playEmotion(logical, { priority: force ? "force" : "normal" });
  };
}
