"use client";

import Button from "@components/Button";
import { Callout } from "@components/Callout";
import Code from "@components/Code";
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
import React from "react";
import AIProviderLogo from "@/modules/agent-network/AIProviderLogo";
import { AIProviderId } from "@/modules/agent-network/data/mockData";
import {
  LinkFlow,
  LinkState,
  minutesLeft,
  planLabel,
  subscriptionName,
} from "@/modules/agent-network/subscriptionLink";

type Props = {
  open: boolean;
  onClose: () => void;
  onRetry: () => void;
  state: LinkState;
  catalogId: string;
  // Plan the server reported once the link landed, read from agent-config.
  planType?: string;
};

// ProviderLinkModal walks the caller through a device-code login: open the
// vendor page, type the code, approve. The flow itself lives in
// useProviderLink; this only renders the phase it is in.
export default function ProviderLinkModal({
  open,
  onClose,
  onRetry,
  state,
  catalogId,
  planType,
}: Readonly<Props>) {
  const name = subscriptionName(catalogId);
  const done = state.phase === "linked";

  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()}>
      <ModalContent
        maxWidthClass={"max-w-lg"}
        data-testid={"agent-network-provider-link-modal"}
      >
        <ModalHeader
          icon={
            <AIProviderLogo providerId={catalogId as AIProviderId} size={18} />
          }
          title={`Link your ${name} subscription`}
          description={`Requests you send through NetBird to this provider will run on your own ${name} plan.`}
          color={"netbird"}
        />

        <div className={"px-8 pb-6"}>
          <LinkBody
            state={state}
            name={name}
            planType={planType}
            onRetry={onRetry}
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

function LinkBody({
  state,
  name,
  planType,
  onRetry,
}: {
  state: LinkState;
  name: string;
  planType?: string;
  onRetry: () => void;
}) {
  switch (state.phase) {
    case "idle":
    case "starting":
      return (
        <Paragraph className={"text-sm flex items-center gap-2"}>
          <Loader2 size={14} className={"animate-spin"} />
          Requesting a sign-in code…
        </Paragraph>
      );
    case "pending":
      return (
        <PendingSteps
          flow={state.flow}
          checkedAt={state.checkedAt}
          name={name}
        />
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
          Your {name} {plan ? `${plan} ` : ""}subscription is linked. Requests
          you send through NetBird to this provider now use it.
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
      return <Retry onRetry={onRetry}>{state.message}</Retry>;
  }
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
