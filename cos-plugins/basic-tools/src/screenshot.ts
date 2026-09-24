// @diver/basic-tools — screenshot / list_displays 工具。
// 产物默认 JPEG 压到几百 KB（对齐 QQ 整屏量级）；读小字用 region 1:1，禁止整屏缩糊。
// 捕获前 list_displays 建立「屏幕编号 → bounds → 主副屏」映射；截完校验 bounds。

import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from 'cordis'

import {
  clampRegionToDisplay,
  displayAtPoint,
  parseScreenshotArgs,
  planEncode,
  sizeHint,
} from './screenshot-policy.ts'
import type { Rect, ScreenshotArgs } from './screenshot-policy.ts'
import {
  captureRect,
  displayRect,
  findWindowRect,
  listDisplays,
} from './screenshot-capture.ts'

export interface ScreenshotCaps {
  /** 捕获超时（毫秒），默认 20s。 */
  timeoutMs?: number
}

function mimeOf(format: 'jpeg' | 'png'): string {
  return format === 'png' ? 'image/png' : 'image/jpeg'
}

/** 注册 list_displays + screenshot。 */
export function applyScreenshotTools(ctx: Context, caps: ScreenshotCaps = {}): void {
  const timeoutMs = Number(caps.timeoutMs) || 20_000

  ctx.systemPrompt.section({
    name: 'tool:screenshot',
    order: 104,
    text:
      'Desktop screenshots: call list_displays first (screen index → bounds → primary). ' +
      'Prefer the screenshot tool — never dump multi-MB PNGs via sh/PowerShell. ' +
      'Full-screen JPEG is fine for overview (target well under 1MB). ' +
      'To READ text/UI detail, pass a tight region (virtual-screen x,y,width,height) at 1:1 — do not downscale a whole screen until text is blurry. ' +
      'After capture, check the returned source bounds: if the target window is not on that display, re-capture the right one.',
  })

  ctx.tools.register('list_displays', async () => {
    const result = await listDisplays()
    const lines = result.displays.map((d) => {
      const role = d.primary ? 'primary' : 'secondary'
      return `display ${d.index}: ${d.name} ${d.width}x${d.height} @ (${d.x},${d.y}) ${role}`
    })
    const vs = result.virtualScreen
    return {
      content: [
        'Displays (physical pixels, virtual-screen coordinates):',
        ...lines,
        `virtual screen: ${vs.width}x${vs.height} @ (${vs.x},${vs.y})`,
        'Use screenshot display=N for a full screen, or region={x,y,width,height} for a crop.',
      ].join('\n'),
    }
  }, {
    description: 'List monitors: index, name, bounds, primary/secondary. Call this before screenshot to map screen numbers correctly.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  })

  ctx.tools.register('screenshot', async (args) => {
    const input = parseScreenshotArgs(args as ScreenshotArgs)

    let rect: Rect
    let sourceLabel: string
    let displays: Awaited<ReturnType<typeof listDisplays>>['displays'] | null = null

    if (input.window) {
      const win = await findWindowRect(input.window)
      if (win === null) {
        throw new Error(`no visible window matching "${input.window}" — call list_displays / try another title substring`)
      }
      if (win.iconic) {
        throw new Error(`window "${win.title}" is minimized; restore it and retry`)
      }
      rect = { x: win.x, y: win.y, width: win.width, height: win.height }
      sourceLabel = `window "${win.title}"`
    } else if (input.region) {
      rect = input.region
      sourceLabel = `region (${rect.x},${rect.y}) ${rect.width}x${rect.height}`
    } else {
      displays = (await listDisplays()).displays
      const d = displays.find((item) => item.index === input.display)
      if (d === undefined) {
        throw new Error(`display ${input.display} not found; valid: ${displays.map((x) => x.index).join(', ')}`)
      }
      rect = displayRect(d)
      sourceLabel = `display ${d.index} (${d.primary ? 'primary' : 'secondary'}) ${d.width}x${d.height}`
    }

    // 映射校验：region/display 与屏 bounds 对齐，目标不在预期屏则拒绝或裁剪。
    let displayHit: { index: number; primary: boolean } | undefined
    if (displays === null && (input.display !== undefined || input.region)) {
      displays = (await listDisplays()).displays
    }
    if (displays) {
      if (input.display !== undefined && input.region) {
        const d = displays.find((item) => item.index === input.display)
        if (!d) throw new Error(`display ${input.display} not found`)
        const hit = clampRegionToDisplay(input.region, displayRect(d))
        if (hit.outside || hit.region === null) {
          throw new Error(
            `region (${input.region.x},${input.region.y},${input.region.width},${input.region.height}) does not overlap display ${d.index} bounds (${d.x},${d.y},${d.width},${d.height}) — re-list displays and pick the right screen`,
          )
        }
        if (hit.clipped) {
          rect = hit.region
          sourceLabel += ' [clipped to display]'
        }
      }
      const cx = rect.x + Math.floor(rect.width / 2)
      const cy = rect.y + Math.floor(rect.height / 2)
      const hit = displayAtPoint(cx, cy, displays)
      if (hit) displayHit = { index: hit.index, primary: hit.primary }
    }

    const plan = planEncode({
      source: rect,
      region: input.region ?? (input.window ? rect : undefined),
      maxWidth: input.maxWidth,
      quality: input.quality,
      format: input.format,
      intent: input.intent,
    })

    const dest = input.path ?? join(tmpdir(), `diver-shot-${Date.now()}.jpg`)
    const file = await captureRect(rect, plan, dest)
    if (file.bytes <= 0) throw new Error('capture produced an empty file')

    const raw = await readFile(file.path)
    const mime = mimeOf(file.format)
    const name = file.path.split(/[\\/]/).pop() ?? 'screenshot'
    const scaled = file.width < rect.width || file.height < rect.height
    const where = displayHit ? ` display ${displayHit.index}${displayHit.primary ? ' (primary)' : ''}` : ''

    const content = [
      `Captured ${sourceLabel}${where}: ${file.width}x${file.height} → ${file.path}`,
      `size: ${sizeHint(input.intent, file.bytes, scaled)}`,
      `source bounds: (${file.source.x},${file.source.y}) ${file.source.width}x${file.source.height}`,
      displayHit
        ? `screen check: center on display ${displayHit.index} — if the target window is elsewhere, re-screenshot that display/region`
        : 'screen check: verify bounds against list_displays before trusting this crop',
      'Image attached as a multimodal block. Prefer region crops when you need to read small text.',
    ].join('\n')

    await stat(file.path) // 存在性校验
    return {
      content,
      images: [{ mime, data: raw.toString('base64'), name }],
    }
  }, {
    description:
      'Capture a display, region, or window as a compact JPEG (QQ-sized, well under 1MB). list_displays first. Use region for reading text at 1:1.',
    parameters: {
      type: 'object',
      properties: {
        display: { type: 'number', description: 'Display index from list_displays (0-based). Captures that whole screen if no region/window.' },
        region: {
          type: 'object',
          description: 'Crop in virtual-screen physical pixels: {x,y,width,height}. Best for reading text.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['width', 'height'],
        },
        window: { type: 'string', description: 'Visible window title substring (case-insensitive). Captures that window.' },
        intent: { type: 'string', enum: ['text', 'overview'], description: 'text = keep sharp for reading; overview = layout. Defaults: region→text, else overview.' },
        maxWidth: { type: 'number', description: 'Cap output width in px (default 1920 overview / 1600 region). Lower = smaller file.' },
        quality: { type: 'number', description: 'JPEG quality 1-100 (default 68 overview / 78 text). Lower = smaller file.' },
        format: { type: 'string', enum: ['jpeg', 'png'], description: 'Default jpeg (small). png currently maps to jpeg on the Rust encoder.' },
        path: { type: 'string', description: 'Output path. Defaults to a temp .jpg you can read later.' },
      },
    },
  })
}
