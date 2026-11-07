import useFetchApi from "@utils/api";
import { useCallback } from "react";
import { useSWRConfig } from "swr";
import type {
  CredentialKind,
  SubscriptionLink,
} from "@/modules/agent-network/subscriptionLink";

// Wire types for the caller-scoped self-service endpoints. Both answers are
// computed server-side from the caller's own group memberships with the same
// rules the proxy enforces, so no agent_network permission is required to
// read them.
export type APIMeProvider = {
  // Record id, which the subscription link endpoints take. id and
  // credential_kind are missing on servers that predate subscription links.
  id?: string;
  name: string;
  catalog_id: string;
  api_flavor: string;
  all_models_allowed: boolean;
  models: string[];
  credential_kind?: CredentialKind;
  // The caller's own login, present only for user_oauth providers.
  subscription_link?: SubscriptionLink;
};

export type APIMeSetup = {
  configured: boolean;
  endpoint: string;
  providers: APIMeProvider[];
};

// The endpoint was renamed from me/setup to agent-config. A dashboard release
// has to work against the management server already deployed, which may still
// be serving the old path, so the old one is tried when the new one answers
// with an error. Drop this once every supported management build carries the
// rename: until then, dropping it takes the self-service pages away from every
// caller on an older server — including the whole sidebar of a user whose only
// nav items are these.
const AGENT_CONFIG_PATH = "/agent-network/agent-config";
const LEGACY_AGENT_CONFIG_PATH = "/agent-network/me/setup";

/**
 * Fetch the caller's effective Agent Network setup. `configured` doubles as
 * the visibility switch for the self-service pages: the server deliberately
 * answers "not configured" both when the account has no Agent Network and
 * when the caller's policies grant no access, so a false here means there is
 * nothing to show this user. Errors are ignored so a management server
 * without either endpoint degrades to the section staying hidden.
 */
export const useMyAgentNetworkSetup = () => {
  const { data, error, isLoading } = useFetchApi<APIMeSetup>(
    AGENT_CONFIG_PATH,
    true,
  );
  const legacy = useFetchApi<APIMeSetup>(
    LEGACY_AGENT_CONFIG_PATH,
    true,
    true,
    // Only asked for once the current path has actually failed, so a
    // server carrying the rename never sees the old path at all.
    !!error,
  );

  const setup = data ?? legacy.data;
  return {
    setup,
    configured: setup?.configured === true,
    // Still loading while the fallback is in flight, so callers gating a
    // route on this don't read a miss as a final "not configured".
    isLoading: isLoading || (!!error && legacy.isLoading),
  } as const;
};

/**
 * Returns a function that refetches the caller's agent config, for when
 * something the answer reports (a subscription link) changed. Both paths are
 * revalidated; the one this server doesn't serve is a no-op.
 */
export const useRefreshAgentConfig = () => {
  const { mutate } = useSWRConfig();
  return useCallback(
    () =>
      Promise.all([
        mutate(AGENT_CONFIG_PATH),
        mutate(LEGACY_AGENT_CONFIG_PATH),
      ]).then(() => undefined),
    [mutate],
  );
};
