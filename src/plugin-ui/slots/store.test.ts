import { describe, expect, it } from "vitest";
import { defineStore } from "./store";

describe("defineStore", () => {
  it("commit 触发 selector 重算", () => {
    const store = defineStore(
      () => ({ count: 0 }),
      (state, commit) => ({
        inc: () => {
          state.count += 1;
          commit();
        },
      }),
    );
    const count = store.useStore((state) => state.count);
    expect(count.value).toBe(0);
    store.actions.inc();
    expect(count.value).toBe(1);
  });

  it("无 commit 的变更不通知", () => {
    const store = defineStore(
      () => ({ count: 0 }),
      (state) => ({
        silent: () => {
          state.count += 1;
        },
      }),
    );
    const count = store.useStore((state) => state.count);
    expect(count.value).toBe(0);
    store.actions.silent();
    expect(count.value).toBe(0);
  });
});
