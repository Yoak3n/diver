// 内置插件 UI 发现：构建期把 cos-plugins/*/ui/index.ts 收进 dist。
// 阶段 3 换成远程 bundle 时，只替换这里的加载方式，ClientPlugin 契约不变。

import type { ClientPlugin } from "./types";

type ModuleShape = Partial<ClientPlugin> & { default?: ClientPlugin };

const modules = import.meta.glob("/cos-plugins/*/ui/index.ts", {
  eager: true,
}) as Record<string, ModuleShape>;

export const builtinPlugins: ClientPlugin[] = Object.entries(modules).flatMap(
  ([path, mod]) => {
    const candidate = mod.default ?? mod;
    if (
      typeof candidate.name !== "string" ||
      typeof candidate.apply !== "function"
    ) {
      console.warn(
        `[plugin-ui] ${path} 未导出 ClientPlugin（name/apply），已跳过`,
      );
      return [];
    }
    return [candidate as ClientPlugin];
  },
);
