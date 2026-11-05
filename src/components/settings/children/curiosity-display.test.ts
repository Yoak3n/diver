import { describe, expect, it } from "vitest";

import { fmtAgo, reasonLabel, sourceLabel } from "./curiosity-display";

describe("curiosity-display", () => {
  it("来源标签按域收敛", () => {
    expect(sourceLabel("chat:group:123456")).toBe("群 123456");
    expect(sourceLabel("note:owner")).toBe("笔记");
    expect(sourceLabel("subscription:github:Yoak3n/cos")).toBe("订阅");
    expect(sourceLabel("entity")).toBe("实体");
    expect(sourceLabel("platform:bilibili")).toBe("B站");
    expect(sourceLabel("weird")).toBe("weird");
  });

  it("原因标签覆盖订阅与待查", () => {
    expect(reasonLabel("note_pending")).toBe("待查");
    expect(reasonLabel("release")).toBe("release");
    expect(reasonLabel("watch")).toBe("更新");
    expect(reasonLabel("chat_mention")).toBe("群聊");
    expect(reasonLabel("platform_trend")).toBe("B站");
  });

  it("时间用分钟/小时/天分档", () => {
    const now = 10_000_000_000;
    expect(fmtAgo(0, now)).toBe("从未");
    expect(fmtAgo(now - 30_000, now)).toBe("刚刚");
    expect(fmtAgo(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(fmtAgo(now - 5 * 3_600_000, now)).toBe("5 小时前");
    expect(fmtAgo(now - 3 * 86_400_000, now)).toBe("3 天前");
  });
});
