// @diver/delegate —— 任务委派工具（0.2.0 codingagent 任务委派，拍板：小潜当工头）。
//
// delegate_task 派单给本机专职 coding agent（缺省 dsh headless，经适配器表可扩
// codex/claude/…）：壳层 core/delegate spawn CLI 并监督，进度摘要（inject 不吵）
// 与终态回报（next-turn 唤醒）自动进本会话——派单即返回，**不要轮询等待**。
// 运行中用户改要求 = cancel_task 后以合并指令重派（拍板：cancel+重派）。
//
// 取消息多通道（拍板 2026-09-29，别只被动等回报）：get_task_events 按
// source 组合三通道——stream（--json 事件流 tee，壳层）/ session（dsh 会话
// 日志，含完整文本与工具轨迹）/ checkpoint（投影摘要）。模型渠道规矩见
// skill「委派 dsh 的模型渠道」（dsh-provider.md）。
import { join } from 'node:path'
import type { Context } from 'cordis'
// 空类型导入：加载 @cos/plugin-api 对 cordis Context 的服务增强（tools 等）。
import type {} from '@cos/plugin-api'
import { nativeRpc } from '@diver/native-bridge/rpc'
import {
  dshHome,
  extractEntries,
  findSessionDir,
  readCheckpoint,
  readSessionLogLines,
} from './session-log.ts'
import { applyDshProviderSkill } from './skill.ts'

/** cordis 注入声明：工具注册台 + skill 注册台（裸函数插件会丢注入，必须显式声明）。 */
export const inject = ['tools', 'skills']

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

interface StreamDigestView {
  taskId: string
  sessionId?: string | null
  cwd?: string | null
  texts?: string[]
  toolCalls?: string[]
  finalText?: string | null
  error?: string | null
  turnEndReason?: string | null
  toolErrors?: number
}

const EVENT_SOURCES = ['all', 'stream', 'session', 'checkpoint']

export function apply(ctx: Context) {
  applyDshProviderSkill(ctx)

  ctx.tools.register('delegate_task', async (args: unknown) => {
    const a = (args ?? {}) as {
      task?: unknown
      agent?: unknown
      timeoutSecs?: unknown
      provider?: unknown
      model?: unknown
    }
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
          ...(typeof a.provider === 'string' && a.provider.trim() !== '' ? { provider: a.provider.trim() } : {}),
          ...(typeof a.model === 'string' && a.model.trim() !== '' ? { model: a.model.trim() } : {}),
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
      'cancel_task 取消，get_task_events 按需取细节。用户改要求时：取消旧任务、把合并后的' +
      '完整指令重新派单，并告知用户。模型渠道规矩见 skill「委派 dsh 的模型渠道」。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '任务正文（完整、可独立执行；含目标与验收口径）' },
        agent: { type: 'string', description: '执行者（缺省 dsh；可选值见 list_tasks 错误提示/设置）' },
        timeoutSecs: { type: 'number', description: '超时秒数（缺省 1800；超时按 stuck 求援）' },
        provider: {
          type: 'string',
          description: 'dsh 模型渠道（缺省 ark-agent-plan-cn；绝不填 deepseek 官方渠道，除非用户明确要求）',
        },
        model: { type: 'string', description: 'dsh 模型名（缺省 doubao-seed-2.1-pro）' },
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

  ctx.tools.register('get_task_events', async (args: unknown) => {
    const a = (args ?? {}) as { taskId?: unknown; source?: unknown; tail?: unknown; maxItems?: unknown }
    const taskId = String(a.taskId ?? '').trim()
    if (!taskId) {
      return { content: JSON.stringify({ error: 'taskId 必填' }) }
    }
    const source = EVENT_SOURCES.includes(String(a.source)) ? String(a.source) : 'all'
    const tail = typeof a.tail === 'number' && a.tail > 0 ? Math.min(a.tail, 64_000) : 4_000
    const maxItems = typeof a.maxItems === 'number' && a.maxItems > 0 ? Math.min(a.maxItems, 50) : 20
    try {
      const out: Record<string, unknown> = { taskId, source }
      const needStream = source === 'all' || source === 'stream'
      const digest = await nativeRpc<StreamDigestView>('delegate::events', { taskId }, { label: 'get_task_events' })
      if (needStream) {
        out.stream = digest
        out.rawTail = await nativeRpc<{ text: string; chars: number }>(
          'delegate::output',
          { taskId, tail },
          { label: 'get_task_events' },
        )
      }
      if (source === 'session' || source === 'checkpoint' || source === 'all') {
        const sessionId = String(digest?.sessionId ?? '').trim()
        if (!sessionId) {
          out.sessionId = null
          out.note = '任务尚未产出 --json session 事件（太早/非 dsh agent）'
        } else {
          out.sessionId = sessionId
          const home = dshHome()
          if (source === 'session' || source === 'all') {
            const dir = findSessionDir(join(home, 'sessions'), sessionId)
            out.session = dir
              ? extractEntries(readSessionLogLines(dir), maxItems)
              : '会话日志未找到（sessionId=' + sessionId + '）'
          }
          if (source === 'checkpoint' || source === 'all') {
            out.checkpoint = readCheckpoint(join(home, 'storages'), sessionId) ?? '检查点未找到'
          }
        }
      }
      return { content: JSON.stringify(out) }
    } catch (e) {
      return { content: JSON.stringify({ error: String((e as Error)?.message ?? e) }) }
    }
  }, {
    description:
      '多通道读取一个委派任务的消息（不用等回报，随时可取）：stream = --json 事件流摘要' +
      '（sessionId/文本/工具调用/终答）+ 尾部原文；session = dsh 会话日志条目（完整文本与' +
      '工具轨迹，进程死了也能读）；checkpoint = 投影摘要（title/统计）；all = 三通道组合。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 id（如 task-3）' },
        source: {
          type: 'string',
          description: '取哪条通道：all（缺省）/ stream / session / checkpoint',
          enum: EVENT_SOURCES,
        },
        tail: { type: 'number', description: 'stream 通道尾部原文字符数（缺省 4000）' },
        maxItems: { type: 'number', description: 'session 通道条目数上限（缺省 20）' },
      },
      required: ['taskId'],
    },
  })
}
