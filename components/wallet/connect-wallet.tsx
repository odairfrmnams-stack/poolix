"use client";

import { Check, ChevronDown, Copy, ExternalLink, LayoutDashboard, LogOut, Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";

import { Dropdown, DropdownItem, DropdownLink, DropdownSeparator } from "@/components/ui/dropdown";
import { Button } from "@/components/ui/button";
import { poolixConfig } from "@/config/poolix";
import { useMounted } from "@/hooks/use-mounted";
import { copy } from "@/lib/copy";
import { classifyError } from "@/lib/errors";
import { explorerUrl, truncateAddress } from "@/lib/format";
import { poolixChain } from "@/lib/wagmi";

const TRIGGER =
  "inline-flex h-9 items-center gap-2 rounded-poolix-full border border-line bg-raised px-3.5 " +
  "text-[13px] font-medium text-fg transition-colors hover:border-line-strong hover:bg-hover";

export function ConnectWallet() {
  const mounted = useMounted();
  const connection = useConnection();
  const connectors = useConnectors();
  const { connect, isPending: isConnecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  // Reserve the slot until wallet storage has been read, so the header does not shift.
  if (!mounted) {
    return <div className="h-9 w-[132px] rounded-poolix border border-line bg-raised/40" aria-hidden="true" />;
  }

  if (connection.status === "reconnecting" || connection.status === "connecting" || isConnecting) {
    return (
      <Button size="sm" variant="secondary" disabled>
        {copy.loading.generic}
      </Button>
    );
  }

  if (connection.status === "connected") {
    return connection.chainId === poolixChain.id ? (
      <ConnectedMenu address={connection.address} onDisconnect={() => disconnect()} />
    ) : (
      <Button
        size="sm"
        variant="secondary"
        disabled={isSwitching}
        onClick={() => switchChain({ chainId: poolixChain.id })}
        className="border-warning/40 text-warning hover:border-warning/60"
      >
        {isSwitching ? copy.loading.generic : copy.wallet.switchNetwork}
      </Button>
    );
  }

  const available = connectors.filter((connector) => connector.type !== "mock");

  if (available.length === 0) {
    return (
      <Button size="sm" variant="secondary" disabled title="No browser wallet detected on this device.">
        {copy.wallet.unavailable}
      </Button>
    );
  }

  // A single wallet connects directly; several are worth choosing between.
  if (available.length === 1 && available[0]) {
    const only = available[0];
    return (
      <div className="flex flex-col items-end gap-1">
        {/* Tinted rather than solid: the page's own call to action is the solid green,
            and two of them competing in one viewport reads as neon rather than emphasis. */}
        <Button size="pill" variant="accentSoft" onClick={() => connect({ connector: only })}>
          <Wallet className="size-4" aria-hidden="true" />
          {copy.wallet.connect}
        </Button>
        <ConnectError error={connectError} />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Dropdown
        triggerClassName={TRIGGER}
        trigger={
          <>
            <Wallet className="size-4" aria-hidden="true" />
            {copy.wallet.connect}
            <ChevronDown className="size-3.5 text-subtle" aria-hidden="true" />
          </>
        }
      >
        {available.map((connector) => (
          <DropdownItem key={connector.uid} onSelect={() => connect({ connector })}>
            {connector.name}
          </DropdownItem>
        ))}
      </Dropdown>
      <ConnectError error={connectError} />
    </div>
  );
}

function ConnectError({ error }: { error: unknown }) {
  if (!error) return null;
  const poolixError = classifyError(error);
  return (
    <p className="max-w-[220px] text-right text-[11px] leading-tight text-negative">{poolixError.message}</p>
  );
}

function ConnectedMenu({ address, onDisconnect }: { address: `0x${string}`; onDisconnect: () => void }) {
  const [copied, setCopied] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <Dropdown
      triggerClassName={TRIGGER}
      triggerLabel={copy.wallet.connected}
      trigger={
        <>
          <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
          <span className="poolix-numeric">{truncateAddress(address)}</span>
          <ChevronDown className="size-3.5 text-subtle" aria-hidden="true" />
        </>
      }
    >
      <div className="px-2.5 pt-1.5 pb-2">
        <p className="text-[11px] tracking-wide text-subtle uppercase">{copy.wallet.connected}</p>
        <p className="poolix-numeric mt-1 text-[12px] break-all text-muted">{address}</p>
      </div>
      <DropdownSeparator />
      <DropdownItem onSelect={() => router.push("/dashboard")}>
        <LayoutDashboard className="size-3.5" aria-hidden="true" />
        {copy.nav.dashboard}
      </DropdownItem>
      <DropdownSeparator />
      {/* Stays open so the confirmation is visible. */}
      <DropdownItem
        closeOnSelect={false}
        onSelect={() => {
          void navigator.clipboard?.writeText(address).then(() => setCopied(true));
        }}
      >
        {copied ? (
          <Check className="size-3.5 text-accent-text" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
        {copied ? copy.wallet.addressCopied : copy.wallet.copyAddress}
      </DropdownItem>
      <DropdownLink href={explorerUrl(poolixConfig.explorerUrl, "address", address)}>
        <ExternalLink className="size-3.5" aria-hidden="true" />
        {copy.wallet.viewOnExplorer}
      </DropdownLink>
      <DropdownSeparator />
      <DropdownItem destructive onSelect={onDisconnect}>
        <LogOut className="size-3.5" aria-hidden="true" />
        {copy.wallet.disconnect}
      </DropdownItem>
    </Dropdown>
  );
}
