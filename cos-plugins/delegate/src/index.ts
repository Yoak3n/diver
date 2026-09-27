// @diver/delegate —— 任务委派工具（0.2.0 codingagent 任务委派，拍板：小潜当工头）。
//
// delegate_task 派单给本机专职 coding agent（缺省 dsh headless，经适配器表可扩
// codex/claude/…）：壳层 core/delegate spawn CLI 并监督，进度摘要（inject 不吵）
// 与终态回报（next-turn 唤醒）自动进本会话——派单即返回，**不要轮询等待**。
// 运行中用户改要求 = cancel_task 后以合并指令重派（拍板：cancel+重派）。
import type { Context } from 'cordis'
// 空类型导入：加载 @cos/plugin-api 对 cordis Context 的服务增强（tools 等）。
import type {} from '@cos/plugin-api'
import { nativeRpc } from '@diver/native-bridge/rpc'

/** cordis 注入声明：工具注册台（裸函数插件会丢注入，必须显式声明）。 */
export const inject = ['tools']

interface SpawnResult {
  taskId: string
  agent: string
  timeoutSecs?: number
  note?: string
}

interface TaskView {
  id: string
  agent: string
  status: string
  task: string
  exitCode?: number | null
  summary?: string
  createdAt?: number
  endedAt?: number | null
}

export function apply(ctx: Context) {
  ctx.tools.register('delegate_task', async (args: unknown) => {
    const a = (args ?? {}) as { task?: unknown; agent?: unknown; timeoutSecs?: unknown }
    const task = String(a.task ?? '').trim()
    if (!task) {
      return { content: JSON.stringify({ error: 'task 必填' }) }
    }
    try {
      const data = await nativeRpc<SpawnResult>(
        'delegate::spawn',
        {
          task,
          ...(typeof a.agent === 'string' && a.agent.trim() !== '' ? { agent: a.agent.trim() } : {}),
          ...(typeof a.timeoutSecs === 'number' && a.timeoutSecs >= 30 ? { timeoutSecs: a.timeoutSecs } : {}),
        },
        { label: 'delegate_task' },
      )
      return {
        content: JSON.stringify({
          taskId: data.taskId,
          agent: data.agent,
          note: data.note ?? '已受理；进度与终态自动回报，不要轮询。',
        }),
      }
    } catch (e) {
      return { content: JSON.stringify({ error: String((e as Error)?.message ?? e) }) }
    }
  }, {
    description:
      '把一个 coding 任务派给本机专职 coding agent（缺省 dsh），并进入监督：进度摘要与' +
      '完成/失败/超时回报会自动出现在会话里，无需轮询。立即返回 taskId；用 list_tasks 查状态，' +
      'cancel_task 取消。用户改要求时：取消旧任务、把合并后的完整指令重新派单，并告知用户。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '任务正文（完整、可独立执行；含目标与验收口径）' },
        agent: { type: 'string', description: '执行者（缺省 dsh；可选值见 list_tasks 错误提示/设置）' },
        timeoutSecs: { type: 'number', description: '超时秒数（缺省 1800；超时按 stuck 求援）' },
      },
      required: ['task'],
    },
  })

  ctx.tools.register('list_tasks', async (args: unknown) => {
    const a = (args ?? {}) as { status?: unknown }
    try {
      const data = await nativeRpc<{ tasks: TaskView[] }>(
        'delegate::list',
        typeof a.status === 'string' && a.status.trim() !== '' ? { status: a.status.trim() } : {},
        { label: 'list_tasks' },
      )
      return { content: JSON.stringify(data) }
    } catch (e) {
      return { content: JSON.stringify({ error: String((e as Error)?.message ?? e) }) }
    }
  }, {
    description:
      '查询委派任务清单（状态 queued/running/done/failed/stuck/cancelled/unknown）。' +
      'unknown 表示壳层重启导致结果不可知：不要假报完成，向用户说明并可重派。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '按状态过滤（缺省全部）' },
      },
    },
  })

  ctx.tools.register('cancel_task', async (args: unknown) => {
    const a = (args ?? {}) as { taskId?: unknown }
    const taskId = String(a.taskId ?? '').trim()
    if (!taskId) {
      return { content: JSON.stringify({ error: 'taskId 必填' }) }
    }
    try {
      const data = await nativeRpc<{ ok: boolean; note?: string }>(
        'delegate::cancel',
        { taskId },
        { label: 'cancel_task' },
      )
      return { content: JSON.stringify({ taskId, ...data }) }
    } catch (e) {
      return { content: JSON.stringify({ error: String((e as Error)?.message ?? e) }) }
    }
  }, {
    description: '取消一个委派任务（杀进程树，终态回报自动到达）。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 id（如 task-3）' },
      },
      required: ['taskId'],
    },
  })
}
