// @diver/self-prompt — 自改提示词入口插件（原 @diver/voice）。
//
// 职责：
//  1. 每次 assemble 热读 prompts/*.md（正文 + order），注入 systemPrompt section；
//  2. 挂 revise-prompt skill，教模型用现有 read/write/edit 自改这些文件；
//  3. 提供 restart_agent（保留能力，但改提示词不必走重启）；重启完成注入系统事件。
//
// 设计边界：
//  - 不碰「我是谁」（memory identity），只提供可编辑的提示词槽位与自改回路；
//  - 编排交给 @cos/system-prompt；本插件只做装载 + 防御性校验。
//
// 接入：bundle insert `{ id: self-prompt, name: '@diver/self-prompt' }`。

import type { Context } from 'cordis'
import type { AssembledSection, PromptAssembly } from '@cos/plugin-api'
import { applyRestartEvent } from './resume.ts'
import { applyRestartTool } from './restart.ts'
import { applyRevisePromptSkill } from './skill.ts'
import { bundledPromptDir, overridePromptDir } from './paths.ts'
import {
  SECTION_PREFIX,
  collectLiveSlots,
  sectionNameOf,
} from './prompts.ts'

export const name = 'self-prompt'

export const inject = ['systemPrompt', 'tools', 'skills']

export function apply(ctx: Context) {
  applyRevisePromptSkill(ctx)
  applyRestartTool(ctx)
  applyRestartEvent(ctx)

  // 热加载：每次组装重读 prompts/*.md，改完下一拍生效，不必 restart。
  // 错误只告警一次（assemble 会反复跑，避免刷屏）。
  const warned = new Set<string>()
  const warnOnce = (err: string) => {
    if (warned.has(err)) return
    warned.add(err)
    console.warn(`[self-prompt] 跳过坏 prompt: ${err}`)
  }

  ctx.on('system-prompt/assemble', (assembly: PromptAssembly, _context, next) => {
    const { slots, errors } = collectLiveSlots(bundledPromptDir(), overridePromptDir())
    for (const err of errors) warnOnce(err)
    const others = assembly.sections.filter((s) => !s.name.startsWith(SECTION_PREFIX))
    const ours: AssembledSection[] = slots.map((slot) => ({
      name: sectionNameOf(slot.name),
      text: slot.text,
      order: slot.order,
    }))
    assembly.sections = [...others, ...ours].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name),
    )
    return next()
  })

  const first = collectLiveSlots(bundledPromptDir(), overridePromptDir())
  for (const err of first.errors) warnOnce(err)
  for (const slot of first.slots) {
    console.log(`[self-prompt] 槽位 ${sectionNameOf(slot.name)}（order ${slot.order}）← ${slot.source}`)
  }
  if (first.slots.length === 0) {
    console.warn('[self-prompt] 未装载任何 prompt 槽位（prompts/*.md 为空或全部非法）')
  }
  console.log('[self-prompt] 就绪（skill: revise-prompt + restart_agent；prompts 热加载）')
}
