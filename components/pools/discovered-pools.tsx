import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { formatUnits } from "viem";

import { PairBadge } from "@/components/pools/pair-badge";
import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";
import { formatTokenAmount, truncateAddress } from "@/lib/format";
import type { PoolDiscoveryResult } from "@/services/pools/discovery";
import { poolValueInQuote } from "@/services/pools/pricing";

/**
 * Pools found by the bounded factory scan, ranked by the ETH they hold. Columns that
 * need historical data or a price feed show `--`; the page explains why.
 */
export function DiscoveredPools({ result }: { result: PoolDiscoveryResult }) {
  if (result.pools.length === 0) {
    return (
      <div className="rounded-poolix-lg border border-line bg-surface px-5 py-14 text-center">
        <p className="text-[14px] text-fg">{copy.empty.pools.title}</p>
        <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-muted">
          {result.totalPairs === 0
            ? "The scan could not reach the chain, most likely because the public endpoint is throttling. It retries shortly; the finder above works either way."
            : "The scanned window contained no pools with liquidity on both sides."}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-poolix-lg border border-line">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line bg-surface text-left">
            <Th className="w-[38%]">Pool</Th>
            <Th align="right">Liquidity (ETH)</Th>
            <Th align="right" className="hidden sm:table-cell">
              Token Reserve
            </Th>
            <Th align="right" className="hidden md:table-cell">
              {copy.poolData.tvl}
            </Th>
            <Th align="right" className="hidden md:table-cell">
              {copy.poolData.volume24h}
            </Th>
            <Th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {result.pools.map((pool) => (
            <tr key={pool.address} className="border-b border-line bg-surface last:border-0 hover:bg-raised">
              <td className="px-4 py-3">
                <Link href={`/pools/${pool.address}`} className="flex flex-col gap-0.5">
                  <PairBadge
                    symbol0="WETH"
                    symbol1={pool.other.symbol}
                    address0={poolixConfig.contracts.weth}
                    address1={pool.other.address}
                  />
                  <span className="poolix-numeric pl-[46px] text-[11.5px] text-subtle">
                    {truncateAddress(pool.address)}
                  </span>
                </Link>
              </td>
              {/* Both sides of a balanced pool, so twice the ETH reserve. */}
              <td className="poolix-numeric px-4 py-3 text-right text-fg">
                {formatTokenAmount(formatUnits(poolValueInQuote(BigInt(pool.wethReserve)), 18), {
                  maximumFractionDigits: 4,
                })}
              </td>
              <td className="poolix-numeric hidden px-4 py-3 text-right text-muted sm:table-cell">
                {formatTokenAmount(formatUnits(BigInt(pool.otherReserve), pool.other.decimals), {
                  maximumFractionDigits: 2,
                })}
              </td>
              <td className="poolix-numeric hidden px-4 py-3 text-right text-subtle md:table-cell">
                {copy.data.unavailable}
              </td>
              <td className="poolix-numeric hidden px-4 py-3 text-right text-subtle md:table-cell">
                {copy.data.unavailable}
              </td>
              <td className="px-4 py-3 text-right">
                <Link href={`/pools/${pool.address}`} aria-label={`Open WETH / ${pool.other.symbol} pool`}>
                  <ChevronRight className="ml-auto size-4 text-subtle" aria-hidden="true" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({
  children,
  align = "left",
  className,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-4 py-3 text-[11.5px] font-medium tracking-wide text-subtle uppercase ${
        align === "right" ? "text-right" : "text-left"
      } ${className ?? ""}`}
    >
      {children}
    </th>
  );
}
