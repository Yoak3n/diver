import { describe, expect, it } from "vitest";
import type { Component } from "vue";
import type { ClientPlugin, ClientServices } from "../types";
import { DisposableBag, mountPlugins } from "./lifecycle";
import { SlotRegistry } from "./registry";

const Dummy = { render: () => null } as unknown as Component;

function services(registry: SlotRegistry): ClientServices {
  return {
    slots: registry,
    api: {} as ClientServices["api"],
    instances: {} as ClientServices["instances"],
    i18n: { t: (key, fallback) => fallback ?? key },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe("DisposableBag", () => {
  it("LIFO 清理且幂等", () => {
    const order: number[] = [];
    const bag = new DisposableBag();
    bag.add(() => order.push(1));
    bag.add(() => order.push(2));
    bag.dispose();
    bag.dispose();
    expect(order).toEqual([2, 1]);
  });

  it("清理项抛错不阻断后续", () => {
    const order: number[] = [];
    const bag = new DisposableBag();
    bag.add(() => {
      throw new Error("boom");
    });
    bag.add(() => order.push(1));
    bag.dispose();
    expect(order).toEqual([1]);
  });
});

describe("mountPlugins", () => {
  it("插件注册带插件名，dispose 后条目移除", () => {
    const registry = new SlotRegistry();
    registry.declare("settings.tab");
    const plugin: ClientPlugin = {
      name: "acme",
      apply(ctx) {
        ctx.slots.register({ name: "settings.tab", id: "acme" }, Dummy);
      },
    };
    const mounted = mountPlugins([plugin], services(registry), registry);
    expect(registry.resolve("settings.tab")[0]?.plugin).toBe("acme");
    mounted[0]?.dispose();
    expect(registry.resolve("settings.tab")).toEqual([]);
  });

  it("apply 抛错只跳过该插件", () => {
    const registry = new SlotRegistry();
    const bad: ClientPlugin = {
      name: "bad",
      apply() {
        throw new Error("boom");
      },
    };
    const mounted = mountPlugins([bad], services(registry), registry);
    expect(mounted).toEqual([]);
  });
});
