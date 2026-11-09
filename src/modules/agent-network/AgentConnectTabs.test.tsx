import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectProvider } from "@/modules/agent-network/AgentConnectTabs";

const writeText = vi.fn();

vi.mock("@components/Notification", () => ({ notify: vi.fn() }));
vi.mock("@utils/api", () => ({ default: () => ({ data: [] }) }));

const { AgentConnectTabs, fromAccountProviders } = await import(
  "@/modules/agent-network/AgentConnectTabs"
);

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ENDPOINT = "calm-heron.proxy.company.com";
const anthropic: ConnectProvider[] = [
  {
    name: "Claude",
    catalogId: "anthropic_api",
    api: "anthropic",
    models: ["claude-sonnet-5"],
  },
];

// shownLines reads the snippet as displayed, one string per line.
const shownLines = () =>
  Array.from(document.querySelectorAll("code > *")).map((l) => l.textContent);

// copied clicks the snippet's copy button and returns what it copied.
const copied = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId("copy-to-clipboard"));
  });
  return writeText.mock.calls[0]?.[0];
};

const model = (id: string) => ({ id, inputPer1k: 0, outputPer1k: 0 });

describe("fromAccountProviders", () => {
  it("keeps a Claude subscription on the Anthropic API and preserves its login status", () => {
    expect(
      fromAccountProviders([
        {
          name: "Claude team plan",
          providerId: "anthropic_claude_login",
          models: [model("claude-sonnet-5")],
          subscriptionLink: { status: "needs_relink" },
        },
      ]),
    ).toEqual([
      {
        name: "Claude team plan",
        catalogId: "anthropic_claude_login",
        api: "anthropic",
        models: ["claude-sonnet-5"],
        linkStatus: "needs_relink",
      },
    ]);
  });

  it("asks Anthropic through its Messages API, everything else through Chat Completions", () => {
    expect(
      fromAccountProviders([
        {
          name: "Claude",
          providerId: "anthropic_api",
          models: [model("claude-sonnet-5")],
        },
        { name: "Kimi", providerId: "kimi_api", models: [model("kimi-k3")] },
      ]),
    ).toEqual([
      {
        name: "Claude",
        catalogId: "anthropic_api",
        api: "anthropic",
        models: ["claude-sonnet-5"],
      },
      {
        name: "Kimi",
        catalogId: "kimi_api",
        api: "openai",
        models: ["kimi-k3"],
      },
    ]);
  });
});

