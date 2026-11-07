"use client";

import Badge from "@components/Badge";
import Button from "@components/Button";
import FullTooltip from "@components/FullTooltip";
import {
  AlertTriangleIcon,
  CheckIcon,
  CircleDashedIcon,
  LinkIcon,
  UnlinkIcon,
} from "lucide-react";
import React, { useState } from "react";
import { useDialog } from "@/contexts/DialogProvider";
import { usePermissions } from "@/contexts/PermissionsProvider";
import { AIProvider } from "@/modules/agent-network/data/mockData";
import ProviderLinkModal from "@/modules/agent-network/ProviderLinkModal";
import {
  linkStatusOf,
  planLabel,
  subscriptionName,
} from "@/modules/agent-network/subscriptionLink";
import {
  useProviderLink,
  useProviderUnlink,
  useRefreshLinkState,
} from "@/modules/agent-network/useProviderLink";

// ProviderLoginCell shows whether a ChatGPT-login provider has a login linked,
// and, for whoever may edit providers, the action that changes it. Providers
// that use an API key have no login, so their cell stays empty.
export default function ProviderLoginCell({
  provider,
}: Readonly<{ provider: AIProvider }>) {
  if (!provider.subscriptionLink) return null;
  return <ProviderLoginActions provider={provider} />;
}

function ProviderLoginActions({ provider }: { provider: AIProvider }) {
  const { confirm } = useDialog();
  const { permission } = usePermissions();
  const canUpdate = !!permission?.["agent_network.providers"]?.update;
  const refresh = useRefreshLinkState();
  const link = useProviderLink({ onLinked: refresh });
  const unlink = useProviderUnlink();
  const [open, setOpen] = useState(false);
  const name = subscriptionName(provider.providerId);
  const status = linkStatusOf(provider.subscriptionLink);
  const plan = planLabel(provider.subscriptionLink?.plan_type);

  const startLink = () => {
    link.start(provider.id);
    setOpen(true);
  };

  const closeLink = () => {
    setOpen(false);
    link.cancel();
  };

  const handleUnlink = async () => {
    const ok = await confirm({
      title: `Unlink the ${name} login?`,
      description: `Requests through '${provider.name}' are refused until someone links a ${name} login again.`,
      confirmText: "Unlink",
      cancelText: "Cancel",
      type: "danger",
    });
    if (!ok) return;
    if (await unlink(provider.id)) await refresh();
  };

  return (
    // The row opens the edit modal on click. React events bubble out of the
    // link dialog's portal too, so they stop here.
    <div
      className={"flex items-center gap-3"}
      onClick={(e) => e.stopPropagation()}
    >
      {status === "linked" && (
        <Badge variant={"green"} data-testid={"provider-login-linked"}>
          <CheckIcon size={12} />
          {plan ? `Linked · ${plan}` : "Linked"}
        </Badge>
      )}
      {status === "not_linked" && (
        <Badge variant={"gray"} data-testid={"provider-login-not-linked"}>
          <CircleDashedIcon size={12} />
          Not linked
        </Badge>
      )}
      {status === "needs_relink" && (
        <FullTooltip
          content={
            <span className={"text-xs"}>
              {name} refused to renew the login. Requests through this provider
              are refused until it is linked again.
            </span>
          }
        >
          <Badge variant={"yellow"} data-testid={"provider-login-needs-relink"}>
            <AlertTriangleIcon size={12} />
            Needs relink
          </Badge>
        </FullTooltip>
      )}

      {canUpdate && status === "linked" && (
        <Button variant={"secondary"} size={"xs"} onClick={handleUnlink}>
          <UnlinkIcon size={12} />
          Unlink
        </Button>
      )}
      {canUpdate && status !== "linked" && (
        <Button variant={"primary"} size={"xs"} onClick={startLink}>
          <LinkIcon size={12} />
          {status === "needs_relink" ? "Link again" : "Link"}
        </Button>
      )}

      <ProviderLinkModal
        open={open}
        onClose={closeLink}
        onRetry={() => link.start(provider.id)}
        state={link.state}
        catalogId={provider.providerId}
        planType={provider.subscriptionLink?.plan_type}
      />
    </div>
  );
}
