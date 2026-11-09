/**
 * Agent Network ChatGPT login provider spec.
 *
 * An OpenAI provider can sign in with one ChatGPT login instead of an API
 * key. The record is the chatgpt_codex catalog entry (credential_kind
 * user_oauth): no api_key, the upstream pinned to https://chatgpt.com, and an
 * administrator links the login once for everyone the provider's policies
 * cover. This walks the operator side (pick OpenAI, choose the ChatGPT login,
 * connect, land on the link step, link later) and checks what a covered user
 * then sees: a Codex config on the /backend-api/codex path and a note that the
 * login still has to be linked.
 *
 * The device-code approval itself is not driven: it needs a real ChatGPT
 * account on OpenAI's page, and the test environment may not reach OpenAI at
 * all, so the link step is checked for appearing, not for its outcome. The
 * Browser fallback is exercised when the real catalog advertises it. Only
 * that provider's OAuth endpoints are mocked for device denial, callback URL
 * submission, retry and cancellation; provider and policy storage stay real.
 *
 * Skips on management builds whose catalog predates chatgpt_codex, the same
 * way the Kimi spec skips on a catalog without kimi_api.
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  createAgentNetworkPolicy,
  createGroup,
  deleteAgentNetworkPoliciesByPrefix,
  deleteAgentNetworkProvidersByPrefix,
  deleteGroup,
  getCurrentUser,
  listAgentNetworkCatalog,
  listGroups,
  supportsAgentNetworkAgentConfig,
  supportsAgentNetworkSettingsBootstrap,
  updateUserAutoGroups,
} from "../helpers/api";
import { loginToApp } from "../helpers/auth";
import { generateRandomName } from "../helpers/utils";

const AGENT_NETWORK_CONFIG_KEY = "netbird-test-agent-network";
const CHATGPT_CATALOG_ID = "chatgpt_codex";
const PROVIDER_PREFIX = "e2e-chatgpt-";

/**
 * Remove every fixture this spec creates; runs before the test too, so
 * leftovers from an interrupted run never poison the next one.
 */
async function cleanupChatGPTFixtures(page: Page) {
  await deleteAgentNetworkPoliciesByPrefix(page, PROVIDER_PREFIX);
  const fixtureGroups = (await listGroups(page)).filter((g) =>
    g.name.startsWith(PROVIDER_PREFIX),
  );
  if (fixtureGroups.length > 0) {
    const fixtureGroupIds = new Set(fixtureGroups.map((g) => g.id));
    const caller = await getCurrentUser(page);
    if ((caller.auto_groups ?? []).some((id) => fixtureGroupIds.has(id))) {
      await updateUserAutoGroups(
        page,
        caller,
        (caller.auto_groups ?? []).filter((id) => !fixtureGroupIds.has(id)),
      );
    }
    for (const g of fixtureGroups) {
      await deleteGroup(page, g.id);
    }
  }
  await deleteAgentNetworkProvidersByPrefix(page, PROVIDER_PREFIX);
}

async function newAgentNetworkPage(browser: Browser): Promise<{
  page: Page;
  close: () => Promise<void>;
}> {
  const context = await browser.newContext({
    storageState: "e2e/fixtures/auth/owner.json",
  });
  await context.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key as string, value as string);
      } catch (e) {}
    },
    [AGENT_NETWORK_CONFIG_KEY, "enabled"],
  );
  const page = await context.newPage();
  await loginToApp(page, "owner");
  return { page, close: () => context.close() };
}

