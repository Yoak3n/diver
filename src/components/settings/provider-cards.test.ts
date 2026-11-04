// provider-cards 纯逻辑单测（设置面板卡片可见性）。

import { describe, expect, it } from "vitest";
import type { ProviderConfigDecl } from "../../types";
import {
  addableProviderDecls,
  canRemoveProvider,
  visibleProviderDecls,
} from "./provider-cards";

function decl(provider: string, custom = false): ProviderConfigDecl {
  return { provider, name: provider, fields: [], ...(custom ? { custom: true } : {}) };
}

const DECLS = [
  decl("deepseek-official"),
  decl("commandcode"),
  decl("volcark"),
  decl("mimo"),
  decl("custom-abcd", true),
];

describe("visibleProviderDecls", () => {
  it("默认只显示 DeepSeek 官方", () => {
    const visible = visibleProviderDecls(DECLS.filter((d) => !d.custom), [], "deepseek-official");
    expect(visible.map((d) => d.provider)).toEqual(["deepseek-official"]);
  });

  it("卡片列表里的 provider 出现在卡片区（保持注册顺序）", () => {
    const visible = visibleProviderDecls(DECLS, ["mimo", "volcark"], "deepseek-official");
    expect(visible.map((d) => d.provider)).toEqual([
      "deepseek-official",
      "volcark",
      "mimo",
      "custom-abcd",
    ]);
  });

  it("当前激活的 provider 始终可见", () => {
    const visible = visibleProviderDecls(DECLS, [], "opencode-go-missing");
    expect(visible.map((d) => d.provider)).toEqual(["deepseek-official", "custom-abcd"]);
    const withActive = visibleProviderDecls(DECLS, [], "commandcode");
    expect(withActive.map((d) => d.provider)).toContain("commandcode");
  });

  it("自定义身份无需添加即显示", () => {
    const visible = visibleProviderDecls(DECLS, [], "deepseek-official");
    expect(visible.map((d) => d.provider)).toContain("custom-abcd");
  });
});

describe("addableProviderDecls", () => {
  it("只列出尚未显示的适配器（自定义不重复出现）", () => {
    const addable = addableProviderDecls(DECLS, ["volcark"], "deepseek-official");
    expect(addable.map((d) => d.provider)).toEqual(["commandcode", "mimo"]);
  });
});

describe("canRemoveProvider", () => {
  it("默认项与自定义身份不可移除", () => {
    expect(canRemoveProvider(decl("deepseek-official"), "opencode")).toBe(false);
    expect(canRemoveProvider(decl("custom-abcd", true), "deepseek-official")).toBe(false);
  });

  it("激活项需先切走才能移除", () => {
    expect(canRemoveProvider(decl("mimo"), "mimo")).toBe(false);
    expect(canRemoveProvider(decl("mimo"), "deepseek-official")).toBe(true);
  });
});
