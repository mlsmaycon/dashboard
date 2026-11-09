// Logic for user_oauth providers: catalog entries with no operator key, where
// an administrator links one subscription login to
// the provider, and every request its policies allow goes out under that
// login. The components only render what these functions decide.

export type CredentialKind =
  | "static_key"
  | "gcp_service_account"
  | "user_oauth";

export type SubscriptionLinkStatus = "linked" | "not_linked" | "needs_relink";

// The provider's linked login, as the provider list and agent-config report
// it. Never carries tokens.
export type SubscriptionLink = {
  status: SubscriptionLinkStatus;
  plan_type?: string;
  linked_at?: string;
  // User id of whoever linked the current login.
  linked_by?: string;
  last_refreshed_at?: string;
};

export type LinkFlowStatus = "pending" | "linked" | "expired" | "failed";

// A login in progress. Missing flow means device for older management servers.
export type LinkFlow = {
  id: string;
  status: LinkFlowStatus;
  user_code: string;
  verification_uri: string;
  expires_at: string;
  interval_seconds: number;
  flow?: "device" | "authorization_code";
  authorization_uri?: string;
};

const USER_OAUTH: CredentialKind = "user_oauth";

// usesUserOAuth reports whether a catalog entry or agent-config provider takes
// its credential from a linked login rather than an operator key. A server
// that predates credential kinds reports none, which reads as a key.
export const usesUserOAuth = (
  entry: { credential_kind?: string } | undefined,
): boolean => entry?.credential_kind === USER_OAUTH;

// userOAuthUpstreamUrl is the only upstream the server accepts for a
// user_oauth entry: the catalog's vendor host over https. The login's tokens
// must not be sent anywhere else, so the operator can't change it.
export const userOAuthUpstreamUrl = (entry: { default_host: string }) =>
  `https://${entry.default_host}`;

// linkStatusOf reads a provider's link state. A user_oauth provider without
// one (an older server) has nothing linked as far as this dashboard can tell.
export const linkStatusOf = (
  link: SubscriptionLink | undefined,
): SubscriptionLinkStatus => link?.status ?? "not_linked";

// What the subscription is called on buttons and in copy, per catalog entry.
const SUBSCRIPTION_NAME: Record<string, string> = {
  chatgpt_codex: "ChatGPT",
  anthropic_claude_login: "Claude",
};

export const subscriptionName = (catalogId: string) =>
  SUBSCRIPTION_NAME[catalogId] ?? "subscription";

// Plan types arrive as the vendor's lowercase ids ("plus", "pro").
export const planLabel = (plan?: string) =>
  plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined;

// --- Choosing how a vendor authenticates ---

// A login entry is reached through its vendor's entry in the provider picker
// rather than listed on its own: the operator picks OpenAI, then how it signs
// in. Keyed by the vendor's key-based entry.
const LOGIN_ALTERNATIVE: Record<string, string> = {
  openai_api: "chatgpt_codex",
  anthropic_api: "anthropic_claude_login",
};

export type AuthMethod = "api_key" | "login";

export const loginAlternativeOf = (catalogId: string) =>
  LOGIN_ALTERNATIVE[catalogId];

export const isLoginAlternative = (catalogId: string) =>
  Object.values(LOGIN_ALTERNATIVE).includes(catalogId);

// pickerIdOf is the entry the provider picker shows for a catalog id: the
// vendor's key-based entry for a login alternative, the id itself otherwise.
export const pickerIdOf = (catalogId: string) =>
  Object.keys(LOGIN_ALTERNATIVE).find(
    (key) => LOGIN_ALTERNATIVE[key] === catalogId,
  ) ?? catalogId;

export const authMethodOf = (catalogId: string): AuthMethod =>
  isLoginAlternative(catalogId) ? "login" : "api_key";

// catalogIdFor is the record's catalog id for a picked vendor and sign-in
// method. A vendor without a login alternative always uses its own entry.
export const catalogIdFor = (pickerId: string, method: AuthMethod) =>
  method === "login" ? LOGIN_ALTERNATIVE[pickerId] ?? pickerId : pickerId;

// --- Codex on a subscription ---

// Catalog entries that only Codex can talk to, with the request path the
// gateway routes them by. The ChatGPT backend serves Codex under
// /backend-api/codex, not the public API's /v1, so no other tool's config
// reaches it.
const CODEX_SUBSCRIPTION_PATH: Record<string, string> = {
  chatgpt_codex: "/backend-api/codex",
};

export const isCodexOnly = (catalogId: string | undefined) =>
  !!catalogId && catalogId in CODEX_SUBSCRIPTION_PATH;

// codexSubscriptionLines is the ~/.codex/config.toml block for a Codex-only
// provider. No env_key, same as the API-key Codex config: NetBird identifies
// the caller by their tunnel, and the proxy presents the provider's linked
// login upstream. It registers a named provider rather than setting
// openai_base_url, so Codex's built-in OpenAI provider stays untouched.
export function codexSubscriptionLines(
  catalogId: string,
  baseUrl: string,
  model?: string,
): string[] {
  const path = CODEX_SUBSCRIPTION_PATH[catalogId] ?? "/v1";
  return [
    ...(model ? [`model = "${model}"`] : []),
    `model_provider = "netbird"`,
    ``,
    `[model_providers.netbird]`,
    `name = "NetBird"`,
    `base_url = "${baseUrl}${path}"`,
    `wire_api = "responses"`,
  ];
}

