import { describe, expect, it } from "vitest";
import type { Component } from "vue";
import type { ResolvedEntry } from "../types";
import {
  filterByKey,
  filterById,
  pickSingle,
  resolveEntries,
  sortByOrder,
  sortByPriority,
} from "./entries";

const Dummy = { render: () => null } as unknown as Component;

function entry(
  partial: Partial<ResolvedEntry> & Pick<ResolvedEntry, "uid" | "name">,
): ResolvedEntry {
  return {
    plugin: "test",
    order: 0,
    priority: 0,
    component: Dummy,
    children: new Set(),
    ...partial,
  };
}

const a = entry({ uid: 1, name: "settings.tab", id: "a", order: 2 });
const b = entry({ uid: 2, name: "settings.tab", id: "b", order: 1 });
const c = entry({
  uid: 3,
  name: "settings.tab",
  id: "a",
  order: 3,
  key: "k",
});

describe("entries", () => {
  it("list 按 order 升序、同序按 uid", () => {
    expect(sortByOrder([a, b]).map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("priority 升序、同值按 uid", () => {
    const low = entry({ uid: 4, name: "settings.tab", priority: -1 });
    expect(sortByPriority([a, low]).map((item) => item.uid)).toEqual([4, 1]);
  });

  it("single 只取 priority 最小者", () => {
    const low = entry({ uid: 4, name: "settings.tab", priority: -1 });
    expect(pickSingle([a, low]).map((item) => item.uid)).toEqual([4]);
    expect(pickSingle([])).toEqual([]);
  });

  it("list + only 按 id 过滤", () => {
    expect(filterById([a, b, c], "a").map((item) => item.uid)).toEqual([1, 3]);
  });

  it("keyed 按 key 过滤", () => {
    expect(filterByKey([a, c], "k").map((item) => item.uid)).toEqual([3]);
  });

  it("keyed 缺 entryKey 时返回空", () => {
    expect(resolveEntries([a, c], "keyed")).toEqual([]);
  });

  it("list 无 only 时返回全部", () => {
    expect(resolveEntries([a, b, c], "list").map((item) => item.uid)).toEqual([
      2, 1, 3,
    ]);
  });

  it("chain 返回 priority 排序后的全部", () => {
    const low = entry({ uid: 4, name: "settings.tab", priority: -1 });
    expect(resolveEntries([a, low], "chain").map((item) => item.uid)).toEqual([
      4, 1,
    ]);
  });
});
