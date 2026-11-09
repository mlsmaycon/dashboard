"use client";

import Button from "@components/Button";
import { Callout } from "@components/Callout";
import Code from "@components/Code";
import { Input } from "@components/Input";
import {
  Modal,
  ModalClose,
  ModalContent,
  ModalFooter,
} from "@components/modal/Modal";
import ModalHeader from "@components/modal/ModalHeader";
import Paragraph from "@components/Paragraph";
import Steps from "@components/Steps";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  Loader2,
  RefreshCwIcon,
} from "lucide-react";
import Link from "next/link";
import React, { useState } from "react";
import AIProviderLogo from "@/modules/agent-network/AIProviderLogo";
import { AIProviderId } from "@/modules/agent-network/data/mockData";
import {
  authorizationCodeInstructions,
  canUseBrowserLogin,
  LinkFlow,
  LinkFlowKind,
  LinkState,
  minutesLeft,
  planLabel,
  subscriptionName,
} from "@/modules/agent-network/subscriptionLink";
import type { CatalogSubscriptionLogin } from "@/modules/agent-network/useProviderCatalog";

type Props = {
  open: boolean;
  onClose: () => void;
  onRetry: () => void;
  onComplete: (code: string) => void;
  state: LinkState;
  catalogId: string;
  // Plan the server reported once the link landed, read from the provider.
  planType?: string;
  subscriptionLogin?: CatalogSubscriptionLogin;
  requestedFlow?: LinkFlowKind;
  onUseBrowser?: () => void;
};

// ProviderLinkModal links a subscription login to an existing provider, for
// the providers table. The provider modal shows the same header and body as
// the step after creating one.
export default function ProviderLinkModal({
  open,
  onClose,
  onRetry,
  onComplete,
  state,
  catalogId,
  planType,
  subscriptionLogin,
  requestedFlow,
  onUseBrowser,
}: Readonly<Props>) {
  const done = state.phase === "linked";

  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()}>
      <ModalContent
        maxWidthClass={"max-w-lg"}
        data-testid={"agent-network-provider-link-modal"}
      >
        <ProviderLinkHeader catalogId={catalogId} />

        <div className={"px-8 pb-6"}>
          <ProviderLinkBody
            state={state}
            catalogId={catalogId}
            planType={planType}
            onRetry={onRetry}
            onComplete={onComplete}
            subscriptionLogin={subscriptionLogin}
            requestedFlow={requestedFlow}
            onUseBrowser={onUseBrowser}
          />
        </div>

        <ModalFooter className={"items-center"}>
          <div className={"flex gap-3 w-full justify-end"}>
            <ModalClose asChild>
              <Button variant={done ? "primary" : "secondary"}>
                {done ? "Done" : "Cancel"}
              </Button>
            </ModalClose>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

export function ProviderLinkHeader({ catalogId }: { catalogId: string }) {
  const name = subscriptionName(catalogId);
  return (
    <ModalHeader
      icon={<AIProviderLogo providerId={catalogId as AIProviderId} size={18} />}
      title={`Link a ${name} login`}
      description={`Sign in with the ${name} account whose plan this provider should use.`}
      color={"netbird"}
    />
  );
}

// ProviderLinkBody walks the operator through the vendor's sign-in. The flow lives in
// useProviderLink; this only renders the phase it is in.
export function ProviderLinkBody({
  state,
  catalogId,
  planType,
  onRetry,
  onComplete,
  subscriptionLogin,
  requestedFlow,
  onUseBrowser,
}: {
  state: LinkState;
  catalogId: string;
  planType?: string;
  onRetry: () => void;
  onComplete: (code: string) => void;
  subscriptionLogin?: CatalogSubscriptionLogin;
  requestedFlow?: LinkFlowKind;
  onUseBrowser?: () => void;
}) {
  const name = subscriptionName(catalogId);
  const browserAlternative =
    onUseBrowser &&
    canUseBrowserLogin(subscriptionLogin, state, requestedFlow) ? (
      <div className={"mt-4 flex"}>
        <Button
          variant={"secondary"}
          size={"sm"}
          onClick={onUseBrowser}
          data-testid={"agent-network-provider-use-browser"}
        >
          <ExternalLinkIcon size={14} />
          Use browser sign-in
        </Button>
      </div>
    ) : null;
  switch (state.phase) {
    case "idle":
    case "starting":
      return (
        <Paragraph className={"text-sm flex items-center gap-2"}>
          <Loader2 size={14} className={"animate-spin"} />
          Starting sign-in…
        </Paragraph>
      );
    case "pending":
    case "completing":
      if (state.flow.flow === "authorization_code") {
        return (
          <AuthorizationCodeSteps
            key={state.flow.id}
            flow={state.flow}
            checkedAt={state.checkedAt}
            name={name}
            catalogId={catalogId}
            completing={state.phase === "completing"}
            error={
              state.phase === "pending" ? state.completionError : undefined
            }
            onComplete={onComplete}
          />
        );
      }
      return (
        <>
          <PendingSteps
            flow={state.flow}
            checkedAt={state.checkedAt}
            name={name}
          />
          {browserAlternative}
        </>
      );
    case "linked": {
      const plan = planLabel(planType);
      return (
        <Callout
          variant={"success"}
          icon={
            <CheckCircle2Icon
              size={14}
              className={"shrink-0 relative top-[3px]"}
            />
          }
        >
          The {name} {plan ? `${plan} ` : ""}plan is linked. Every request this
          provider&apos;s policies allow now uses it.
        </Callout>
      );
    }
    case "expired":
      return (
        <Retry onRetry={onRetry}>
          The code expired before the login was approved.
        </Retry>
      );
    case "failed":
      return (
        <Retry onRetry={onRetry}>
          {state.message ?? `${name} did not approve the login.`}
        </Retry>
      );
    case "unavailable":
      return (
        <>
          <Retry onRetry={onRetry}>{state.message}</Retry>
          {browserAlternative}
        </>
      );
  }
}

