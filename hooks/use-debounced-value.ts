"use client";

import { useEffect, useState } from "react";

/**
 * Holds a value still for `delay` ms. Quotes cost an RPC round trip, so the amount
 * field is debounced rather than queried on every keystroke.
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
