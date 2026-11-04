import { describe, expect, it, vi } from "vitest";
import type { Component } from "vue";
import { SlotRegistry } from "./registry";

const Dummy = { render: () => null } as unknown as Component;

describe("SlotRegistry", () => {
  it("declare 后 register 可解析", () => {
    const registry = new SlotRegistry();
    const dispose = registry.declare("settings.tab");
    registry.register({ name: "settings.tab", id: "a" }, Dummy);
    expect(registry.resolve("settings.tab").map((entry) => entry.id)).toEqual([
      "a",
    ]);
    dispose.dispose();
    expect(registry.resolve("settings.tab")).toEqual([]);
  });

  it("未声明时 register 抛错", () => {
    const registry = new SlotRegistry();
    expect(() =>
      registry.register({ name: "settings.tab", id: "a" }, Dummy),
    ).toThrow(/未声明/);
  });

  it("重复 declare 抛错", () => {
    const registry = new SlotRegistry();
    registry.declare("settings.tab");
    expect(() => registry.declare("settings.tab")).toThrow(/已有 owner/);
  });

  it("inject 在声明前排队、声明后运行、折叠后移除、重声明重跑", () => {
    const registry = new SlotRegistry();
    const register = vi.fn(() =>
      registry.register({ name: "settings.tab", id: "a" }, Dummy),
    );
    const disposeInject = registry.inject("settings.tab", register);
    expect(register).not.toHaveBeenCalled();

    const disposeDeclare = registry.declare("settings.tab");
    expect(register).toHaveBeenCalledTimes(1);
    expect(registry.resolve("settings.tab")).toHaveLength(1);

    disposeDeclare.dispose();
    expect(registry.resolve("settings.tab")).toHaveLength(0);

    registry.declare("settings.tab");
    expect(register).toHaveBeenCalledTimes(2);
    expect(registry.resolve("settings.tab")).toHaveLength(1);

    disposeInject.dispose();
    expect(registry.resolve("settings.tab")).toHaveLength(0);
  });

  it("forPlugin 记录插件名", () => {
    const registry = new SlotRegistry();
    registry.declare("settings.tab");
    registry
      .forPlugin("onebot-ui")
      .register({ name: "settings.tab", id: "onebot" }, Dummy);
    expect(registry.resolve("settings.tab")[0]?.plugin).toBe("onebot-ui");
  });

  it("has 同时匹配 id 与 key", () => {
    const registry = new SlotRegistry();
    registry.declare("settings.tab");
    registry.register({ name: "settings.tab", id: "a", key: "k" }, Dummy);
    expect(registry.has("settings.tab", "a")).toBe(true);
    expect(registry.has("settings.tab", "k")).toBe(true);
    expect(registry.has("settings.tab", "x")).toBe(false);
  });

  it("subscribe 在变更时通知，退订后停止", () => {
    const registry = new SlotRegistry();
    const listener = vi.fn();
    const stop = registry.subscribe(listener);
    const dispose = registry.declare("settings.tab");
    expect(listener).toHaveBeenCalled();
    stop();
    const before = listener.mock.calls.length;
    dispose.dispose();
    expect(listener.mock.calls.length).toBe(before);
  });
});
