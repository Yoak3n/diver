// onebot 插件 UI 半边：把「QQ 接入」设置页注册到 settings.tab。
// 页面状态与 IO 在 use-onebot-panel；产品只保留 slot 扩展点与通用表单。

import type { ClientServices } from "@diver/plugin-ui";
import OnebotPanel from "./OnebotPanel.vue";
import { createOnebotPanel } from "./use-onebot-panel";

export const name = "onebot-ui";

export const inject = ["slots", "api", "instances", "i18n"] as const;

export function apply(ctx: ClientServices): void {
  ctx.slots.inject("settings.tab", () =>
    ctx.slots.register(
      {
        name: "settings.tab",
        id: "onebot",
        order: 20,
        label: () => ctx.i18n.t("onebot.tab", "QQ 接入"),
        provide: () => ({ panel: createOnebotPanel(ctx) }),
      },
      OnebotPanel,
    ),
  );
}
