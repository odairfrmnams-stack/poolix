"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * False during SSR and the first client render, true afterwards. Wallet state comes
 * from browser storage, so gating on this keeps the server and client markup
 * identical without a setState-in-effect cascade.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
}