async function exerciseBrowserFallback(
  page: Page,
  providerId: string,
  providerName: string,
) {
  const linkPath = `/agent-network/providers/${providerId}/link`;
  const starts: unknown[] = [];
  const completions: unknown[] = [];
  let deviceStarts = 0;
  let browserStarts = 0;
  let releaseCompletion: (() => void) | undefined;
  const completionGate = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  const flow = (id: string, browser: boolean, status = "pending") => ({
    id,
    status,
    flow: browser ? "authorization_code" : "device",
    user_code: browser ? "" : "WDJB-MJHT",
    verification_uri: browser ? "" : "https://auth.openai.com/codex/device",
    ...(browser
      ? {
          authorization_uri:
            "https://auth.openai.com/oauth/authorize?state=e2e-state",
        }
      : {}),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    interval_seconds: 1,
  });
  const callback = (code: string) =>
    `http://localhost:1455/auth/callback?code=${code}&state=e2e-state`;

  await page.route(
    (url) =>
      url.pathname.endsWith(linkPath) || url.pathname.includes(`${linkPath}/`),
    async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.url().endsWith(linkPath)) {
        const body = request.postDataJSON();
        starts.push(body);
        if (body.flow === "authorization_code") {
          browserStarts++;
          await route.fulfill({
            json: flow(
              `browser-${browserStarts}`,
              true,
              browserStarts === 2 ? "expired" : "pending",
            ),
          });
        } else if (++deviceStarts === 1) {
          await route.fulfill({
            status: 412,
            json: {
              code: 412,
              message: "Device login is disabled for this account",
            },
          });
        } else {
          await route.fulfill({ json: flow(`device-${deviceStarts}`, false) });
        }
        return;
      }
      const id = new URL(request.url()).pathname.split("/").at(-1)!;
      if (request.method() === "GET") {
        await route.fulfill({ json: flow(id, id.startsWith("browser-")) });
        return;
      }
      if (request.method() !== "POST") return route.continue();
      const body = request.postDataJSON();
      completions.push(body);
      if (body.code === callback("invalid")) {
        await route.fulfill({
          status: 422,
          json: { code: 422, message: "Invalid callback" },
        });
        return;
      }
      if (body.code === callback("late")) await completionGate;
      await route.fulfill({ json: flow(id, true, "linked") });
    },
  );

  try {
    await page.goto("/agent-network/providers");
    const row = page.locator("tr").filter({ hasText: providerName });
    const open = () =>
      row
        .getByRole("button", { name: "Link", exact: true })
        .click({ force: true });
    await open();
    const modal = page.getByTestId("agent-network-provider-link-modal");
    const useBrowser = modal.getByTestId("agent-network-provider-use-browser");
    const code = modal.getByTestId("agent-network-provider-authorization-code");
    const submit = modal.getByTestId("agent-network-provider-link-submit");
    await expect(modal).toContainText(
      "Device login is disabled for this account",
    );
    await useBrowser.click({ force: true });
    await expect(
      modal.getByText("Paste the full callback URL", { exact: true }),
    ).toBeVisible();
    await expect(modal).toContainText("localhost:1455/auth/callback");
    await expect(
      modal.getByText("Paste the code from the sign-in page", { exact: true }),
    ).toHaveCount(0);
    await expect(
      modal.getByTestId("agent-network-provider-authorization-link"),
    ).toHaveAttribute("href", /https:\/\/auth\.openai\.com\//);
    await expect(submit).toBeDisabled();
    await code.fill(callback("invalid"));
    const invalid = page.waitForResponse(
      (response) =>
        response.url().endsWith(`${linkPath}/browser-1`) &&
        response.request().method() === "POST",
    );
    await submit.click({ force: true });
    expect((await invalid).request().postDataJSON()).toEqual({
      code: callback("invalid"),
    });
    await expect(modal).toContainText("The login could not be completed");
    await expect(code).toHaveValue("");
    await code.fill(`  ${callback("valid")}  `);
    const linked = page.waitForResponse(
      (response) =>
        response.url().endsWith(`${linkPath}/browser-1`) &&
        response.request().method() === "POST",
    );
    await submit.click({ force: true });
    expect((await linked).request().postDataJSON()).toEqual({
      code: callback("valid"),
    });
    await expect(modal).toContainText("The ChatGPT plan is linked");
    await modal
      .getByRole("button", { name: "Done", exact: true })
      .click({ force: true });

    // A new dialog uses device login again. Switching to an expired browser
    // attempt and retrying must retain browser mode, including after errors.
    await open();
    await expect(
      modal.getByTestId("agent-network-provider-link-code"),
    ).toHaveText("WDJB-MJHT");
    await useBrowser.click({ force: true });
    await expect(modal).toContainText(
      "The code expired before the login was approved.",
    );
    await modal
      .getByRole("button", { name: "Try again", exact: true })
      .click({ force: true });
    await expect(code).toBeVisible();
    await expect(code).toHaveValue("");
    await code.fill(callback("late"));
    const lateRequest = page.waitForRequest(
      (request) =>
        request.url().endsWith(`${linkPath}/browser-3`) &&
        request.method() === "POST",
    );
    const lateResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`${linkPath}/browser-3`) &&
        response.request().method() === "POST",
    );
    await submit.click({ force: true });
    expect((await lateRequest).postDataJSON()).toEqual({
      code: callback("late"),
    });
    await modal
      .getByRole("button", { name: "Cancel", exact: true })
      .click({ force: true });
    releaseCompletion?.();
    await lateResponse;
    await expect(modal).toHaveCount(0);
    await expect(row.getByTestId("provider-login-not-linked")).toBeVisible();
    await open();
    await expect(
      modal.getByTestId("agent-network-provider-link-code"),
    ).toBeVisible();
    await expect(code).toHaveCount(0);
    await modal
      .getByRole("button", { name: "Cancel", exact: true })
      .click({ force: true });
    expect(starts).toEqual([
      {},
      { flow: "authorization_code" },
      {},
      { flow: "authorization_code" },
      { flow: "authorization_code" },
      {},
    ]);
    expect(completions).toEqual([
      { code: callback("invalid") },
      { code: callback("valid") },
      { code: callback("late") },
    ]);
  } finally {
    releaseCompletion?.();
  }
}

