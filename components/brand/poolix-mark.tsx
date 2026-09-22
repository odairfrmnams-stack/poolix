/**
 * Two overlapping circles: a pair of assets, with the shared area — the pool —
 * picked out in the accent. Strokes inherit currentColor.
 */
export function PoolixMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="9" cy="12" r="6.25" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
      <circle cx="15" cy="12" r="6.25" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
      <path
        d="M12 6.517A6.25 6.25 0 0 1 12 17.483 6.25 6.25 0 0 1 12 6.517Z"
        fill="var(--poolix-accent)"
      />
    </svg>
  );
}

export function PoolixWordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      <span className="sr-only">Poolix</span>
      <span aria-hidden="true">POOLIX</span>
    </span>
  );
}
