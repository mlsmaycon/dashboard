"use client";

import { ErrorResponse, useApiCall } from "@utils/api";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { useEventCallback } from "@/hooks/useEventCallback";
import {
  IDLE,
  LinkFlow,
  linkReducer,
  pollDelayMs,
} from "@/modules/agent-network/subscriptionLink";

const errorOf = (err: unknown) => {
  const e = (err ?? {}) as Partial<ErrorResponse>;
  return { code: e.code, message: e.message };
};

const linkPath = (providerId: string) =>
  `/agent-network/providers/${providerId}/link`;

/**
 * Runs the caller's device-code login for one user_oauth provider: start()
 * asks the server for a code, then the flow is polled every interval_seconds
 * until it is linked, expired or failed. Polling stops on a terminal state, on
 * cancel(), and when the component using the hook unmounts. onLinked runs once per
 * successful link, so the caller can refresh what shows the link state.
 */
export function useProviderLink(
  providerId: string,
  { onLinked }: { onLinked?: () => void } = {},
) {
  const [state, dispatch] = useReducer(linkReducer, IDLE);
  // Errors are shown in the dialog, which knows what each one means here,
  // instead of the generic request-failed toast.
  const api = useApiCall<LinkFlow>(linkPath(providerId), true);
  const requestStart = useEventCallback(() => api.post({}));
  const requestFlow = useEventCallback((id: string) => api.get(`/${id}`));
  const notifyLinked = useEventCallback(() => onLinked?.());

  // Each start() owns one attempt. An answer for an older attempt, or one
  // arriving after unmount, is dropped rather than overwriting the current one.
  const attempt = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(() => {
    const current = ++attempt.current;
    const live = () => mounted.current && attempt.current === current;
    dispatch({ type: "start" });
    requestStart()
      .then(
        (flow) => live() && dispatch({ type: "flow", flow, at: Date.now() }),
      )
      .catch(
        (err) => live() && dispatch({ type: "start-error", ...errorOf(err) }),
      );
  }, [requestStart]);

  // The effect is the polling loop: every answer, "pending" again or a poll
  // that failed and is to be retried, is a new state object and schedules the
  // next request. Any other phase ends it.
  useEffect(() => {
    if (state.phase !== "pending") return;
    const current = attempt.current;
    let cancelled = false;
    const live = () =>
      !cancelled && mounted.current && attempt.current === current;
    const timer = setTimeout(() => {
      requestFlow(state.flow.id)
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
    dispatch({ type: "cancel" });
  }, []);

  return { state, start, cancel } as const;
}

/**
 * Forgets the caller's own login for a provider. Resolves true once the
 * server confirms; a failure is reported by the shared request-failed toast.
 */
export function useProviderUnlink(providerId: string) {
  const api = useApiCall<object>(linkPath(providerId));
  return useEventCallback(() =>
    api
      .del()
      .then(() => true)
      .catch(() => false),
  );
}
