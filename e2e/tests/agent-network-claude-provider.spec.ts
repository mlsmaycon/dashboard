/**
 * Creates a real Claude subscription provider and checks its authorization
 * flow and policy-scoped Connect configuration. Only the OAuth endpoints are
 * mocked for the paste/error/success/cancel interaction: no external account
 * or reusable credential is needed, and provider persistence remains real.
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

const CLAUDE_CATALOG_ID = "anthropic_claude_login";
const PROVIDER_PREFIX = "e2e-claude-";

async function cleanupClaudeFixtures(page: Page) {
  await deleteAgentNetworkPoliciesByPrefix(page, PROVIDER_PREFIX);
  const groups = (await listGroups(page)).filter((group) =>
    group.name.startsWith(PROVIDER_PREFIX),
  );
  if (groups.length) {
    const ids = new Set(groups.map((group) => group.id));
    const caller = await getCurrentUser(page);
    if ((caller.auto_groups ?? []).some((id) => ids.has(id))) {
      await updateUserAutoGroups(
        page,
        caller,
        (caller.auto_groups ?? []).filter((id) => !ids.has(id)),
      );
    }
    for (const group of groups) await deleteGroup(page, group.id);
  }
  await deleteAgentNetworkProvidersByPrefix(page, PROVIDER_PREFIX);
}

async function newAgentNetworkPage(browser: Browser) {
  const context = await browser.newContext({
    storageState: "e2e/fixtures/auth/owner.json",
  });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("netbird-test-agent-network", "enabled");
    } catch {}
  });
  const page = await context.newPage();
  await loginToApp(page, "owner");
  return { page, close: () => context.close() };
}

test.describe
  .serial("Agent Network Claude provider @agent-network @test-build", () => {
  test("create a shared Claude provider, connect an agent, and complete or cancel login", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const { page, close } = await newAgentNetworkPage(browser);
    let fixturesStarted = false;
    let releaseCompletion: (() => void) | undefined;
    try {
      const catalog = await listAgentNetworkCatalog(page);
      test.skip(
        !catalog.some((entry) => entry.id === CLAUDE_CATALOG_ID),
        `management catalog has no ${CLAUDE_CATALOG_ID} entry`,
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
      await cleanupClaudeFixtures(page);

      await page.goto("/agent-network/providers");
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "Connect Provider" })
        .first()
        .click({ force: true });
      await page
        .getByRole("button", { name: /OpenAI API/ })
        .first()
        .click({ force: true });
      await page.getByPlaceholder("Search providers...").fill("anthropic");
      const anthropicName = catalog.find(
        (entry) => entry.id === "anthropic_api",
      )!.name;
      await page
        .getByText(anthropicName, { exact: true })
        .click({ force: true });
      await page
        .getByTestId("agent-network-provider-auth-login")
        .click({ force: true });

      await expect(
        page.getByTestId("agent-network-provider-user-oauth"),
      ).toContainText("shares one Claude plan");
      await expect(
        page.getByTestId("agent-network-provider-api-key"),
      ).toHaveCount(0);
      const upstream = page.getByTestId("agent-network-provider-upstream-url");
      await expect(upstream).toHaveValue("https://api.anthropic.com");
      await expect(upstream).toHaveAttribute("readonly", "");
      const providerName = generateRandomName(PROVIDER_PREFIX);
      await page.getByTestId("agent-network-provider-name").fill(providerName);
      await page.getByRole("tab", { name: "Models" }).click({ force: true });
      await expect(
        page.getByRole("button", { name: "Load models from provider" }),
      ).toHaveCount(0);

      const createResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith("/agent-network/providers") &&
          response.request().method() === "POST",
      );
      const startResponse = page.waitForResponse(
        (response) =>
          /\/agent-network\/providers\/[^/]+\/link$/.test(response.url()) &&
          response.request().method() === "POST",
      );
      await page
        .getByTestId("agent-network-provider-submit")
        .click({ force: true });
      const created = await createResponse;
      expect([200, 201]).toContain(created.status());
      const createBody = created.request().postDataJSON();
      expect(createBody.provider_id).toBe(CLAUDE_CATALOG_ID);
      expect(createBody.upstream_url).toBe("https://api.anthropic.com");
      expect(createBody).not.toHaveProperty("api_key");
      const { id: providerId } = (await created.json()) as { id: string };
      const linkPath = `/agent-network/providers/${providerId}/link`;

      // This start request reaches management. Building a PKCE URL needs no
      // client registration, external consent, or upstream network request.
      const started = await startResponse;
      expect(started.request().url()).toContain(linkPath);
      expect(started.request().postDataJSON()).toEqual({});
      expect(started.status()).toBe(200);
      const realFlow = await started.json();
      expect(realFlow).toMatchObject({
        flow: "authorization_code",
        status: "pending",
      });
      const authorization = new URL(realFlow.authorization_uri);
      expect(authorization.origin).toBe("https://claude.ai");
      expect(authorization.pathname).toBe("/oauth/authorize");
      expect(authorization.searchParams.get("response_type")).toBe("code");
      expect(authorization.searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      expect(authorization.searchParams.get("code_challenge")).toBeTruthy();
      expect(authorization.searchParams.get("state")).toBeTruthy();
      expect(authorization.searchParams.get("client_id")).toBeTruthy();
      expect(realFlow).not.toHaveProperty("code_verifier");
      expect(realFlow).not.toHaveProperty("access_token");
      await expect(
        page.getByTestId("agent-network-provider-authorization-link"),
      ).toHaveAttribute("href", realFlow.authorization_uri);
      await expect(
        page.getByTestId("agent-network-provider-authorization-code"),
      ).toBeVisible();
      await page
        .getByTestId("agent-network-provider-link-close")
        .click({ force: true });
      const row = page.locator("tr").filter({ hasText: providerName });
      await expect(row.getByTestId("provider-login-not-linked")).toBeVisible();

      const caller = await getCurrentUser(page);
      const grantGroup = await createGroup(page, `${PROVIDER_PREFIX}grant`);
      await updateUserAutoGroups(page, caller, [
        ...(caller.auto_groups ?? []),
        grantGroup.id,
      ]);
      await createAgentNetworkPolicy(page, {
        name: `${PROVIDER_PREFIX}policy`,
        source_groups: [grantGroup.id],
        destination_provider_ids: [providerId],
      });
      await page.goto("/agent-network/connect");
      await expect(
        page.getByText(
          /"ANTHROPIC_BASE_URL": "https:\/\/[^\"]+\/claude-login"/,
        ),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByTestId("connect-provider-login-missing"),
      ).toContainText("Claude login");
      await page.getByRole("tab", { name: /curl/i }).click({ force: true });
      await expect(page.getByText(/claude-login\/v1\/messages/)).toBeVisible();

      // Keep the provider, catalog and policy APIs real. Stub only the
      // vendor-dependent login outcome, bound to this provider and flow.
      let flowCount = 0;
      const completeBodies: unknown[] = [];
      const pendingFlow = (id: string) => ({
        id,
        flow: "authorization_code",
        status: "pending",
        user_code: "",
        verification_uri: "",
        authorization_uri: "https://claude.ai/oauth/authorize?state=e2e-state",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        interval_seconds: 1,
      });
      const completionGate = new Promise<void>((resolve) => {
        releaseCompletion = resolve;
      });
      await page.route(
        (url) =>
          url.pathname.endsWith(linkPath) ||
          url.pathname.includes(`${linkPath}/`),
        async (route) => {
          const request = route.request();
          if (request.method() === "POST" && request.url().endsWith(linkPath)) {
            expect(request.postDataJSON()).toEqual({});
            await route.fulfill({
              json: pendingFlow(`e2e-flow-${++flowCount}`),
            });
            return;
          }
          const flowId = new URL(request.url()).pathname.split("/").at(-1)!;
          expect(flowId).toMatch(/^e2e-flow-\d+$/);
          if (request.method() === "GET") {
            await route.fulfill({ json: pendingFlow(flowId) });
            return;
          }
          if (request.method() !== "POST") return route.continue();
          const body = request.postDataJSON();
          completeBodies.push(body);
          if (body.code === "invalid-code#e2e-state") {
            await route.fulfill({
              status: 422,
              json: { code: 422, message: "Invalid authorization code" },
            });
            return;
          }
          if (body.code === "late-code#e2e-state") await completionGate;
          await route.fulfill({
            json: { ...pendingFlow(flowId), status: "linked" },
          });
        },
      );
      await page.goto("/agent-network/providers");
      await row
        .getByRole("button", { name: "Link", exact: true })
        .click({ force: true });
      const modal = page.getByTestId("agent-network-provider-link-modal");
      const codeInput = modal.getByTestId(
        "agent-network-provider-authorization-code",
      );
      const submit = modal.getByTestId("agent-network-provider-link-submit");
      await expect(submit).toBeDisabled();
      await expect(codeInput).toHaveAttribute("type", "password");
      await codeInput.fill("invalid-code#e2e-state");
      const failedCompletion = page.waitForResponse(
        (response) =>
          response.url().endsWith(`${linkPath}/e2e-flow-1`) &&
          response.request().method() === "POST",
      );
      await submit.click({ force: true });
      expect((await failedCompletion).status()).toBe(422);
      await expect(modal).toContainText("The login could not be completed");
      await expect(codeInput).toHaveValue("");

      await codeInput.fill("  valid-code#e2e-state  ");
      const linked = page.waitForResponse(
        (response) =>
          response.url().endsWith(`${linkPath}/e2e-flow-1`) &&
          response.request().method() === "POST",
      );
      await submit.click({ force: true });
      expect((await linked).request().postDataJSON()).toEqual({
        code: "valid-code#e2e-state",
      });
      await expect(modal).toContainText("The Claude plan is linked");
      await modal
        .getByRole("button", { name: "Done", exact: true })
        .click({ force: true });
      await expect(modal).toHaveCount(0);

      // The simulated exchange did not persist a real vendor token. A new
      // attempt starts independently; closing it ignores its late response.
      await row
        .getByRole("button", { name: "Link", exact: true })
        .click({ force: true });
      await codeInput.fill("late-code#e2e-state");
      const lateRequest = page.waitForRequest(
        (request) =>
          request.url().endsWith(`${linkPath}/e2e-flow-2`) &&
          request.method() === "POST",
      );
      const lateResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith(`${linkPath}/e2e-flow-2`) &&
          response.request().method() === "POST",
      );
      await submit.click({ force: true });
      expect((await lateRequest).postDataJSON()).toEqual({
        code: "late-code#e2e-state",
      });
      await modal
        .getByRole("button", { name: "Cancel", exact: true })
        .click({ force: true });
      await expect(modal).toHaveCount(0);
      releaseCompletion?.();
      await lateResponse;
      await expect(modal).toHaveCount(0);
      await expect(row.getByTestId("provider-login-not-linked")).toBeVisible();
      await row
        .getByRole("button", { name: "Link", exact: true })
        .click({ force: true });
      await expect(codeInput).toHaveValue("");
      await expect(submit).toBeDisabled();
      await modal
        .getByRole("button", { name: "Cancel", exact: true })
        .click({ force: true });
      expect(flowCount).toBe(3);
      expect(completeBodies).toEqual([
        { code: "invalid-code#e2e-state" },
        { code: "valid-code#e2e-state" },
        { code: "late-code#e2e-state" },
      ]);
    } finally {
      releaseCompletion?.();
      try {
        if (fixturesStarted) await cleanupClaudeFixtures(page);
      } finally {
        await close();
      }
    }
  });
});
