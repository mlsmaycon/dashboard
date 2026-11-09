import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkFlow } from "@/modules/agent-network/subscriptionLink";

const post = vi.fn();
const get = vi.fn();
const del = vi.fn();
const urls: string[] = [];

vi.mock("@utils/api", () => ({
  useApiCall: (url: string) => {
    urls.push(url);
    return { post, get, del };
  },
}));

const { useProviderLink, useProviderUnlink } = await import(
  "@/modules/agent-network/useProviderLink"
);

const flow = (status: LinkFlow["status"], interval = 5): LinkFlow => ({
  id: "flow-1",
  status,
  user_code: "ABCD-1234",
  verification_uri: "https://auth.openai.com/codex/device",
  expires_at: "2026-11-07T12:15:00Z",
  interval_seconds: interval,
});

// flush lets the mocked requests' promises settle inside act.
const flush = () => act(async () => {});
// tick advances the fake clock and lets whatever it fired settle.
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  post.mockReset();
  get.mockReset();
  del.mockReset();
  urls.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const startLink = async (onLinked = vi.fn()) => {
  const hook = renderHook(() => useProviderLink({ onLinked }));
  act(() => hook.result.current.start("anp-chatgpt"));
  await flush();
  return { ...hook, onLinked };
};

describe("useProviderLink", () => {
  it("starts a flow, polls it while pending and stops once linked", async () => {
    post.mockResolvedValue(flow("pending"));
    get
      .mockResolvedValueOnce(flow("pending"))
      .mockResolvedValueOnce(flow("linked"));

    const { result, onLinked } = await startLink();

    expect(urls[0]).toBe("/agent-network/providers");
    expect(post).toHaveBeenCalledWith({}, "/anp-chatgpt/link");
    expect(result.current.state.phase).toBe("pending");

    await tick(5000);
    expect(get).toHaveBeenCalledWith("/anp-chatgpt/link/flow-1");
    expect(result.current.state.phase).toBe("pending");

    await tick(5000);
    expect(result.current.state.phase).toBe("linked");
    expect(onLinked, "agent-config is refreshed once").toHaveBeenCalledTimes(1);

    await tick(60_000);
    expect(get, "no poll after a terminal state").toHaveBeenCalledTimes(2);
  });

  it("waits interval_seconds between polls", async () => {
    post.mockResolvedValue(flow("pending", 8));
    get.mockResolvedValue(flow("pending", 8));

    await startLink();

    await tick(7999);
    expect(get, "not before the interval").not.toHaveBeenCalled();
    await tick(1);
    expect(get).toHaveBeenCalledTimes(1);
    await tick(8000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("stops at expired", async () => {
    post.mockResolvedValue(flow("pending"));
    get.mockResolvedValue(flow("expired"));

    const { result, onLinked } = await startLink();
    await tick(5000);

    expect(result.current.state.phase).toBe("expired");
    await tick(30_000);
    expect(get).toHaveBeenCalledTimes(1);
    expect(onLinked).not.toHaveBeenCalled();
  });

  it("stops at failed", async () => {
    post.mockResolvedValue(flow("pending"));
    get.mockResolvedValue(flow("failed"));

    const { result } = await startLink();
    await tick(5000);

    expect(result.current.state.phase).toBe("failed");
    await tick(30_000);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("keeps polling through a transient error", async () => {
    post.mockResolvedValue(flow("pending"));
    get
      .mockRejectedValueOnce({ code: 502, message: "bad gateway" })
      .mockResolvedValueOnce(flow("linked"));

    const { result } = await startLink();
    await tick(5000);
    expect(result.current.state.phase).toBe("pending");
    await tick(5000);
    expect(result.current.state.phase).toBe("linked");
  });

  it("reports a refused start without polling", async () => {
    post.mockRejectedValue({ code: 412, message: "device login is disabled" });

    const { result } = await startLink();

    expect(result.current.state).toEqual({
      phase: "unavailable",
      message: "Linking isn't available right now: device login is disabled.",
    });
    await tick(30_000);
    expect(get).not.toHaveBeenCalled();
  });

  it("stops polling on unmount", async () => {
    post.mockResolvedValue(flow("pending"));
    get.mockResolvedValue(flow("pending"));

    const { unmount } = await startLink();
    unmount();
    await tick(30_000);

    expect(get).not.toHaveBeenCalled();
  });

  it("stops polling on cancel and drops an answer already in flight", async () => {
    post.mockResolvedValue(flow("pending"));
    let answer: (f: LinkFlow) => void = () => {};
    get.mockImplementation(
      () => new Promise<LinkFlow>((resolve) => (answer = resolve)),
    );

    const { result } = await startLink();
    await tick(5000);
    expect(get).toHaveBeenCalledTimes(1);

    act(() => result.current.cancel());
    answer(flow("linked"));
    await flush();

    expect(result.current.state.phase).toBe("idle");
    await tick(30_000);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh flow on retry", async () => {
    post
      .mockResolvedValueOnce(flow("pending"))
      .mockResolvedValueOnce({ ...flow("pending"), id: "flow-2" });
    get
      .mockResolvedValueOnce(flow("expired"))
      .mockResolvedValue(flow("linked"));

    const { result } = await startLink();
    await tick(5000);
    expect(result.current.state.phase).toBe("expired");

    act(() => result.current.start("anp-chatgpt"));
    await flush();
    expect(result.current.state.phase).toBe("pending");
    await tick(5000);
    expect(get).toHaveBeenLastCalledWith("/anp-chatgpt/link/flow-2");
    expect(result.current.state.phase).toBe("linked");
  });
});

describe("useProviderUnlink", () => {
  it("deletes the provider's login and reports the outcome", async () => {
    del.mockResolvedValueOnce({}).mockRejectedValueOnce({ code: 500 });
    const { result } = renderHook(() => useProviderUnlink());

    await expect(result.current("anp-chatgpt")).resolves.toBe(true);
    expect(del).toHaveBeenCalledWith("", "/anp-chatgpt/link");
    await expect(result.current("anp-chatgpt")).resolves.toBe(false);
  });
});

describe("authorization-code linking", () => {
  const claudeFlow = (status: LinkFlow["status"]): LinkFlow => ({
    ...flow(status),
    flow: "authorization_code",
    authorization_uri: "https://claude.ai/oauth/authorize?state=test-state",
    user_code: "",
  });

  it("submits a pasted code once, pauses polling, and refreshes on success", async () => {
    let complete: (value: LinkFlow) => void = () => {};
    post.mockResolvedValueOnce(claudeFlow("pending")).mockImplementationOnce(
      () =>
        new Promise<LinkFlow>((resolve) => {
          complete = resolve;
        }),
    );
    const { result, onLinked } = await startLink();
    act(() => {
      result.current.complete("  code#test-state  ");
      result.current.complete("code#test-state");
    });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(
      { code: "code#test-state" },
      "/anp-chatgpt/link/flow-1",
    );
    expect(result.current.state.phase).toBe("completing");
    await tick(30_000);
    expect(get).not.toHaveBeenCalled();
    complete(claudeFlow("linked"));
    await flush();
    expect(result.current.state.phase).toBe("linked");
    expect(onLinked).toHaveBeenCalledTimes(1);
  });

  it("ignores a late pending poll while a code is being completed", async () => {
    let poll: (value: LinkFlow) => void = () => {};
    post
      .mockResolvedValueOnce(claudeFlow("pending"))
      .mockImplementationOnce(() => new Promise(() => {}));
    get.mockImplementationOnce(
      () =>
        new Promise<LinkFlow>((resolve) => {
          poll = resolve;
        }),
    );
    const { result } = await startLink();
    await tick(5000);
    act(() => result.current.complete("code#test-state"));
    poll(claudeFlow("pending"));
    await flush();
    expect(result.current.state.phase).toBe("completing");
  });

  it("allows a new pasted code after validation fails without exposing server error text", async () => {
    post
      .mockResolvedValueOnce(claudeFlow("pending"))
      .mockRejectedValueOnce({ code: 400, message: "secret-code" })
      .mockResolvedValueOnce(claudeFlow("linked"));
    const { result } = await startLink();
    act(() => result.current.complete("bad-code"));
    await flush();
    expect(result.current.state).toMatchObject({
      phase: "pending",
      completionError: expect.any(String),
    });
    expect(JSON.stringify(result.current.state)).not.toContain("secret-code");
    get.mockResolvedValue(claudeFlow("pending"));
    await tick(5000);
    expect(result.current.state).toMatchObject({
      completionError: expect.any(String),
    });
    act(() =>
      result.current.complete(
        "https://console.anthropic.com/oauth/code/callback?code=valid&state=test-state",
      ),
    );
    await flush();
    expect(result.current.state.phase).toBe("linked");
  });

  it.each(["cancel", "unmount"])(
    "ignores a late completion after %s",
    async (action) => {
      let complete: (value: LinkFlow) => void = () => {};
      post.mockResolvedValueOnce(claudeFlow("pending")).mockImplementationOnce(
        () =>
          new Promise<LinkFlow>((resolve) => {
            complete = resolve;
          }),
      );
      const { result, unmount, onLinked } = await startLink();
      act(() => result.current.complete("code#test-state"));
      if (action === "cancel") act(() => result.current.cancel());
      else unmount();
      complete(claudeFlow("linked"));
      await flush();
      expect(onLinked).not.toHaveBeenCalled();
      if (action === "cancel") expect(result.current.state.phase).toBe("idle");
    },
  );
});

describe("switching login methods", () => {
  const browserFlow: LinkFlow = {
    ...flow("pending"),
    id: "browser-flow",
    flow: "authorization_code",
    authorization_uri: "https://auth.openai.com/oauth/authorize",
  };

  it("keeps the default request unchanged and preserves browser selection across failed starts and retries", async () => {
    post
      .mockRejectedValueOnce({ code: 412 })
      .mockRejectedValueOnce({ code: 502 })
      .mockResolvedValueOnce(browserFlow);
    const { result } = await startLink();
    expect(post).toHaveBeenNthCalledWith(1, {}, "/anp-chatgpt/link");
    act(() => result.current.start("anp-chatgpt", "authorization_code"));
    await flush();
    expect(result.current.state.phase).toBe("unavailable");
    act(() => result.current.retry());
    await flush();
    expect(post).toHaveBeenNthCalledWith(
      2,
      { flow: "authorization_code" },
      "/anp-chatgpt/link",
    );
    expect(post).toHaveBeenNthCalledWith(
      3,
      { flow: "authorization_code" },
      "/anp-chatgpt/link",
    );
    expect(result.current.state).toMatchObject({
      phase: "pending",
      flow: { id: "browser-flow" },
    });
  });

  it("keeps browser mode when an expired flow is retried, then resets on cancel and fresh open", async () => {
    post
      .mockResolvedValueOnce(flow("pending"))
      .mockResolvedValueOnce({ ...browserFlow, status: "expired" })
      .mockResolvedValueOnce(browserFlow)
      .mockResolvedValueOnce(flow("pending"));
    const { result } = await startLink();
    act(() => result.current.start("anp-chatgpt", "authorization_code"));
    await flush();
    expect(result.current.state.phase).toBe("expired");
    act(() => result.current.retry());
    await flush();
    expect(post).toHaveBeenLastCalledWith(
      { flow: "authorization_code" },
      "/anp-chatgpt/link",
    );
    act(() => result.current.cancel());
    expect(result.current.requestedFlow).toBeUndefined();
    act(() => result.current.retry());
    expect(post).toHaveBeenCalledTimes(3);
    act(() => result.current.start("anp-chatgpt"));
    await flush();
    expect(post).toHaveBeenLastCalledWith({}, "/anp-chatgpt/link");
  });

  it("drops a late device poll after switching to browser sign-in", async () => {
    let poll: (value: LinkFlow) => void = () => {};
    post
      .mockResolvedValueOnce(flow("pending"))
      .mockResolvedValueOnce(browserFlow);
    get.mockImplementationOnce(
      () =>
        new Promise<LinkFlow>((resolve) => {
          poll = resolve;
        }),
    );
    const { result, onLinked } = await startLink();
    await tick(5000);
    act(() => result.current.start("anp-chatgpt", "authorization_code"));
    await flush();
    poll(flow("linked"));
    await flush();
    expect(result.current.state).toMatchObject({
      phase: "pending",
      flow: { id: "browser-flow" },
    });
    expect(onLinked).not.toHaveBeenCalled();
  });

  it("drops a late device start after a newer browser start", async () => {
    let deviceStart: (value: LinkFlow) => void = () => {};
    post
      .mockImplementationOnce(
        () =>
          new Promise<LinkFlow>((resolve) => {
            deviceStart = resolve;
          }),
      )
      .mockResolvedValueOnce(browserFlow);
    const { result } = await startLink();
    act(() => result.current.start("anp-chatgpt", "authorization_code"));
    await flush();
    deviceStart(flow("pending"));
    await flush();
    expect(result.current.state).toMatchObject({
      phase: "pending",
      flow: { id: "browser-flow" },
    });
  });
});
