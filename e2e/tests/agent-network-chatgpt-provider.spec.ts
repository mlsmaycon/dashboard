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
 * flow's polling and states are covered by the unit tests next to
 * useProviderLink.
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

test.describe
  .serial("Agent Network ChatGPT provider @agent-network @test-build", () => {
  test("connect OpenAI with a ChatGPT login and link it later", async ({
    browser,
  }) => {
    const { page, close } = await newAgentNetworkPage(browser);
    try {
      const catalog = await listAgentNetworkCatalog(page);
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
      expect((await linkRequest).url()).toContain(
        `/agent-network/providers/${createdProvider.id}/link`,
      );
      const linkLater = page.getByTestId("agent-network-provider-link-close");
      await expect(linkLater).toBeVisible();
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

      await cleanupChatGPTFixtures(page);
    } finally {
      await close();
    }
  });
});
