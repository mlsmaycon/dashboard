"use client";

import Badge from "@components/Badge";
import Button from "@components/Button";
import FullTooltip from "@components/FullTooltip";
import {
  AlertTriangleIcon,
  CheckIcon,
  LinkIcon,
  UnlinkIcon,
} from "lucide-react";
import React, { useState } from "react";
import { useDialog } from "@/contexts/DialogProvider";
import ProviderLinkModal from "@/modules/agent-network/ProviderLinkModal";
import {
  linkStatusOf,
  planLabel,
  subscriptionName,
  usesUserOAuth,
} from "@/modules/agent-network/subscriptionLink";
import {
  APIMeProvider,
  useRefreshAgentConfig,
} from "@/modules/agent-network/useMyAgentNetworkSetup";
import {
  useProviderLink,
  useProviderUnlink,
} from "@/modules/agent-network/useProviderLink";

// ConnectSubscriptionCell shows whether the caller has linked their own
// subscription for a user_oauth provider, and the action that changes it.
// Providers backed by an operator key need nothing from the caller, so their
// cell stays empty.
export default function ConnectSubscriptionCell({
  provider,
}: Readonly<{ provider: APIMeProvider }>) {
  if (!usesUserOAuth(provider) || !provider.id) return null;
  return <SubscriptionLinkActions provider={provider} id={provider.id} />;
}

function SubscriptionLinkActions({
  provider,
  id,
}: {
  provider: APIMeProvider;
  id: string;
}) {
  const { confirm } = useDialog();
  const refresh = useRefreshAgentConfig();
  const link = useProviderLink(id, { onLinked: refresh });
  const unlink = useProviderUnlink(id);
  const [open, setOpen] = useState(false);
  const name = subscriptionName(provider.catalog_id);
  const status = linkStatusOf(provider);
  const plan = planLabel(provider.subscription_link?.plan_type);

  const startLink = () => {
    link.start();
    setOpen(true);
  };

  const closeLink = () => {
    setOpen(false);
    link.cancel();
  };

  const handleUnlink = async () => {
    const ok = await confirm({
      title: `Unlink your ${name} subscription?`,
      description: `Requests you send through '${provider.name}' are refused until you link a subscription again.`,
      confirmText: "Unlink",
      cancelText: "Cancel",
      type: "danger",
    });
    if (!ok) return;
    if (await unlink()) await refresh();
  };

  return (
    <div className={"flex items-center gap-3"}>
      {status === "linked" && (
        <>
          <Badge variant={"green"} data-testid={"subscription-linked"}>
            <CheckIcon size={12} />
            {plan ? `Linked · ${plan}` : "Linked"}
          </Badge>
          <Button variant={"secondary"} size={"xs"} onClick={handleUnlink}>
            <UnlinkIcon size={12} />
            Unlink
          </Button>
        </>
      )}

      {status === "needs_relink" && (
        <>
          <FullTooltip
            content={
              <span className={"text-xs"}>
                {name} refused to renew your login. Link it again to keep using
                this provider.
              </span>
            }
          >
            <Badge variant={"yellow"} data-testid={"subscription-needs-relink"}>
              <AlertTriangleIcon size={12} />
              Needs relink
            </Badge>
          </FullTooltip>
          <Button variant={"primary"} size={"xs"} onClick={startLink}>
            <LinkIcon size={12} />
            Link again
          </Button>
        </>
      )}

      {status === "not_linked" && (
        <Button variant={"primary"} size={"xs"} onClick={startLink}>
          <LinkIcon size={12} />
          Link {name}
        </Button>
      )}

      <ProviderLinkModal
        open={open}
        onClose={closeLink}
        onRetry={link.start}
        state={link.state}
        catalogId={provider.catalog_id}
        planType={provider.subscription_link?.plan_type}
      />
    </div>
  );
}
