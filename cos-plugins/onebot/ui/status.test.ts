import { describe, expect, it } from "vitest";
import { describeStatus, type StatusInput } from "./status";

const base: StatusInput = {
  owner: "inst",
  ownerRunning: true,
  status: null,
  error: "",
};

describe("describeStatus", () => {
  it("online 展示昵称与目标", () => {
    const view = describeStatus({
      ...base,
      status: {
        available: true,
        state: "online",
        url: "ws://127.0.0.1:3001",
        nickname: "bot",
        selfId: 10001,
      },
    });
    expect(view.tone).toBe("ok");
    expect(view.title).toBe("已连接");
    expect(view.detail).toContain("bot（10001）");
  });

  it("未绑定", () => {
    const view = describeStatus({ ...base, owner: null, ownerRunning: false });
    expect(view.tone).toBe("idle");
    expect(view.title).toBe("未绑定归属实例");
  });

  it("读取失败", () => {
    const view = describeStatus({ ...base, error: "network down" });
    expect(view.tone).toBe("bad");
    expect(view.title).toBe("状态读取失败");
    expect(view.detail).toBe("network down");
  });

  it("offline 带重连与次数", () => {
    const view = describeStatus({
      ...base,
      status: {
        available: true,
        state: "offline",
        lastError: "refused",
        attempts: 3,
        retryInMs: 4500,
        url: "ws://x",
      },
    });
    expect(view.tone).toBe("bad");
    expect(view.detail).toContain("refused");
    expect(view.detail).toContain("第 3 次");
    expect(view.detail).toContain("5 秒后重连");
  });

  it("插件未加载", () => {
    const view = describeStatus({
      ...base,
      status: { available: false, state: "unavailable" },
    });
    expect(view.tone).toBe("idle");
    expect(view.title).toBe("OneBot 插件未加载");
  });
});
