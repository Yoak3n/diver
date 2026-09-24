// @diver/basic-tools — 截图体积与几何纯逻辑（无 IO、可单测）。
// 目标：产物默认远小于 read 的 4MB 图片上限；读文字优先 1:1 裁区域，禁止整屏缩到糊字。

/** read 工具图片上限（对齐 read.ts）。 */
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024

/**
 * screenshot 产物硬上限。
 * 参照：QQ 整屏截图约 329KB；agent 侧目标同量级，绝不要数 MB 的 PNG。
 */
export const SHOT_MAX_BYTES = 800 * 1024

/** 整屏/大区域默认最长边（保留到近原生，靠 JPEG 压体积而不是糊字）。 */
export const DEFAULT_MAX_WIDTH = 1920

/** 区域截图默认最长边（读字 1:1，最多轻微缩）。 */
export const DEFAULT_REGION_MAX_WIDTH = 1600

/** 默认 JPEG 质量（QQ 量级体积的关键）。 */
export const DEFAULT_JPEG_QUALITY = 68

export type ShotFormat = 'jpeg' | 'png'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo extends Rect {
  index: number
  name: string
  primary: boolean
  work: Rect
}

export interface ScreenshotArgs {
  /** 目标显示器序号（list_displays 的 index）。与 region / window 三选一或组合裁剪。 */
  display?: number
  /** 虚拟屏坐标区域（物理像素）。与 display 同时给时按该屏裁剪校验。 */
  region?: Partial<Rect> & { width: number; height: number }
  /** 窗口标题子串（大小写不敏感）；命中则截该窗口。 */
  window?: string
  maxWidth?: number
  quality?: number
  format?: ShotFormat
  /** 输出路径；默认写到系统临时目录。 */
  path?: string
  /** text：读 UI 文字（少缩放、偏高 JPEG 质量）；overview：看全局布局。 */
  intent?: 'text' | 'overview'
}

function requirePositiveInt(value: unknown, name: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return n
}

function optionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  return requirePositiveInt(value, name)
}

/** 校验并补全截图参数。 */
export function parseScreenshotArgs(args: ScreenshotArgs): Required<Pick<ScreenshotArgs, 'format' | 'quality' | 'intent'>> & {
  display: number | undefined
  region: Rect | undefined
  window: string | undefined
  maxWidth: number | undefined
  path: string | undefined
} {
  let display: number | undefined
  if (args.display !== undefined && args.display !== null) {
    const d = Number(args.display)
    if (!Number.isFinite(d) || !Number.isInteger(d) || d < 0) {
      throw new Error('display must be a non-negative integer index (see list_displays)')
    }
    display = d
  }

  let region: Rect | undefined
  if (args.region !== undefined) {
    const r = args.region
    const width = requirePositiveInt(r.width, 'region.width')
    const height = requirePositiveInt(r.height, 'region.height')
    const x = r.x === undefined ? 0 : Number(r.x)
    const y = r.y === undefined ? 0 : Number(r.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('region.x/y must be finite numbers')
    region = { x, y, width, height }
  }

  const window = typeof args.window === 'string' && args.window.trim().length > 0
    ? args.window.trim()
    : undefined

  if (display === undefined && region === undefined && window === undefined) {
    throw new Error('provide display, region, or window — full virtual-screen dumps are intentionally not the default')
  }

  const format: ShotFormat = args.format === undefined ? 'jpeg' : args.format
  if (format !== 'jpeg' && format !== 'png') throw new Error('format must be "jpeg" or "png"')

  const intent = args.intent === undefined ? (region ? 'text' : 'overview') : args.intent
  if (intent !== 'text' && intent !== 'overview') throw new Error('intent must be "text" or "overview"')

  const quality = args.quality === undefined
    ? (intent === 'text' ? 78 : DEFAULT_JPEG_QUALITY)
    : requirePositiveInt(args.quality, 'quality')
  if (quality > 100) throw new Error('quality must be 1..100')

  const maxWidth = optionalPositiveInt(args.maxWidth, 'maxWidth')

  const path = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : undefined

  return { display: args.display === undefined ? undefined : Number(args.display), region, window, maxWidth, quality, format, path, intent }
}

/** 区域与显示器求交；完全在外时 outside=true。 */
export function clampRegionToDisplay(region: Rect, display: Rect): { region: Rect | null; clipped: boolean; outside: boolean } {
  const x1 = Math.max(region.x, display.x)
  const y1 = Math.max(region.y, display.y)
  const x2 = Math.min(region.x + region.width, display.x + display.width)
  const y2 = Math.min(region.y + region.height, display.y + display.height)
  if (x2 <= x1 || y2 <= y1) return { region: null, clipped: false, outside: true }
  const clippedRect = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
  const clipped = clippedRect.x !== region.x || clippedRect.y !== region.y
    || clippedRect.width !== region.width || clippedRect.height !== region.height
  return { region: clippedRect, clipped, outside: false }
}

/** 点落在哪块屏（用于校验目标窗口/区域）。 */
export function displayAtPoint(x: number, y: number, displays: DisplayInfo[]): DisplayInfo | undefined {
  return displays.find((d) => x >= d.x && y >= d.y && x < d.x + d.width && y < d.y + d.height)
}

export interface EncodePlan {
  /** 采样后最长边上限（1=不缩放）。 */
  maxWidth: number
  quality: number
  format: ShotFormat
  maxBytes: number
  /** 是否允许编码后再降质/再缩（救回超限产物）。 */
  allowDegrade: boolean
}

/** 按意图与几何决定缩放/编码计划。 */
export function planEncode(options: {
  source: Rect
  region?: Rect
  maxWidth?: number
  quality: number
  format: ShotFormat
  intent: 'text' | 'overview'
}): EncodePlan {
  const isRegion = options.region !== undefined
  const fallback = isRegion ? DEFAULT_REGION_MAX_WIDTH : DEFAULT_MAX_WIDTH
  // 读字：除非用户指定，否则最长边最多略大于区域，避免糊字。
  const intentCap = options.intent === 'text' ? DEFAULT_REGION_MAX_WIDTH : DEFAULT_MAX_WIDTH
  const maxWidth = Math.max(
    1,
    Math.min(options.maxWidth ?? fallback, isRegion ? Math.max(options.source.width, 1) : intentCap * 2),
  )
  return {
    maxWidth,
    quality: options.quality,
    format: options.format,
    maxBytes: SHOT_MAX_BYTES,
    allowDegrade: true,
  }
}

/** 质量阶梯：JPEG 超限时逐档降质（对齐 QQ 级小产物）。 */
export function jpegQualityLadder(preferred: number): number[] {
  const start = Math.min(100, Math.max(1, Math.round(preferred)))
  const steps = [start, 55, 42, 32]
  return [...new Set(steps)]
}

/** 估算缩放后边长（整数、不放大）。 */
export function scaleToFit(width: number, height: number, maxWidth: number): { width: number; height: number; scaled: boolean } {
  if (width <= maxWidth) return { width, height, scaled: false }
  const ratio = maxWidth / width
  return {
    width: maxWidth,
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  }
}

/** 给模型看的一句体积/清晰度提示。 */
export function sizeHint(intent: 'text' | 'overview', bytes: number, scaled: boolean): string {
  const kb = Math.max(1, Math.round(bytes / 1024))
  if (intent === 'text' && scaled) {
    return `${kb}KB (scaled — if text is blurry, re-screenshot a tighter region at 1:1 rather than shrinking the whole screen)`
  }
  if (intent === 'text') return `${kb}KB (1:1 crop preferred for reading text)`
  return `${kb}KB (overview; for fine text prefer a region crop over downscaling)`
}
