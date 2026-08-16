// Diver companion — Context 类型扩展激活与补充。
//
// dsh 各包通过 declare module 给 cordis Context 增加 service 属性
// （subagents/agentDefaultModel/settings/...），但这些声明只有在对应包的
// .d.ts 被加载时才生效；这里用 type-only 空导入激活（运行时被
// type-stripping 剥离，零副作用）。另补充 dispose 生命周期事件声明
// （框架服务用 ctx.on('dispose') 注册）。

import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-session-persistence'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** 服务/插件卸载生命周期钩子（ctx.on('dispose')）。 */
    'dispose'(): void
  }
}
