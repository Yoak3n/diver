// @diver/memory — 工具面（实体图谱）：entity。
// 实体图谱由 entity 显式声明写入（不做规则抽取），recall 一跳展开补多跳召回。

import type { Context } from 'cordis'
// Load Cordis Context service-key declarations (ctx.tools …).
import type {} from '@cos/plugin-api'

import type { MemoryStore } from './store-rpc.ts'

/** 注册实体图谱工具：entity。 */
export function registerEntityTool(ctx: Context, store: MemoryStore): void {
  ctx.tools.register('entity', async (args) => {
    const a = (args ?? {}) as {
      name?: unknown
      type?: unknown
      attrs?: unknown
      relations?: unknown
      reason?: unknown
    }
    const name = typeof a.name === 'string' ? a.name.trim() : ''
    if (!name) return { content: '缺少实体 name，未写入', isError: true }

    const entityType = typeof a.type === 'string' && a.type.trim() ? a.type.trim() : undefined
    const attrs: Record<string, string> = {}
    if (a.attrs && typeof a.attrs === 'object' && !Array.isArray(a.attrs)) {
      for (const [k, v] of Object.entries(a.attrs as Record<string, unknown>)) {
        const key = k.trim()
        const val = typeof v === 'string' ? v.trim() : ''
        if (key && val) attrs[key] = val
      }
    }
    const relations: Array<{ to: string; relation: string; toType?: string }> = []
    if (Array.isArray(a.relations)) {
      for (const item of a.relations) {
        const o = item as { to?: unknown; relation?: unknown; toType?: unknown }
        const to = typeof o.to === 'string' ? o.to.trim() : ''
        const relation = typeof o.relation === 'string' ? o.relation.trim() : ''
        if (!to || !relation || to === name) continue
        const toType = typeof o.toType === 'string' && o.toType.trim() ? o.toType.trim() : undefined
        relations.push(toType ? { to, relation, toType } : { to, relation })
      }
    }
    if (Object.keys(attrs).length === 0 && relations.length === 0 && !entityType) {
      return { content: '未提供 type / attrs / relations，未写入', isError: true }
    }

    const graph = await store.upsertEntityGraph({
      name,
      ...(entityType ? { entityType } : {}),
      ...(Object.keys(attrs).length ? { attrs } : {}),
      ...(relations.length ? { relations } : {}),
    })
    store.markDirty()
    const reason = typeof a.reason === 'string' && a.reason.trim() ? `（依据：${a.reason.trim()}）` : ''
    return {
      content: JSON.stringify({
        entity: graph.entity.name,
        type: graph.entity.entityType ?? null,
        attrs: Object.fromEntries(graph.attrs.map((x) => [x.attrKey, x.attrValue])),
        related: graph.neighbors.map((n) => ({
          to: n.entity.name,
          relation: n.direction === 'out' ? n.relation : `←${n.relation}`,
        })),
        note: `已写入实体图谱${reason}`,
      }),
    }
  }, {
    description:
      '把人/物/地点/项目等实体，以及它们的属性和关系写入知识图谱。只写你有把握、值得长期记住的结构化事实（如「小明-同事-李雷」「用户-不吃-香菜」）。一次调用可同时声明属性与关系；重复写入会合并加强，不要用来记一次性寒暄。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '实体名（主语），如"用户"、"小明"、"吉他"' },
        type: { type: 'string', description: '实体类型（可选），如 person / place / project / habit / food' },
        attrs: {
          type: 'object',
          description: '属性键值（可选），如 {"职业":"Rust 工程师","忌口":"香菜"}',
          additionalProperties: { type: 'string' },
        },
        relations: {
          type: 'array',
          description: '从本实体指出的关系（可选），如 [{"to":"小明","relation":"同事"}]',
          items: {
            type: 'object',
            properties: {
              to: { type: 'string', description: '目标实体名（不存在会自动创建）' },
              relation: { type: 'string', description: '关系名，如 同事 / 喜欢 / 不吃 / 在学' },
              toType: { type: 'string', description: '目标实体类型（可选）' },
            },
            required: ['to', 'relation'],
          },
        },
        reason: { type: 'string', description: '写入依据（可选）' },
      },
      required: ['name'],
    },
  })
}
