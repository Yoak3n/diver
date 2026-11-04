// 插件挂载与清理：每个插件一个 effectScope + 一个清理袋。
// apply 抛错只跳过该插件，不影响应用启动。

import { effectScope } from "vue";
import type { ClientPlugin, ClientServices, Disposable } from "../types";
import type { SlotRegistry } from "./registry";

export class DisposableBag implements Disposable {
  private readonly items: Array<() => void> = [];
  private disposed = false;

  add(item: () => void): void {
    if (this.disposed) {
      runSafely(item);
      return;
    }
    this.items.push(item);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    while (this.items.length > 0) {
      const item = this.items.pop();
      if (item !== undefined) runSafely(item);
    }
  }
}

function runSafely(item: () => void): void {
  try {
    item();
  } catch (err) {
    console.error("[plugin-ui] 清理失败", err);
  }
}

export interface MountedPlugin {
  name: string;
  dispose(): void;
}

export function mountPlugins(
  plugins: readonly ClientPlugin[],
  services: ClientServices,
  registry: SlotRegistry,
): MountedPlugin[] {
  const mounted: MountedPlugin[] = [];
  for (const plugin of plugins) {
    const bag = new DisposableBag();
    const scope = effectScope(true);
    try {
      const result = scope.run(() =>
        plugin.apply({
          ...services,
          slots: registry.forPlugin(plugin.name),
        }),
      );
      bag.add(() => {
        scope.stop();
        registry.disposePlugin(plugin.name);
        if (typeof result === "function") result();
      });
      mounted.push({ name: plugin.name, dispose: () => bag.dispose() });
    } catch (err) {
      scope.stop();
      registry.disposePlugin(plugin.name);
      console.error(`[plugin-ui] ${plugin.name} apply 失败`, err);
    }
  }
  return mounted;
}
