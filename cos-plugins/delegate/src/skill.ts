// @diver/delegate —— 注册「委派 dsh 模型渠道」skill（提醒 agent 不走官方 API）。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'

export const DSH_PROVIDER_SKILL_ID = 'dsh-provider'

/** 读 skill 正文并填入运行时路径（模型要绝对路径才能读/改 overlay）。 */
export function loadDshProviderBody(): string {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'dsh-provider.md')
  const cosHome = process.env.COS_HOME ?? join(process.cwd(), '.cos-home')
  return readFileSync(file, 'utf8').replaceAll('{{cos_home}}', cosHome)
}

export function applyDshProviderSkill(ctx: Context): void {
  ctx.skills.register({
    id: DSH_PROVIDER_SKILL_ID,
    name: '委派 dsh 的模型渠道',
    description:
      '派单给 dsh 前必读：逐单指定 provider/model、绝不走 DeepSeek 官方 API、' +
      '以及 get_task_events 多通道取消息的用法。',
    body: () => loadDshProviderBody(),
    source: join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'dsh-provider.md'),
  })
}
