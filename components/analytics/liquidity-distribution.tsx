import Link from "next/link";
import { formatUnits } from "viem";

import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";
import { formatTokenAmount } from "@/lib/format";
import type { PoolDiscoveryResult } from "@/services/pools/discovery";

const MAX_ROWS = 10;

/**
 * How the scanned pools' ETH liquidity is distributed. Bars are proportional to real
 * reserves — this is a snapshot, not a time series, because swap history is not
 * available on this deployment.
 */
export function LiquidityDistribution({ result }: { result: PoolDiscoveryResult }) {
  const native = poolixConfig.chain.nativeCurrency.symbol;
  const rows = result.pools.slice(0, MAX_ROWS).map((pool) => ({
    address: pool.address,
    symbol: pool.other.symbol,
    liquidity: BigInt(pool.wethReserve) * 2n,
  }));

  const largest = rows[0]?.liquidity ?? 0n;

  if (rows.length === 0 || largest === 0n) {
    return (
      <div className="rounded-poolix-lg border border-line bg-surface px-5 py-14 text-center">
        <p className="text-[14px] text-fg">{copy.empty.pools.title}</p>
        <p className="mt-1.5 text-[12.5px] text-muted">{copy.empty.pools.message}</p>
      </div>
    );
  }

  return (
    <div className="rounded-poolix-lg border border-line bg-surface">
      <div className="flex items-baseline justify-between border-b border-line px-5 py-3.5">
        <h2 className="text-[14px] font-medium text-fg">{copy.analytics.topPools}</h2>
        <p className="text-[12px] text-subtle">by {native} liquidity</p>
      </div>

      <ol className="divide-y divide-line">
        {rows.map((row) => {
          // Integer maths first: these reserves overflow a float long before they overflow bigint.
          const width = Number((row.liquidity * 1000n) / largest) / 10;
          return (
            <li key={row.address}>
              <Link
                href={`/pools/${row.address}`}
                className="block px-5 py-3 transition-colors hover:bg-raised"
              >
                <div className="flex items-baseline justify-between gap-4 text-[13px]">
                  <span className="truncate text-fg">
                    {native} / {row.symbol}
                  </span>
                  <span className="poolix-numeric shrink-0 text-muted">
                    {formatTokenAmount(formatUnits(row.liquidity, 18), { maximumFractionDigits: 4 })} {native}
                  </span>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-line">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${Math.max(width, 0.6)}%` }}
                    aria-hidden="true"
                  />
                </div>
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
