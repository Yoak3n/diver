// moc3 文件头版本探测（避免旧 Core 加载过新模型只吐 "Unknown error"）。

/** moc3 文件头：magic 'MOC3' + uint32 version（与 Cubism MocVersion 枚举一致）。 */
async function readMocVersion(modelUrl: string): Promise<number> {
  const res = await fetch(modelUrl);
  if (!res.ok) throw new Error(`模型描述加载失败：HTTP ${res.status}（${modelUrl}）`);
  const meta = (await res.json()) as { FileReferences?: { Moc?: string } };
  const mocRel = meta.FileReferences?.Moc;
  if (!mocRel) throw new Error("model3.json 缺少 FileReferences.Moc");
  const base = modelUrl.replace(/[^/]*$/, "");
  const mocRes = await fetch(base + mocRel);
  if (!mocRes.ok) throw new Error(`moc3 加载失败：HTTP ${mocRes.status}（${base + mocRel}）`);
  const buf = await mocRes.arrayBuffer();
  const u8 = new Uint8Array(buf);
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== "MOC3") throw new Error(`moc3 魔数异常：${magic}`);
  const ver = u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24);
  return ver >>> 0;
}

/** 当前 Core 支持的最高 moc3 版本（MocVersion_42=4 / MocVersion_50=5）。 */
function coreMaxMocVersion(): number {
  const core = (window as unknown as {
    Live2DCubismCore?: {
      Version?: { csmGetLatestMocVersion?: () => number };
    };
  }).Live2DCubismCore;
  try {
    return core?.Version?.csmGetLatestMocVersion?.() ?? 0;
  } catch {
    return 0;
  }
}

export async function assertMocSupported(modelUrl: string): Promise<void> {
  let fileVer: number;
  try {
    fileVer = await readMocVersion(modelUrl);
  } catch (err) {
    throw new Error(
      `读取模型 moc 版本失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const max = coreMaxMocVersion();
  if (max > 0 && fileVer > max) {
    throw new Error(
      `Cubism Core 不支持 moc3 v${fileVer}（当前最高 v${max}）。` +
        `请升级 public/pet/live2dcubismcore.min.js（需含 MocVersion_50）。` +
        `模型：${modelUrl}`,
    );
  }
}

export function enrichLoadError(modelUrl: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg && msg !== "Unknown error" && !/unknown error/i.test(msg)) {
    return new Error(`模型加载失败（${modelUrl}）：${msg}`);
  }
  return new Error(
    `模型加载失败（${modelUrl}）：${msg}。` +
      `常见原因：moc3 版本过新 / 贴图路径错误 / WebGL 上下文异常。` +
      `可打开 DevTools 查看 Cubism 日志。`,
  );
}