test.describe
  .serial("Agent Network ChatGPT provider @agent-network @test-build", () => {
  test("connect OpenAI with a ChatGPT login and link it later", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const { page, close } = await newAgentNetworkPage(browser);
    let fixturesStarted = false;
    try {
      const catalog = await listAgentNetworkCatalog(page);
      const chatgptCatalog = catalog.find(
        (entry) => entry.id === CHATGPT_CATALOG_ID,
      ) as { subscription_login?: { supported_flows?: string[] } } | undefined;
      const supportsBrowser =
        chatgptCatalog?.subscription_login?.supported_flows?.includes(
          "authorization_code",
        );
      test.skip(
        !catalog.some((c) => c.id === CHATGPT_CATALOG_ID),
        `management catalog has no ${CHATGPT_CATALOG_ID} entry`,
      );
      test.skip(
        !(await supportsAgentNetworkSettingsBootstrap(page)),
        "management build has no POST /agent-network/settings",
      );
      test.skip(
        !(await supportsAgentNetworkAgentConfig(page)),
        "management build has no GET /agent-network/agent-config",
      );

      fixturesStarted = true;
      await cleanupChatGPTFixtures(page);

      await page.goto("/agent-network/providers");
      await page.keyboard.press("Escape");

      // ---- connect the provider ----
      await page
        .getByRole("button", { name: "Connect Provider" })
        .first()
        .click({ force: true });

      // OpenAI is the default pick; the ChatGPT login is its other sign-in
      // method, not an entry of its own in the picker.
      await page
        .getByTestId("agent-network-provider-auth-login")
        .click({ force: true });

      // The shared-plan warning, no key field, and the upstream pinned to the
      // vendor host.
      await expect(
        page.getByTestId("agent-network-provider-user-oauth"),
      ).toContainText("shares one ChatGPT plan");
      await expect(
        page.getByTestId("agent-network-provider-api-key"),
      ).toHaveCount(0);
      const upstream = page.getByTestId("agent-network-provider-upstream-url");
      await expect(upstream).toHaveValue("https://chatgpt.com");
      await expect(upstream).toHaveAttribute("readonly", "");

      const providerName = generateRandomName(PROVIDER_PREFIX);
      await page.getByTestId("agent-network-provider-name").fill(providerName);

      await page.getByRole("tab", { name: "Models" }).click({ force: true });
      // Listing models needs a credential the provider doesn't have.
      await expect(
        page.getByRole("button", { name: "Load models from provider" }),
      ).toHaveCount(0);

      const createRequest = page.waitForRequest(
        (req) =>
          req.url().endsWith("/agent-network/providers") &&
          req.method() === "POST",
        { timeout: 30_000 },
      );
      const createResponse = page.waitForResponse(
        (resp) =>
          resp.url().endsWith("/agent-network/providers") &&
          resp.request().method() === "POST",
        { timeout: 30_000 },
      );
      const linkRequest = page.waitForRequest(
        (req) =>
          /\/agent-network\/providers\/[^/]+\/link$/.test(req.url()) &&
          req.method() === "POST",
        { timeout: 30_000 },
      );
      await page
        .getByTestId("agent-network-provider-submit")
        .click({ force: true });
      const body = (await createRequest).postDataJSON() as Record<
        string,
        unknown
      >;
      expect(body.provider_id).toBe("chatgpt_codex");
      expect(body, "no operator key is sent").not.toHaveProperty("api_key");
      expect(body.upstream_url).toBe("https://chatgpt.com");

      const created = await createResponse;
      expect([200, 201]).toContain(created.status());
      const createdProvider = (await created.json()) as { id: string };

      // ---- the link step follows in the same modal ----
      const initialLinkRequest = await linkRequest;
      expect(initialLinkRequest.postDataJSON()).toEqual({});
      expect(initialLinkRequest.url()).toContain(
        `/agent-network/providers/${createdProvider.id}/link`,
      );
      const linkLater = page.getByTestId("agent-network-provider-link-close");
      await expect(linkLater).toBeVisible();
      if (!supportsBrowser) {
        await expect(
          page.getByTestId("agent-network-provider-use-browser"),
        ).toHaveCount(0);
      }
      // Leaving before the login is approved keeps the provider, not linked.
      await linkLater.click({ force: true });

      const row = page.locator("tr").filter({ hasText: providerName });
      await expect(row.getByTestId("provider-login-not-linked")).toBeVisible();
      await expect(row.getByRole("button", { name: "Link" })).toBeVisible();

      // ---- the covered user's view ----
      const caller = await getCurrentUser(page);
      const grantGroup = await createGroup(page, `${PROVIDER_PREFIX}grant`);
      await updateUserAutoGroups(page, caller, [
        ...(caller.auto_groups ?? []),
        grantGroup.id,
      ]);
      await createAgentNetworkPolicy(page, {
        name: `${PROVIDER_PREFIX}policy`,
        source_groups: [grantGroup.id],
        destination_provider_ids: [createdProvider.id],
      });

      await page.goto("/agent-network/connect");

      // The only provider is Codex-only, so the page opens on Codex.
      await expect(
        page.getByText(/base_url = "https:\/\/[^"]+\/backend-api\/codex"/),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("openai_base_url")).toHaveCount(0);
      await expect(
        page.getByTestId("connect-provider-login-missing"),
      ).toContainText("administrator");

      if (supportsBrowser) {
        await test.step("browser fallback after device denial, retry and cancel", () =>
          exerciseBrowserFallback(page, createdProvider.id, providerName));
      } else {
        test
          .info()
          .annotations.push({
            type: "browser-fallback",
            description:
              "Skipped: management catalog does not advertise authorization_code support",
          });
      }
    } finally {
      try {
        if (fixturesStarted) await cleanupChatGPTFixtures(page);
      } finally {
        await close();
      }
    }
  });
});