// --- Link flow state machine ---

export type LinkState =
  | { phase: "idle" }
  | { phase: "starting" }
  // checkedAt is when the server last answered, to count the code's
  // remaining lifetime from.
  | {
      phase: "pending";
      flow: LinkFlow;
      checkedAt: number;
      completionError?: string;
    }
  | { phase: "completing"; flow: LinkFlow; checkedAt: number }
  | { phase: "linked"; flow: LinkFlow }
  | { phase: "expired"; flow: LinkFlow }
  | { phase: "failed"; flow?: LinkFlow; message?: string }
  // The server refused to start a flow at all (412: vendor device login off
  // or no datastore encryption key; 403: no permission to edit providers;
  // 404: provider gone).
  | { phase: "unavailable"; message: string };

export type LinkAction =
  | { type: "start" }
  | { type: "flow"; flow: LinkFlow; at: number }
  | { type: "start-error"; code?: number; message?: string }
  | { type: "poll-error"; code?: number; message?: string }
  | { type: "complete" }
  | { type: "complete-error"; code?: number }
  // The user closed the dialog: whatever was in flight is abandoned.
  | { type: "cancel" };

export const IDLE: LinkState = { phase: "idle" };

const fromFlow = (flow: LinkFlow, at: number): LinkState => {
  switch (flow.status) {
    case "pending":
      return { phase: "pending", flow, checkedAt: at };
    case "linked":
      return { phase: "linked", flow };
    case "expired":
      return { phase: "expired", flow };
    default:
      // "failed", and any status this dashboard doesn't know yet: neither can
      // turn into a login by waiting longer.
      return { phase: "failed", flow };
  }
};

export function startErrorMessage(code?: number, message?: string): string {
  if (code === 403)
    return "Linking a login needs permission to edit providers.";
  if (code === 404) return "This provider no longer exists.";
  if (code === 412)
    return message
      ? `Linking isn't available right now: ${message}.`
      : "Linking isn't available on this NetBird server.";
  return message
    ? `The login could not be started: ${message}.`
    : "The login could not be started.";
}

// linkReducer moves a link attempt through its phases. A flow answer only
// lands while one is starting, pending or completing, so a late answer can't
// reopen a finished attempt. A failed poll is retried on the next tick, except when
// the server no longer knows the flow (404) or refuses it (400).
// "start" is accepted from any phase: it is also how a finished or abandoned
// attempt is retried.
export function linkReducer(state: LinkState, action: LinkAction): LinkState {
  switch (action.type) {
    case "start":
      return { phase: "starting" };
    case "cancel":
      return IDLE;
    case "flow":
      if (
        state.phase !== "starting" &&
        state.phase !== "pending" &&
        state.phase !== "completing"
      )
        return state;
      if (state.phase === "pending" && action.flow.status === "pending") {
        return { ...state, flow: action.flow, checkedAt: action.at };
      }
      return fromFlow(action.flow, action.at);
    case "complete":
      if (state.phase !== "pending" || state.flow.flow !== "authorization_code")
        return state;
      return {
        phase: "completing",
        flow: state.flow,
        checkedAt: state.checkedAt,
      };
    case "complete-error":
      if (state.phase !== "completing") return state;
      if (action.code === 404 || action.code === 410)
        return {
          phase: "failed",
          flow: state.flow,
          message: "The login is no longer available. Start a new one.",
        };
      return {
        phase: "pending",
        flow: state.flow,
        checkedAt: state.checkedAt,
        completionError:
          "The login could not be completed. Check the code from the sign-in page and try again, or start a new login.",
      };
    case "start-error":
      if (state.phase !== "starting") return state;
      return {
        phase: "unavailable",
        message: startErrorMessage(action.code, action.message),
      };
    case "poll-error":
      if (state.phase !== "pending") return state;
      if (action.code === 404 || action.code === 400)
        return {
          phase: "failed",
          flow: state.flow,
          message: "The login was lost on the server. Start a new one.",
        };
      // A fresh object, so the polling loop schedules the retry.
      return { ...state };
  }
}

// The server contacts the vendor at most once per interval, so polling faster
// only returns the same answer. A missing or zero interval falls back to the
// device-flow default of five seconds.
const DEFAULT_POLL_SECONDS = 5;

export const pollDelayMs = (flow: Pick<LinkFlow, "interval_seconds">) =>
  (flow.interval_seconds > 0 ? flow.interval_seconds : DEFAULT_POLL_SECONDS) *
  1000;

// minutesLeft rounds the code's remaining lifetime up to whole minutes, so a
// code with seconds to spare doesn't already read as "0 minutes".
export function minutesLeft(expiresAt: string, now: number): number {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 60_000);
}
