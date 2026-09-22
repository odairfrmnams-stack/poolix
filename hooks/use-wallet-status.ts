"use client";

import { useCallback } from "react";
import { useConnect, useConnection, useConnectors, useSwitchChain } from "wagmi";

import { useMounted } from "@/hooks/use-mounted";
import { poolixChain } from "@/lib/wagmi";
import type { Address } from "@/types/web3";

export interface WalletStatus {
  /** False until browser wallet state has been read, so SSR markup stays stable. */
  readonly mounted: boolean;
  readonly address: Address | undefined;
  readonly isConnected: boolean;
  readonly isConnecting: boolean;
  readonly wrongNetwork: boolean;
  readonly isSwitching: boolean;
  readonly hasWallet: boolean;
  readonly connect: () => void;
  readonly switchToPoolix: () => void;
}

/**
 * Wallet readiness in the terms an action button needs: can it act, and if not, what
 * is the single next step the user has to take.
 */
export function useWalletStatus(): WalletStatus {
  const mounted = useMounted();
  const connection = useConnection();
  const connectors = useConnectors();
  const { connect, isPending: isConnecting } = useConnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  const injectedConnectors = connectors.filter((connector) => connector.type !== "mock");

  const connectFirst = useCallback(() => {
    const [connector] = connectors.filter((item) => item.type !== "mock");
    if (connector) connect({ connector });
  }, [connectors, connect]);

  const switchToPoolix = useCallback(() => switchChain({ chainId: poolixChain.id }), [switchChain]);

  const isConnected = connection.status === "connected";

  return {
    mounted,
    address: isConnected ? connection.address : undefined,
    isConnected,
    isConnecting: isConnecting || connection.status === "connecting" || connection.status === "reconnecting",
    wrongNetwork: isConnected && connection.chainId !== poolixChain.id,
    isSwitching,
    hasWallet: injectedConnectors.length > 0,
    connect: connectFirst,
    switchToPoolix,
  };
}
