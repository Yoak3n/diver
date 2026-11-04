// slot 条目的排序与分发：纯函数，不依赖 Vue，便于单测。
//
// 基数语义：
//   single  → priority 最小者（同 priority 按注册先后）
//   list    → order 升序（同 order 按注册先后），可再按 id 过滤
//   keyed   → 按 entryKey 过滤，priority 升序
//   chain   → priority 升序，由 renderer 依次询问 select

import type {
  ResolvedEntry,
  ResolveOptions,
  SlotCardinality,
} from "../types";

export function sortByOrder(
  entries: readonly ResolvedEntry[],
): ResolvedEntry[] {
  return [...entries].sort((a, b) => a.order - b.order || a.uid - b.uid);
}

export function sortByPriority(
  entries: readonly ResolvedEntry[],
): ResolvedEntry[] {
  return [...entries].sort((a, b) => a.priority - b.priority || a.uid - b.uid);
}

export function pickSingle(
  entries: readonly ResolvedEntry[],
): ResolvedEntry[] {
  const sorted = sortByPriority(entries);
  return sorted.length > 0 ? [sorted[0]] : [];
}

export function filterByKey(
  entries: readonly ResolvedEntry[],
  key: string,
): ResolvedEntry[] {
  return sortByPriority(entries.filter((entry) => entry.key === key));
}

export function filterById(
  entries: readonly ResolvedEntry[],
  id: string,
): ResolvedEntry[] {
  return sortByOrder(entries.filter((entry) => entry.id === id));
}

export function resolveEntries(
  entries: readonly ResolvedEntry[],
  cardinality: SlotCardinality,
  opts?: ResolveOptions,
): ResolvedEntry[] {
  switch (cardinality) {
    case "single":
      return pickSingle(entries);
    case "keyed":
      return opts?.entryKey === undefined
        ? []
        : filterByKey(entries, opts.entryKey);
    case "chain":
      return sortByPriority(entries);
    case "list":
    default:
      return opts?.only === undefined
        ? sortByOrder(entries)
        : filterById(entries, opts.only);
  }
}
