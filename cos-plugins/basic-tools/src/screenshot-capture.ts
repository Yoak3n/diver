// @diver/basic-tools — 截图 RPC 客户端（Rust 壳 /rpc screenshot::*）。
//
// 捕获引擎在 crates/diver-shot（GDI + JPEG），Node 只做参数与多模态返回。
// 不再内嵌 C# helper / PowerShell CopyFromScreen（AMSI）。

import { nativeRpc } from '@diver/native-bridge/rpc'

import { scaleToFit, SHOT_MAX_BYTES } from './screenshot-policy.ts'
import type { DisplayInfo, EncodePlan, Rect, ShotFormat } from './screenshot-policy.ts'

export interface CaptureFileResult {
  path: string
  bytes: number
  width: number
  height: number
  source: Rect
  format: ShotFormat
  quality: number
}

export interface ListDisplaysResult {
  displays: DisplayInfo[]
  virtualScreen: Rect
}

export interface WindowRect {
  title: string
  x: number
  y: number
  width: number
  height: number
  iconic: boolean
}

/** 枚举显示器（index / bounds / primary）。 */
export async function listDisplays(): Promise<ListDisplaysResult> {
  const data = await nativeRpc<ListDisplaysResult>('screenshot::list_displays', {}, {
    label: 'screenshot::list_displays',
  })
  return {
    displays: data.displays ?? [],
    virtualScreen: data.virtualScreen ?? { x: 0, y: 0, width: 0, height: 0 },
  }
}

/** 按标题子串找窗口矩形；找不到返回 null。 */
export async function findWindowRect(titleNeedle: string): Promise<WindowRect | null> {
  try {
    return await nativeRpc<WindowRect>('screenshot::window', { title: titleNeedle }, {
      label: 'screenshot::window',
    })
  } catch (error) {
    const message = (error as Error)?.message ?? String(error)
    if (message.includes('no visible window') || message.includes('SHOT_WINDOW')) {
      return null
    }
    throw error
  }
}

/** 按矩形捕获并编码为小体积 JPEG 文件（Rust 负责质量阶梯与落盘）。 */
export async function captureRect(
  rect: Rect,
  plan: EncodePlan,
  outPath: string,
): Promise<CaptureFileResult> {
  const fitted = scaleToFit(rect.width, rect.height, plan.maxWidth)
  const result = await nativeRpc<{
    path: string
    bytes: number
    width: number
    height: number
    source: Rect
    format?: string
    quality: number
  }>('screenshot::capture', {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    path: outPath,
    quality: plan.quality,
    maxWidth: fitted.width,
    maxBytes: Math.min(plan.maxBytes, SHOT_MAX_BYTES),
  }, { label: 'screenshot::capture' })
  return {
    path: result.path,
    bytes: result.bytes,
    width: result.width,
    height: result.height,
    source: result.source ?? rect,
    format: (result.format as ShotFormat) ?? 'jpeg',
    quality: result.quality,
  }
}

/** 显示器矩形（供裁剪校验）。 */
export function displayRect(d: DisplayInfo): Rect {
  return { x: d.x, y: d.y, width: d.width, height: d.height }
}
