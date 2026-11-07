// onebot 群聊档位的表单侧纯逻辑：解析「群号=档位」、按监听列表序列化。
// 与 sidecar 的 config.ts 同形（逗号分隔、群号=档位），但这里只管 UI 草稿。

export type GroupTier = 'chatty' | 'normal' | 'quiet' | 'mute'

export interface GroupTierOption {
  value: GroupTier
  label: string
}

export const GROUP_TIER_OPTIONS: readonly GroupTierOption[] = [
  { value: 'normal', label: '常规（默认）' },
  { value: 'chatty', label: '活跃' },
  { value: 'quiet', label: '安静' },
  { value: 'mute', label: '只听不回' },
]

function isTier(value: string | undefined): value is GroupTier {
  return GROUP_TIER_OPTIONS.some((option) => option.value === value)
}

/** 监听列表：逗号分隔，只认数字群号，去重保序。 */
export function parseGroupIds(text: string): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const part of text.split(',')) {
    const id = part.trim()
    if (!/^\d+$/.test(id) || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/** 「群号=档位」→ map；未知档位与非数字群号忽略，normal 不落配置。 */
export function parseTierMap(text: string): Record<string, GroupTier> {
  const map: Record<string, GroupTier> = {}
  for (const entry of text.split(',')) {
    const [id, tier] = entry.split('=').map((part) => part.trim())
    if (id === undefined || !/^\d+$/.test(id)) continue
    if (!isTier(tier) || tier === 'normal') continue
    map[id] = tier
  }
  return map
}

export function tierOf(map: Record<string, GroupTier>, groupId: string): GroupTier {
  return map[groupId] ?? 'normal'
}

/** 只写「监听列表里且非 normal」的群，顺序跟监听列表一致；列表外的旧条目顺手清掉。 */
export function serializeTierMap(
  map: Record<string, GroupTier>,
  groupIds: readonly string[],
): string {
  return groupIds
    .filter((id) => tierOf(map, id) !== 'normal')
    .map((id) => `${id}=${tierOf(map, id)}`)
    .join(', ')
}

/**
 * 改一个群的档位：返回新的「群号=档位」文本。
 * 选回 normal 即删除该群条目；未知档位不改动原文本。
 */
export function setGroupTier(
  text: string,
  groupsText: string,
  groupId: string,
  tier: string,
): string {
  if (!isTier(tier)) return text
  const map = parseTierMap(text)
  if (tier === 'normal') delete map[groupId]
  else map[groupId] = tier
  return serializeTierMap(map, parseGroupIds(groupsText))
}
