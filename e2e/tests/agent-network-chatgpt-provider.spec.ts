/**
 * Agent Network ChatGPT (Codex) provider spec.
 *
 * chatgpt_codex is a user_oauth catalog entry: the operator supplies no API
 * key, the upstream is pinned to https://chatgpt.com, and every user links
 * their own ChatGPT plan from the Connect Agent page. This walks the operator
 * side end to end (connect the provider without a key) and checks what the
 * caller then sees: a "Link ChatGPT" action and a Codex config pointed at the
 * Codex backend path rather than /v1.
 *
 * The device-code login itself is not driven here: approving it needs a real
 * ChatGPT account on OpenAI's page. The flow's polling and state handling are
 * covered by the unit tests next to useProviderLink.
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
const CHATGPT_CATALOG_NAME = "ChatGPT (Codex)";
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
  test("connect ChatGPT without a key and see the link action", async ({
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
      await page
        .getByRole("button", { name: /OpenAI API/ })
        .first()
        .click({ force: true });
      await page.getByPlaceholder("Search providers...").fill("chatgpt");
      await page.getByText(CHATGPT_CATALOG_NAME).first().click({ force: true });

      // No key field, and the upstream is pinned to the vendor host.
      await expect(
        page.getByTestId("agent-network-provider-user-oauth"),
      ).toBeVisible();
      await expect(
        page.getByTestId("agent-network-provider-api-key"),
      ).toHaveCount(0);
      const upstream = page.getByTestId("agent-network-provider-upstream-url");
      await expect(upstream).toHaveValue("https://chatgpt.com");
      await expect(upstream).toHaveAttribute("readonly", "");

      const providerName = generateRandomName(PROVIDER_PREFIX);
      await page
        .locator(`input[value="${CHATGPT_CATALOG_NAME}"]`)
        .fill(providerName);

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
      await page
        .getByRole("button", { name: "Connect Provider" })
        .last()
        .click({ force: true });
      const body = (await createRequest).postDataJSON() as Record<
        string,
        unknown
      >;
      expect(body, "no operator key is sent").not.toHaveProperty("api_key");
      expect(body.upstream_url).toBe("https://chatgpt.com");

      const created = await createResponse;
      expect([200, 201]).toContain(created.status());
      const createdProvider = (await created.json()) as { id: string };
      await expect(page.getByText(providerName).first()).toBeVisible();

      // ---- the caller's view ----
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

      await expect(
        page.getByRole("button", { name: "Link ChatGPT" }),
      ).toBeVisible({ timeout: 15_000 });

      // The only provider is Codex-only, so the page opens on Codex.
      await expect(
        page.getByText(/base_url = "https:\/\/[^"]+\/backend-api\/codex"/),
      ).toBeVisible();
      await expect(page.getByText("openai_base_url")).toHaveCount(0);

      await cleanupChatGPTFixtures(page);
    } finally {
      await close();
    }
  });
});
