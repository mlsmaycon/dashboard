import { describe, expect, it } from "vitest";
import {
  codexSubscriptionLines,
  IDLE,
  isCodexOnly,
  LinkFlow,
  linkReducer,
  LinkState,
  linkStatusOf,
  minutesLeft,
  pollDelayMs,
  userOAuthUpstreamUrl,
  usesUserOAuth,
} from "@/modules/agent-network/subscriptionLink";

const flow = (status: LinkFlow["status"], extra: Partial<LinkFlow> = {}) => ({
  id: "flow-1",
  status,
  user_code: "ABCD-1234",
  verification_uri: "https://auth.openai.com/codex/device",
  expires_at: "2026-11-07T12:15:00Z",
  interval_seconds: 5,
  ...extra,
});

const run = (
  state: LinkState,
  ...actions: Parameters<typeof linkReducer>[1][]
) => actions.reduce(linkReducer, state);

describe("usesUserOAuth", () => {
  it("is true only for user_oauth entries", () => {
    expect(usesUserOAuth({ credential_kind: "user_oauth" })).toBe(true);
    expect(usesUserOAuth({ credential_kind: "static_key" })).toBe(false);
    expect(
      usesUserOAuth({}),
      "a server that predates credential kinds means an operator key",
    ).toBe(false);
    expect(usesUserOAuth(undefined)).toBe(false);
  });
});

describe("userOAuthUpstreamUrl", () => {
  it("pins the upstream to the catalog host over https", () => {
    expect(userOAuthUpstreamUrl({ default_host: "chatgpt.com" })).toBe(
      "https://chatgpt.com",
    );
  });
});

describe("linkStatusOf", () => {
  it("reads the reported status, and not_linked when there is none", () => {
    expect(
      linkStatusOf({ subscription_link: { status: "needs_relink" } }),
    ).toBe("needs_relink");
    expect(linkStatusOf({})).toBe("not_linked");
  });
});

describe("codexSubscriptionLines", () => {
  const base = "https://acme.ai.example.com";

  it("routes ChatGPT through the Codex backend path, not /v1", () => {
    expect(codexSubscriptionLines("chatgpt_codex", base)).toEqual([
      `model_provider = "netbird"`,
      ``,
      `[model_providers.netbird]`,
      `name = "NetBird"`,
      `base_url = "${base}/backend-api/codex"`,
      `wire_api = "responses"`,
    ]);
  });

  it("pins a picked model and never sets openai_base_url", () => {
    const lines = codexSubscriptionLines("chatgpt_codex", base, "gpt-5.5");
    expect(lines[0]).toBe(`model = "gpt-5.5"`);
    expect(lines.join("\n")).not.toContain("openai_base_url");
  });

  it("marks only subscription entries as Codex-only", () => {
    expect(isCodexOnly("chatgpt_codex")).toBe(true);
    expect(isCodexOnly("openai_api")).toBe(false);
    expect(isCodexOnly(undefined)).toBe(false);
  });
});

describe("linkReducer", () => {
  it("goes from start through pending to linked", () => {
    const started = run(IDLE, { type: "start" });
    expect(started.phase).toBe("starting");

    const pending = run(started, {
      type: "flow",
      flow: flow("pending"),
      at: 1,
    });
    expect(pending).toEqual({
      phase: "pending",
      flow: flow("pending"),
      checkedAt: 1,
    });

    const linked = run(pending, { type: "flow", flow: flow("linked"), at: 2 });
    expect(linked.phase).toBe("linked");
  });

  it("ends in expired when the code runs out", () => {
    const state = run(
      IDLE,
      { type: "start" },
      { type: "flow", flow: flow("pending"), at: 1 },
      { type: "flow", flow: flow("expired"), at: 2 },
    );
    expect(state.phase).toBe("expired");
  });

  it("ends in failed when the vendor refuses, or reports a status it doesn't know", () => {
    const pending = run(
      IDLE,
      { type: "start" },
      { type: "flow", flow: flow("pending"), at: 1 },
    );
    expect(
      run(pending, { type: "flow", flow: flow("failed"), at: 2 }).phase,
    ).toBe("failed");
    expect(
      run(pending, {
        type: "flow",
        flow: flow("revoked" as LinkFlow["status"]),
        at: 2,
      }).phase,
    ).toBe("failed");
  });

  it("ignores a late poll answer once the attempt has finished", () => {
    const linked = run(
      IDLE,
      { type: "start" },
      { type: "flow", flow: flow("linked"), at: 1 },
    );
    expect(run(linked, { type: "flow", flow: flow("pending"), at: 2 })).toBe(
      linked,
    );
    expect(run(IDLE, { type: "flow", flow: flow("pending"), at: 2 })).toBe(
      IDLE,
    );
  });

  it("explains a refused start", () => {
    const state = run(
      IDLE,
      { type: "start" },
      { type: "start-error", code: 412, message: "device login is disabled" },
    );
    expect(state).toEqual({
      phase: "unavailable",
      message: "Linking isn't available right now: device login is disabled.",
    });
  });

  it("retries a transient poll failure and gives up when the flow is gone", () => {
    const pending = run(
      IDLE,
      { type: "start" },
      { type: "flow", flow: flow("pending"), at: 1 },
    );

    const retried = run(pending, { type: "poll-error", code: 502 });
    expect(retried, "still pending").toEqual(pending);
    expect(retried, "a new object, so the loop schedules the retry").not.toBe(
      pending,
    );

    expect(run(pending, { type: "poll-error", code: 404 }).phase).toBe(
      "failed",
    );
  });

  it("starts over from any phase and cancels back to idle", () => {
    const expired = run(
      IDLE,
      { type: "start" },
      { type: "flow", flow: flow("expired"), at: 1 },
    );
    expect(run(expired, { type: "start" }).phase).toBe("starting");
    expect(run(expired, { type: "cancel" })).toBe(IDLE);
  });
});

describe("pollDelayMs", () => {
  it("honours the server interval, falling back to five seconds", () => {
    expect(pollDelayMs({ interval_seconds: 7 })).toBe(7000);
    expect(pollDelayMs({ interval_seconds: 0 })).toBe(5000);
  });
});

describe("minutesLeft", () => {
  const expiresAt = "2026-11-07T12:15:00Z";
  const at = (iso: string) => Date.parse(iso);

  it("rounds up to whole minutes", () => {
    expect(minutesLeft(expiresAt, at("2026-11-07T12:00:00Z"))).toBe(15);
    expect(minutesLeft(expiresAt, at("2026-11-07T12:14:30Z"))).toBe(1);
  });

  it("is zero once expired or when the time can't be read", () => {
    expect(minutesLeft(expiresAt, at("2026-11-07T12:16:00Z"))).toBe(0);
    expect(minutesLeft("soon", 0)).toBe(0);
  });
});