function AuthorizationCodeSteps({
  flow,
  checkedAt,
  name,
  catalogId,
  completing,
  error,
  onComplete,
}: {
  flow: LinkFlow;
  checkedAt: number;
  name: string;
  catalogId: string;
  completing: boolean;
  error?: string;
  onComplete: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const instructions = authorizationCodeInstructions(catalogId);
  const uri = flow.authorization_uri;
  const minutes = minutesLeft(flow.expires_at, checkedAt);
  if (!uri)
    return (
      <Callout variant={"warning"}>
        The sign-in page is unavailable. Close this dialog and start a new
        login.
      </Callout>
    );

  return (
    <Steps className={"pt-0"}>
      <Steps.Step step={1}>
        <p>Open the {name} sign-in page</p>
        <div className={"flex"}>
          <Link
            href={uri}
            target={"_blank"}
            rel={"noopener noreferrer"}
            data-testid={"agent-network-provider-authorization-link"}
          >
            <Button variant={"secondary"} size={"sm"}>
              <ExternalLinkIcon size={14} />
              Open {hostOf(uri)}
            </Button>
          </Link>
        </div>
        <p className={"text-sm text-nb-gray-400 font-normal"}>
          Sign in and approve access to the plan this provider will share.
        </p>
      </Steps.Step>
      <Steps.Step step={2} line={false}>
        <label htmlFor={"provider-authorization-code"}>
          {instructions.label}
        </label>
        <form
          className={"flex flex-col gap-3"}
          onSubmit={(event) => {
            event.preventDefault();
            if (!code.trim() || completing) return;
            onComplete(code);
            setCode("");
          }}
        >
          <Input
            id={"provider-authorization-code"}
            data-testid={"agent-network-provider-authorization-code"}
            type={"password"}
            autoComplete={"off"}
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={completing}
            placeholder={instructions.placeholder}
          />
          {instructions.help && (
            <p className={"text-sm text-nb-gray-400 font-normal"}>
              {instructions.help}
            </p>
          )}
          <p className={"text-xs text-nb-gray-400 font-normal"}>
            {minutes > 0
              ? `This sign-in expires in ${minutes} ${
                  minutes === 1 ? "minute" : "minutes"
                }.`
              : "This sign-in is about to expire."}
          </p>
          {error && (
            <Callout variant={"warning"}>
              {instructions.completionError ?? error}
            </Callout>
          )}
          <div className={"flex"}>
            <Button
              type={"submit"}
              data-testid={"agent-network-provider-link-submit"}
              variant={"primary"}
              size={"sm"}
              disabled={completing || !code.trim()}
            >
              {completing && <Loader2 size={14} className={"animate-spin"} />}
              {completing ? "Linking…" : "Link login"}
            </Button>
          </div>
        </form>
      </Steps.Step>
    </Steps>
  );
}

function PendingSteps({
  flow,
  checkedAt,
  name,
}: {
  flow: LinkFlow;
  checkedAt: number;
  name: string;
}) {
  // Every poll answer moves checkedAt, so the count stays current without a
  // timer of its own.
  const minutes = minutesLeft(flow.expires_at, checkedAt);
  const host = hostOf(flow.verification_uri);

  return (
    <Steps className={"pt-0"}>
      <Steps.Step step={1}>
        <p>Open the {name} sign-in page</p>
        <div className={"flex"}>
          <Link
            href={flow.verification_uri}
            passHref
            target={"_blank"}
            rel={"noopener noreferrer"}
          >
            <Button variant={"secondary"} size={"sm"}>
              <ExternalLinkIcon size={14} />
              Open {host}
            </Button>
          </Link>
        </div>
      </Steps.Step>
      <Steps.Step step={2}>
        <p>Enter this code</p>
        <Code message={"Code copied to clipboard"}>
          <span
            className={"font-mono text-2xl tracking-[0.2em]"}
            data-testid={"agent-network-provider-link-code"}
          >
            {flow.user_code}
          </span>
        </Code>
        <p className={"text-xs text-nb-gray-400 font-normal"}>
          {minutes > 0
            ? `The code expires in ${minutes} ${
                minutes === 1 ? "minute" : "minutes"
              }.`
            : "The code is about to expire."}
        </p>
      </Steps.Step>
      <Steps.Step step={3} line={false}>
        <p>Approve the login</p>
        <p
          className={
            "text-sm text-nb-gray-400 font-normal flex items-center gap-2"
          }
        >
          <Loader2 size={14} className={"animate-spin shrink-0"} />
          Waiting for your approval. This dialog updates on its own.
        </p>
      </Steps.Step>
    </Steps>
  );
}

function Retry({
  children,
  onRetry,
}: {
  children: React.ReactNode;
  onRetry: () => void;
}) {
  return (
    <div className={"flex flex-col gap-4 items-start"}>
      <Callout
        variant={"warning"}
        icon={
          <AlertCircleIcon
            size={14}
            className={"shrink-0 relative top-[3px]"}
          />
        }
      >
        {children}
      </Callout>
      <Button variant={"primary"} size={"sm"} onClick={onRetry}>
        <RefreshCwIcon size={14} />
        Try again
      </Button>
    </div>
  );
}

const hostOf = (uri: string) => {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
};
