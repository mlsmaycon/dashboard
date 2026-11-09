import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LinkFlow,
  LinkState,
} from "@/modules/agent-network/subscriptionLink";

vi.mock("@utils/api", () => ({ default: () => ({ data: [] }) }));
vi.mock("@components/Notification", () => ({ notify: vi.fn() }));

const { ProviderLinkBody } = await import(
  "@/modules/agent-network/ProviderLinkModal"
);

afterEach(cleanup);

const flow: LinkFlow = {
  id: "flow-1",
  status: "pending",
  flow: "authorization_code",
  authorization_uri: "https://claude.ai/oauth/authorize?state=example",
  user_code: "",
  verification_uri: "",
  expires_at: "2026-11-09T12:15:00Z",
  interval_seconds: 5,
};
const pending: LinkState = {
  phase: "pending",
  flow,
  checkedAt: Date.parse("2026-11-09T12:00:00Z"),
};

describe("ProviderLinkBody", () => {
  it("offers the browser alternative only when the catalog advertises it", () => {
    const onUseBrowser = vi.fn();
    const props = {
      state: {
        ...pending,
        flow: {
          ...flow,
          flow: undefined,
          user_code: "ABCD-1234",
          verification_uri: "https://auth.openai.com/codex/device",
        },
      },
      catalogId: "chatgpt_codex",
      onRetry: vi.fn(),
      onComplete: vi.fn(),
      onUseBrowser,
    };
    const { rerender } = render(
      <ProviderLinkBody {...props} subscriptionLogin={{ flow: "device" }} />,
    );
    expect(
      screen.queryByRole("button", { name: "Use browser sign-in" }),
    ).toBeNull();
    rerender(
      <ProviderLinkBody
        {...props}
        subscriptionLogin={{
          flow: "device",
          supported_flows: ["device", "authorization_code"],
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Use browser sign-in" }),
    );
    expect(onUseBrowser).toHaveBeenCalledOnce();
  });

  it("offers browser sign-in after a device start is unavailable", () => {
    render(
      <ProviderLinkBody
        state={{ phase: "unavailable", message: "Device login is disabled" }}
        catalogId="chatgpt_codex"
        subscriptionLogin={{
          flow: "device",
          supported_flows: ["device", "authorization_code"],
        }}
        onUseBrowser={vi.fn()}
        onRetry={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    expect(screen.getByText("Device login is disabled")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Use browser sign-in" }),
    ).toBeTruthy();
  });

  it("asks ChatGPT users for the complete localhost callback URL and clears it on submit", () => {
    const complete = vi.fn();
    const callback =
      "http://localhost:1455/auth/callback?code=one-use-code&state=expected-state";
    render(
      <ProviderLinkBody
        state={{
          ...pending,
          flow: {
            ...flow,
            authorization_uri: "https://auth.openai.com/oauth/authorize",
          },
        }}
        catalogId="chatgpt_codex"
        onRetry={vi.fn()}
        onComplete={complete}
      />,
    );
    expect(screen.getByText(/localhost page may not load/)).toBeTruthy();
    const input = screen.getByLabelText(
      "Paste the full callback URL",
    ) as HTMLInputElement;
    expect(input.placeholder).toContain(
      "http://localhost:1455/auth/callback?code=",
    );
    fireEvent.change(input, { target: { value: callback } });
    fireEvent.click(screen.getByRole("button", { name: "Link login" }));
    expect(complete).toHaveBeenCalledExactlyOnceWith(callback);
    expect(input.value).toBe("");
  });

  it("keeps a failed ChatGPT exchange focused on copying the callback URL", () => {
    render(
      <ProviderLinkBody
        state={{
          ...pending,
          completionError:
            "The login could not be completed. Check the code from the sign-in page and try again.",
        }}
        catalogId="chatgpt_codex"
        onRetry={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        /Copy the full callback URL from your browser’s address bar and try again/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(/Check the code from the sign-in page/),
    ).toBeNull();
  });
  it("opens the external authorization page and clears the pasted code on submission", () => {
    const complete = vi.fn();
    render(
      <ProviderLinkBody
        state={pending}
        catalogId="anthropic_claude_login"
        onRetry={vi.fn()}
        onComplete={complete}
      />,
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(flow.authorization_uri);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    const input = screen.getByLabelText(
      "Paste the code from the sign-in page",
    ) as HTMLInputElement;
    expect(input.type).toBe("password");
    const button = screen.getByRole("button", {
      name: "Link login",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "example-code#example" } });
    fireEvent.click(button);
    expect(complete).toHaveBeenCalledExactlyOnceWith("example-code#example");
    expect(input.value).toBe("");
  });

  it("disables input and submission while linking", () => {
    render(
      <ProviderLinkBody
        state={{ ...pending, phase: "completing" }}
        catalogId="anthropic_claude_login"
        onRetry={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    expect(
      (
        screen.getByLabelText(
          "Paste the code from the sign-in page",
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Linking…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("preserves device-code login when the server omits the flow discriminator", () => {
    render(
      <ProviderLinkBody
        state={{
          ...pending,
          flow: {
            ...flow,
            flow: undefined,
            authorization_uri: undefined,
            user_code: "ABCD-1234",
            verification_uri: "https://auth.openai.com/codex/device",
          },
        }}
        catalogId="chatgpt_codex"
        onRetry={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    expect(screen.getByText("ABCD-1234")).toBeTruthy();
    expect(
      screen.queryByLabelText("Paste the code from the sign-in page"),
    ).toBeNull();
  });
});
