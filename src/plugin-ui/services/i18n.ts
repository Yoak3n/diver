// 插件文案：阶段 1 没有独立词典，fallback 即文案。
// 阶段 2 接入产品 locale 后，这里换成查表 + 语言切换订阅。

import type { I18nService } from "../types";

export const i18n: I18nService = {
  t: (key, fallback) => fallback ?? key,
};

export function createI18nService(): I18nService {
  return i18n;
}
