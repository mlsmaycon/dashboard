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
