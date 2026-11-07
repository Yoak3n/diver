import { describe, expect, it } from "vitest";
import {
  GROUP_TIER_OPTIONS,
  parseGroupIds,
  parseTierMap,
  serializeTierMap,
  setGroupTier,
  tierOf,
} from "./group-tiers";

describe("parseGroupIds", () => {
  it("逗号拆分、去空去重、只留数字群号", () => {
    expect(parseGroupIds(" 123, 456 ,123,abc,,789 ")).toEqual([
      "123",
      "456",
      "789",
    ]);
  });

  it("空串得到空列表", () => {
    expect(parseGroupIds("")).toEqual([]);
  });
});

describe("parseTierMap", () => {
  it("未知档位、非数字群号、normal 都被忽略", () => {
    expect(
      parseTierMap("123=chatty, 456=loud, abc=quiet, 789=normal, 012=mute"),
    ).toEqual({ "123": "chatty", "012": "mute" });
  });

  it("同一群后者覆盖前者", () => {
    expect(parseTierMap("1=quiet,1=mute")).toEqual({ "1": "mute" });
  });
});

describe("serializeTierMap", () => {
  it("按监听列表顺序输出，未设置与 normal 不在文本里", () => {
    const map = parseTierMap("1=chatty,2=quiet,3=mute");
    expect(serializeTierMap(map, ["3", "2", "1"])).toBe(
      "3=mute, 2=quiet, 1=chatty",
    );
    expect(serializeTierMap(map, ["1"])).toBe("1=chatty");
    expect(serializeTierMap(map, ["9"])).toBe("");
  });
});

describe("setGroupTier", () => {
  const groups = "100,200,300";

  it("设置与清除单个群的档位", () => {
    const once = setGroupTier("", groups, "200", "chatty");
    expect(once).toBe("200=chatty");
    expect(setGroupTier(once, groups, "200", "normal")).toBe("");
    expect(setGroupTier(once, groups, "200", "quiet")).toBe("200=quiet");
  });

  it("监听列表变化后，列表外的旧条目在下次编辑时被清掉", () => {
    expect(setGroupTier("100=chatty,999=mute", "100,200", "200", "quiet")).toBe(
      "100=chatty, 200=quiet",
    );
  });

  it("未知档位不改动原文本", () => {
    expect(setGroupTier("100=chatty", groups, "200", "loud")).toBe(
      "100=chatty",
    );
  });
});

describe("tierOf", () => {
  it("未设置按 normal", () => {
    expect(tierOf({}, "1")).toBe("normal");
    expect(tierOf({ "1": "mute" }, "1")).toBe("mute");
  });
});

describe("GROUP_TIER_OPTIONS", () => {
  it("覆盖四个档位且 value 唯一", () => {
    const values = GROUP_TIER_OPTIONS.map((option) => option.value);
    expect(values).toEqual(["normal", "chatty", "quiet", "mute"]);
    expect(new Set(values).size).toBe(values.length);
  });
});
