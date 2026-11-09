"use client";

import { ErrorResponse, useApiCall } from "@utils/api";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { useEventCallback } from "@/hooks/useEventCallback";
import {
  IDLE,
  LinkFlow,
  LinkFlowKind,
  linkReducer,
  pollDelayMs,
} from "@/modules/agent-network/subscriptionLink";
import { useRefreshAgentConfig } from "@/modules/agent-network/useMyAgentNetworkSetup";

const errorOf = (err: unknown) => {
  const e = (err ?? {}) as Partial<ErrorResponse>;
  return { code: e.code, message: e.message };
};

const PROVIDERS_PATH = "/agent-network/providers";
const linkSuffix = (providerId: string) => `/${providerId}/link`;

/**
 * Runs the login that links a subscription to a user_oauth
 * provider: start(providerId) asks the server for a sign-in flow, then it is
 * polled every interval_seconds until it is linked, expired or failed. The
 * provider id is passed to start rather than to the hook, so a modal can link
 * the provider it has only just created. Polling stops on a terminal state,
 * on cancel(), and when the component using the hook unmounts. onLinked runs
 * once per successful link, so the caller can refresh what shows the state.
 */
export function useProviderLink({ onLinked }: { onLinked?: () => void } = {}) {
  const [state, dispatch] = useReducer(linkReducer, IDLE);
  const [requestedFlow, setRequestedFlow] = useState<LinkFlowKind>();
  // Errors are shown in the dialog, which knows what each one means here,
  // instead of the generic request-failed toast.
  const api = useApiCall<LinkFlow>(PROVIDERS_PATH, true);
  const requestStart = useEventCallback(
    (providerId: string, flow?: LinkFlowKind) =>
      api.post(flow ? { flow } : {}, linkSuffix(providerId)),
  );
  const requestFlow = useEventCallback((providerId: string, flowId: string) =>
    api.get(`${linkSuffix(providerId)}/${flowId}`),
  );
  const requestComplete = useEventCallback(
    (providerId: string, flowId: string, code: string) =>
      api.post({ code }, `${linkSuffix(providerId)}/${flowId}`),
  );
  const notifyLinked = useEventCallback(() => onLinked?.());

  // Each start() owns one attempt. An answer for an older attempt, or one
  // arriving after unmount, is dropped rather than overwriting the current one.
  const attempt = useRef(0);
  const target = useRef("");
  const mounted = useRef(true);
  const submitting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(
    (providerId: string, flow?: LinkFlowKind) => {
      const current = ++attempt.current;
      submitting.current = false;
      target.current = providerId;
      setRequestedFlow(flow);
      const live = () => mounted.current && attempt.current === current;
      dispatch({ type: "start" });
      requestStart(providerId, flow)
        .then(
          (flow) => live() && dispatch({ type: "flow", flow, at: Date.now() }),
        )
        .catch(
          (err) => live() && dispatch({ type: "start-error", ...errorOf(err) }),
        );
    },
    [requestStart],
  );

  // Retrying preserves an explicitly selected method; a fresh start without
  // one keeps the server's default, including on older management servers.
  const retry = useEventCallback(() => {
    if (target.current) start(target.current, requestedFlow);
  });

  // Authorization codes are single-use. Never retry this POST automatically,
  // and invalidate any already-running poll before submitting it.
  const complete = useEventCallback((code: string) => {
    if (
      state.phase !== "pending" ||
      state.flow.flow !== "authorization_code" ||
      submitting.current ||
      !code.trim()
    )
      return;
    submitting.current = true;
    const current = ++attempt.current;
    const live = () => mounted.current && attempt.current === current;
    dispatch({ type: "complete" });
    requestComplete(target.current, state.flow.id, code.trim())
      .then(
        (flow) => live() && dispatch({ type: "flow", flow, at: Date.now() }),
      )
      .catch(
        (err) =>
          live() &&
          dispatch({ type: "complete-error", code: errorOf(err).code }),
      )
      .finally(() => {
        if (live()) submitting.current = false;
      });
  });

  // The effect is the polling loop: every answer, "pending" again or a poll
  // that failed and is to be retried, is a new state object and schedules the
  // next request. Any other phase ends it.
  useEffect(() => {
    if (state.phase !== "pending") return;
    const current = attempt.current;
    const providerId = target.current;
    let cancelled = false;
    const live = () =>
      !cancelled && mounted.current && attempt.current === current;
    const timer = setTimeout(() => {
      requestFlow(providerId, state.flow.id)
        .then(
          (flow) => live() && dispatch({ type: "flow", flow, at: Date.now() }),
        )
        .catch(
          (err) => live() && dispatch({ type: "poll-error", ...errorOf(err) }),
        );
    }, pollDelayMs(state.flow));
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [state, requestFlow]);

  useEffect(() => {
    if (state.phase === "linked") notifyLinked();
  }, [state.phase, notifyLinked]);

  // cancel abandons the current attempt and stops polling. The flow is left
  // to expire on the server; nothing there needs undoing.
  const cancel = useCallback(() => {
    attempt.current++;
    submitting.current = false;
    setRequestedFlow(undefined);
    target.current = "";
    dispatch({ type: "cancel" });
  }, []);

  return { state, requestedFlow, start, retry, complete, cancel } as const;
}

/**
 * Forgets a provider's linked login. Resolves true once the server confirms;
 * a failure is reported by the shared request-failed toast.
 */
export function useProviderUnlink() {
  const api = useApiCall<object>(PROVIDERS_PATH);
  return useEventCallback((providerId: string) =>
    api
      .del("", linkSuffix(providerId))
      .then(() => true)
      .catch(() => false),
  );
}

/**
 * Refetches everything that shows a provider's link state: the provider list
 * on the admin pages and the agent config on the Connect Agent page.
 */
export function useRefreshLinkState() {
  const { mutate } = useSWRConfig();
  const refreshAgentConfig = useRefreshAgentConfig();
  return useCallback(
    () =>
      Promise.all([mutate(PROVIDERS_PATH), refreshAgentConfig()]).then(
        () => undefined,
      ),
    [mutate, refreshAgentConfig],
  );
}
