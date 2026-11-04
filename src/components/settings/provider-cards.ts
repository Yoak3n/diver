// 设置面板的提供商卡片可见性（纯逻辑，可单测）。
//
// 交互：初始只显示默认提供商（DeepSeek 官方）；其余适配器经「添加模型提供商」
// 下拉选择后进入卡片列表（服务端持久化，首次初始化会把已配齐凭据的 provider
// 一并纳入，升级后不会把它们藏起来）；自定义身份天然显示。
// 当前激活的 provider 必须始终可见，否则它的模型选择与配置没有入口。

import type { ProviderConfigDecl } from "../../types";

/** 常驻显示的默认提供商。 */
export const DEFAULT_VISIBLE_PROVIDERS: readonly string[] = ["deepseek-official"];

/** 卡片区应显示的提供商（保持 decls 原有顺序）。 */
export function visibleProviderDecls(
  decls: readonly ProviderConfigDecl[],
  cards: readonly string[],
  active: string,
): ProviderConfigDecl[] {
  return decls.filter(
    (decl) =>
      decl.custom === true ||
      decl.provider === active ||
      DEFAULT_VISIBLE_PROVIDERS.includes(decl.provider) ||
      cards.includes(decl.provider),
  );
}

/** 「添加提供商」下拉里可选的项：尚未显示的适配器（自定义走单独入口）。 */
export function addableProviderDecls(
  decls: readonly ProviderConfigDecl[],
  cards: readonly string[],
  active: string,
): ProviderConfigDecl[] {
  const visible = new Set(
    visibleProviderDecls(decls, cards, active).map((decl) => decl.provider),
  );
  return decls.filter((decl) => !visible.has(decl.provider));
}

/** 卡片是否提供「移除」：默认项常驻、自定义身份走删除，激活项需先切走。 */
export function canRemoveProvider(decl: ProviderConfigDecl, active: string): boolean {
  return (
    decl.provider !== active &&
    decl.custom !== true &&
    !DEFAULT_VISIBLE_PROVIDERS.includes(decl.provider)
  );
}
