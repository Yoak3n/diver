// 图片附件工具：File → 可发送的 base64 附件（主窗口 / 桌宠共用）。
// 最长边压到 1600px，控制 base64 请求体积。

import type { ComposerAttachment } from "./types";

export async function fileToAttachment(file: File): Promise<ComposerAttachment | null> {
  if (!file.type.startsWith("image/")) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const maxSide = 1600;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const preferPng = file.type === "image/png" && scale === 1;
    const mime = preferPng ? "image/png" : "image/jpeg";
    const dataUrl = canvas.toDataURL(mime, 0.9);
    const comma = dataUrl.indexOf(",");
    const data = comma >= 0 ? dataUrl.slice(comma + 1) : "";
    if (!data) return null;
    return {
      id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      mime,
      data,
      name: file.name || "screenshot",
      previewUrl: URL.createObjectURL(file),
    };
  } catch {
    return null;
  }
}

export async function filesToAttachments(files: File[], max = 8): Promise<ComposerAttachment[]> {
  const out: ComposerAttachment[] = [];
  for (const f of files.slice(0, max)) {
    const a = await fileToAttachment(f);
    if (a) out.push(a);
  }
  return out;
}

export function imageFilesFromDataTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  return Array.from(dt.files ?? []).filter((f) => f.type.startsWith("image/"));
}

export function imageFilesFromClipboard(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items) return [];
  const files: File[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && file.type.startsWith("image/")) files.push(file);
  }
  return files;
}
