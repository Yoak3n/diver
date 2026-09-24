// @diver/self-prompt — 注册 revise-prompt skill（教模型如何自改提示词）。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { bundledPromptDir, overridePromptDir, skillDir } from './paths.ts'

export const REVISE_PROMPT_SKILL_ID = 'revise-prompt'

/** 读 skill 正文并填入运行时路径（模型需要绝对路径才能 write/edit）。每次 load 重读。 */
export function loadRevisePromptBody(): string {
  const file = join(skillDir(), 'revise-prompt.md')
  const raw = readFileSync(file, 'utf8')
  return raw
    .replaceAll('{{bundled_prompt_dir}}', bundledPromptDir())
    .replaceAll('{{override_prompt_dir}}', overridePromptDir())
}

export function applyRevisePromptSkill(ctx: Context): void {
  ctx.skills.register({
    id: REVISE_PROMPT_SKILL_ID,
    name: '修改自身提示词',
    description: '调整说话风格/提示词正文（热加载，下一拍生效）。当你或用户想改变你怎么说话、注入哪些提示词时使用。',
    body: () => loadRevisePromptBody(),
    source: join(skillDir(), 'revise-prompt.md'),
  })
}
