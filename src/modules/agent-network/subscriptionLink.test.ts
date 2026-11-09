import { describe, expect, it } from "vitest";
import {
  authMethodOf,
  canUseBrowserLogin,
  catalogIdFor,
  codexSubscriptionLines,
  IDLE,
  isCodexOnly,
  isLoginAlternative,
  LinkFlow,
  linkReducer,
  LinkState,
  linkStatusOf,
  loginAlternativeOf,
  minutesLeft,
  pickerIdOf,
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
    expect(linkStatusOf({ status: "needs_relink" })).toBe("needs_relink");
    expect(linkStatusOf(undefined)).toBe("not_linked");
  });
});

describe("sign-in method", () => {
  it("reaches the ChatGPT login through the OpenAI entry", () => {
    expect(loginAlternativeOf("openai_api")).toBe("chatgpt_codex");
    expect(loginAlternativeOf("anthropic_api")).toBe("anthropic_claude_login");
    expect(loginAlternativeOf("mistral_api")).toBeUndefined();
    expect(isLoginAlternative("chatgpt_codex"), "kept out of the picker").toBe(
      true,
    );
    expect(isLoginAlternative("openai_api")).toBe(false);
  });

  it("shows a login record as its vendor with the login method", () => {
    expect(pickerIdOf("chatgpt_codex")).toBe("openai_api");
    expect(authMethodOf("chatgpt_codex")).toBe("login");
    expect(pickerIdOf("anthropic_claude_login")).toBe("anthropic_api");
    expect(authMethodOf("anthropic_claude_login")).toBe("login");
    expect(pickerIdOf("anthropic_api")).toBe("anthropic_api");
    expect(authMethodOf("openai_api")).toBe("api_key");
  });

  it("maps a vendor and method back to the record's catalog id", () => {
    expect(catalogIdFor("openai_api", "login")).toBe("chatgpt_codex");
    expect(catalogIdFor("openai_api", "api_key")).toBe("openai_api");
    expect(
      catalogIdFor("mistral_api", "login"),
      "a vendor without a login keeps its own entry",
    ).toBe("mistral_api");
    expect(catalogIdFor("anthropic_api", "login")).toBe(
      "anthropic_claude_login",
    );
    expect(catalogIdFor("anthropic_api", "api_key")).toBe("anthropic_api");
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
  it("allows code completion only for an authorization-code flow", () => {
    const device = run(
      IDLE,
      { type: "start" },
      { type: "flow", flow: flow("pending"), at: 1 },
    );
    expect(run(device, { type: "complete" })).toBe(device);
    const pending = run(
      IDLE,
      { type: "start" },
      {
        type: "flow",
        flow: flow("pending", { flow: "authorization_code" }),
        at: 1,
      },
    );
    const completing = run(pending, { type: "complete" });
    expect(completing.phase).toBe("completing");
    expect(
      run(completing, { type: "complete-error", code: 400 }),
    ).toMatchObject({ phase: "pending", completionError: expect.any(String) });
    expect(run(completing, { type: "complete-error", code: 404 }).phase).toBe(
      "failed",
    );
    expect(
      run(completing, { type: "flow", flow: flow("linked"), at: 2 }).phase,
    ).toBe("linked");
  });
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

  it("explains a start refused for lack of permission", () => {
    const state = run(
      IDLE,
      { type: "start" },
      { type: "start-error", code: 403, message: "forbidden" },
    );
    expect(state).toEqual({
      phase: "unavailable",
      message: "Linking a login needs permission to edit providers.",
    });
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

describe("browser login availability", () => {
  const device: LinkState = {
    phase: "pending",
    flow: flow("pending"),
    checkedAt: 1,
  };
  const supported = {
    flow: "device" as const,
    supported_flows: ["device", "authorization_code"] as (
      | "device"
      | "authorization_code"
    )[],
  };

  it("requires the catalog to advertise browser login", () => {
    expect(canUseBrowserLogin(undefined, device)).toBe(false);
    expect(canUseBrowserLogin({ flow: "device" }, device)).toBe(false);
    expect(
      canUseBrowserLogin(
        { flow: "device", supported_flows: ["device"] },
        device,
      ),
    ).toBe(false);
    expect(canUseBrowserLogin(supported, device)).toBe(true);
  });

  it("offers a fallback after a refused device start but not after a browser start", () => {
    const unavailable: LinkState = {
      phase: "unavailable",
      message: "Device login is unavailable",
    };
    expect(canUseBrowserLogin(supported, unavailable)).toBe(true);
    expect(
      canUseBrowserLogin(supported, unavailable, "authorization_code"),
    ).toBe(false);
  });

  it("does not switch an authorization attempt or an exchange already in progress", () => {
    const browser = {
      ...device,
      flow: flow("pending", { flow: "authorization_code" }),
    };
    expect(canUseBrowserLogin(supported, browser)).toBe(false);
    expect(
      canUseBrowserLogin(supported, { ...browser, phase: "completing" }),
    ).toBe(false);
    expect(
      canUseBrowserLogin(supported, { phase: "linked", flow: flow("linked") }),
    ).toBe(false);
    expect(
      canUseBrowserLogin(
        { flow: "authorization_code", supported_flows: ["authorization_code"] },
        { phase: "unavailable", message: "Unavailable" },
      ),
    ).toBe(false);
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