describe("AgentConnectTabs", () => {
  it("sends an Anthropic example to the Messages API", async () => {
    render(
      <AgentConnectTabs
        endpoint={ENDPOINT}
        defaultTab={"curl"}
        providers={anthropic}
      />,
    );

    expect(shownLines()).toEqual([
      `curl https://${ENDPOINT}/v1/messages \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -H "anthropic-version: 2023-06-01" \\`,
      `  -d '{`,
      `    "model": "claude-sonnet-5",`,
      `    "max_tokens": 32,`,
      `    "messages": [`,
      `      { "role": "user", "content": "Say hello in one word." }`,
      `    ]`,
      `  }'`,
    ]);
    expect(await copied(), "the same request on one line").toBe(
      `curl https://${ENDPOINT}/v1/messages -H "Content-Type: application/json" -H "anthropic-version: 2023-06-01" -d '{"model":"claude-sonnet-5","max_tokens":32,"messages":[{"role":"user","content":"Say hello in one word."}]}'`,
    );
  });

  it("offers the Anthropic SDK for an Anthropic example", () => {
    render(
      <AgentConnectTabs
        endpoint={ENDPOINT}
        defaultTab={"sdk"}
        providers={anthropic}
      />,
    );

    expect(screen.getByRole("tab", { name: "Anthropic SDK" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "OpenAI SDK" })).toBeNull();
    expect(shownLines()).toEqual(
      expect.arrayContaining([
        `from anthropic import Anthropic`,
        `    base_url="https://${ENDPOINT}",`,
        `client.messages.create(`,
        `    model="claude-sonnet-5",`,
        `    max_tokens=32,`,
      ]),
    );
  });

  it("keeps the OpenAI default where no provider is pickable", async () => {
    render(<AgentConnectTabs endpoint={ENDPOINT} defaultTab={"curl"} />);

    expect(screen.getByRole("tab", { name: "OpenAI SDK" })).toBeTruthy();
    expect(await copied()).toBe(
      `curl https://${ENDPOINT}/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"Say hello in one word."}]}'`,
    );
  });

  it("points OpenCode at the endpoint with the picked model", () => {
    render(
      <AgentConnectTabs
        endpoint={ENDPOINT}
        defaultTab={"opencode"}
        providers={anthropic}
      />,
    );

    expect(shownLines()).toEqual(
      expect.arrayContaining([
        `      "npm": "@ai-sdk/anthropic",`,
        `        "baseURL": "https://${ENDPOINT}/v1",`,
        `  "model": "netbird/claude-sonnet-5"`,
      ]),
    );
  });

  it("writes pi's models and settings for the OpenAI shape", () => {
    render(<AgentConnectTabs endpoint={ENDPOINT} defaultTab={"pi"} />);

    expect(shownLines()).toEqual(
      expect.arrayContaining([
        `      "baseUrl": "https://${ENDPOINT}/v1",`,
        `      "api": "openai-completions",`,
        `          "id": "gpt-5.5"`,
        `  "defaultProvider": "netbird",`,
        `  "defaultModel": "gpt-5.5"`,
      ]),
    );
  });

  it("takes a typed model for a provider that lists none", async () => {
    render(
      <AgentConnectTabs
        endpoint={ENDPOINT}
        defaultTab={"codex"}
        providers={[
          {
            name: "LiteLLM",
            catalogId: "litellm_proxy",
            api: "openai",
            models: [],
          },
        ]}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Model" }), {
      target: { value: "my-model" },
    });

    expect(shownLines()[0]).toBe(`model = "my-model"`);
  });

  it("starts on the first pickable provider's first model", async () => {
    render(
      <AgentConnectTabs
        endpoint={ENDPOINT}
        defaultTab={"pi"}
        providers={[
          {
            name: "Bedrock",
            catalogId: "bedrock_api",
            api: "anthropic",
            models: ["anthropic.claude"],
          },
          {
            name: "OpenAI",
            catalogId: "openai_api",
            api: "openai",
            models: ["gpt-4o", "gpt-4o-mini"],
          },
        ]}
      />,
    );

    expect(shownLines()).toContain(`  "defaultModel": "gpt-4o"`);
  });

  it("configures Claude Code for a picked Vertex provider, and only Claude Code", () => {
    const vertex: ConnectProvider[] = [
      {
        name: "Vertex",
        catalogId: "vertex_ai_api",
        api: "anthropic",
        models: ["claude-opus-5"],
      },
    ];
    render(
      <AgentConnectTabs
        endpoint={ENDPOINT}
        defaultTab={"claude-code"}
        providers={vertex}
      />,
    );

    expect(shownLines()).toEqual(
      expect.arrayContaining([
        `    "CLAUDE_CODE_USE_VERTEX": "1",`,
        `    "ANTHROPIC_MODEL": "claude-opus-5",`,
      ]),
    );

    cleanup();
    render(
      <AgentConnectTabs
        endpoint={ENDPOINT}
        defaultTab={"pi"}
        providers={vertex}
      />,
    );
    expect(shownLines()).toEqual([]);
    expect(screen.getByText(/routes requests by URL path/)).toBeTruthy();
  });

  it("says Claude Code can't use an OpenAI-only provider", () => {
    render(
      <AgentConnectTabs
        endpoint={ENDPOINT}
        providers={[
          {
            name: "OpenAI",
            catalogId: "openai_api",
            api: "openai",
            models: ["gpt-4o"],
          },
        ]}
      />,
    );

    expect(shownLines()).toEqual([]);
    expect(screen.getByText(/speaks the Anthropic Messages API/)).toBeTruthy();
  });

  describe("with a Claude subscription provider", () => {
    const claude: ConnectProvider = {
      name: "Claude team plan",
      catalogId: "anthropic_claude_login",
      api: "anthropic",
      models: ["claude-sonnet-5"],
      linkStatus: "linked",
    };

    it("isolates Claude Code JSON and shell requests under /claude-login", () => {
      render(<AgentConnectTabs endpoint={ENDPOINT} providers={[claude]} />);

      expect(shownLines()).toContain(
        `    "ANTHROPIC_BASE_URL": "https://${ENDPOINT}/claude-login"`,
      );
      expect(
        screen.getByText(/NetBird supplies the linked Claude login/),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Shell" }));
      expect(shownLines()).toContain(
        `export ANTHROPIC_BASE_URL=https://${ENDPOINT}/claude-login`,
      );
      expect(shownLines().join("\n")).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    });

    it.each([
      ["sdk", `    base_url="https://${ENDPOINT}/claude-login",`],
      ["opencode", `        "baseURL": "https://${ENDPOINT}/claude-login/v1",`],
      ["pi", `      "baseUrl": "https://${ENDPOINT}/claude-login",`],
    ])("uses the login route in %s config", (defaultTab, expectedLine) => {
      render(
        <AgentConnectTabs
          endpoint={ENDPOINT}
          providers={[claude]}
          defaultTab={defaultTab}
        />,
      );
      expect(shownLines()).toContain(expectedLine);
    });

    it("copies a prefixed Messages request without a credential", async () => {
      render(
        <AgentConnectTabs
          endpoint={ENDPOINT}
          providers={[claude]}
          defaultTab={"curl"}
        />,
      );
      const request = await copied();
      expect(request).toContain(`https://${ENDPOINT}/claude-login/v1/messages`);
      expect(request).not.toMatch(/Authorization|x-api-key/);
    });

    it("keeps API-key Anthropic requests outside the login namespace after changing provider", () => {
      const view = render(
        <AgentConnectTabs
          endpoint={ENDPOINT}
          providers={[claude]}
          defaultTab={"sdk"}
        />,
      );
      expect(shownLines()).toContain(
        `    base_url="https://${ENDPOINT}/claude-login",`,
      );
      view.rerender(
        <AgentConnectTabs
          endpoint={ENDPOINT}
          providers={anthropic}
          defaultTab={"sdk"}
        />,
      );
      expect(shownLines()).toContain(`    base_url="https://${ENDPOINT}",`);
      expect(shownLines().join("\n")).not.toContain("/claude-login");
    });

    it("does not generate a Codex config for an Anthropic-only login", () => {
      render(
        <AgentConnectTabs
          endpoint={ENDPOINT}
          providers={[claude]}
          defaultTab={"codex"}
        />,
      );
      expect(shownLines()).toEqual([]);
      expect(
        screen.getByText(/serves the Anthropic Messages API/),
      ).toBeTruthy();
    });

    it.each(["not_linked", "needs_relink", undefined] as const)(
      "shows %s login state outside the Claude tab",
      (linkStatus) => {
        render(
          <AgentConnectTabs
            endpoint={ENDPOINT}
            providers={[{ ...claude, linkStatus }]}
            defaultTab={"curl"}
          />,
        );
        const warning = screen.getByTestId(
          "connect-provider-login-missing",
        ).textContent;
        expect(warning).toContain("Claude login");
        expect(warning).toContain(
          linkStatus === "needs_relink" ? "links it again" : "links one",
        );
      },
    );
  });

  describe("with a ChatGPT subscription provider", () => {
    const chatgpt: ConnectProvider = {
      name: "ChatGPT",
      catalogId: "chatgpt_codex",
      api: "openai",
      models: [],
    };

    it("opens on Codex, pointed at the Codex backend path", () => {
      render(<AgentConnectTabs endpoint={ENDPOINT} providers={[chatgpt]} />);

      expect(
        screen.getByRole("tab", { name: "Codex", selected: true }),
      ).toBeTruthy();
      expect(shownLines()).toEqual([
        `model_provider = "netbird"`,
        ``,
        `[model_providers.netbird]`,
        `name = "NetBird"`,
        `base_url = "https://${ENDPOINT}/backend-api/codex"`,
        `wire_api = "responses"`,
      ]);
      expect(screen.getByText(/Codex ignores provider settings/)).toBeTruthy();
    });

    it("tells every other tool it can't use the subscription", () => {
      render(
        <AgentConnectTabs
          endpoint={ENDPOINT}
          defaultTab={"curl"}
          providers={[chatgpt]}
        />,
      );

      fireEvent.mouseDown(screen.getByRole("tab", { name: "cURL" }));
      expect(shownLines()).toEqual([]);
      expect(screen.getByText(/which only\s+Codex can use/)).toBeTruthy();
    });

    it("says an administrator has to link the login before requests work", () => {
      render(
        <AgentConnectTabs
          endpoint={ENDPOINT}
          providers={[{ ...chatgpt, linkStatus: "not_linked" }]}
        />,
      );
      expect(
        screen.getByTestId("connect-provider-login-missing").textContent,
      ).toMatch(/until an administrator links one/);

      cleanup();
      render(
        <AgentConnectTabs
          endpoint={ENDPOINT}
          providers={[{ ...chatgpt, linkStatus: "needs_relink" }]}
        />,
      );
      expect(
        screen.getByTestId("connect-provider-login-missing").textContent,
      ).toMatch(/until an administrator links it again/);

      cleanup();
      render(
        <AgentConnectTabs
          endpoint={ENDPOINT}
          providers={[{ ...chatgpt, linkStatus: "linked" }]}
        />,
      );
      expect(screen.queryByTestId("connect-provider-login-missing")).toBeNull();
    });

    it("picks a keyed provider first and keeps /v1 for its Codex config", () => {
      render(
        <AgentConnectTabs
          endpoint={ENDPOINT}
          defaultTab={"codex"}
          providers={[
            chatgpt,
            {
              name: "OpenAI",
              catalogId: "openai_api",
              api: "openai",
              models: ["gpt-4o"],
            },
          ]}
        />,
      );

      expect(shownLines()).toContain(`base_url = "https://${ENDPOINT}/v1"`);
    });
  });
});
