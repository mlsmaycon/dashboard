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
