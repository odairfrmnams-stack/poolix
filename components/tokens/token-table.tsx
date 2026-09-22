import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { formatUnits } from "viem";

import { TokenIcon } from "@/components/token/token-icon";
import { poolixConfig } from "@/config/poolix";
import { copy } from "@/lib/copy";
import { formatPrice, formatTokenAmount, truncateAddress } from "@/lib/format";
import type { TokenListing } from "@/services/tokens/listing";

export function TokenTable({ tokens }: { tokens: readonly TokenListing[] }) {
  const native = poolixConfig.chain.nativeCurrency.symbol;

  if (tokens.length === 0) {
    return (
      <div className="rounded-poolix-lg border border-line bg-surface px-5 py-14 text-center">
        <p className="text-[14px] text-fg">{copy.empty.tokens.title}</p>
        <p className="mx-auto mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-muted">
          {copy.empty.tokens.message}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-poolix-lg border border-line">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line bg-surface">
            <Th className="w-[34%]">{copy.tokens.token}</Th>
            <Th align="right">Price ({native})</Th>
            <Th align="right">{copy.tokens.liquidity}</Th>
            <Th align="right" className="hidden sm:table-cell">
              {copy.tokens.pools}
            </Th>
            <Th align="right" className="hidden md:table-cell">
              {copy.tokens.volume}
            </Th>
            <Th align="right" className="hidden lg:table-cell">
              {copy.tokens.holders}
            </Th>
            <Th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {tokens.map((token) => (
            <tr key={token.address} className="border-b border-line bg-surface last:border-0 hover:bg-raised">
              <td className="px-4 py-3">
                <Link href={`/token/${token.address}`} className="flex items-center gap-3">
                  <TokenIcon address={token.address} symbol={token.symbol} size={28} />
                  <span className="min-w-0">
                    <span className="block truncate text-fg">{token.symbol}</span>
                    <span className="poolix-numeric block text-[11.5px] text-subtle">
                      {truncateAddress(token.address)}
                    </span>
                  </span>
                </Link>
              </td>
              <td className="poolix-numeric px-4 py-3 text-right text-fg">{formatPrice(token.priceEth)}</td>
              <td className="poolix-numeric px-4 py-3 text-right text-fg">
                {formatTokenAmount(formatUnits(token.ethLiquidity, 18), { maximumFractionDigits: 4 })} {native}
              </td>
              <td className="poolix-numeric hidden px-4 py-3 text-right text-muted sm:table-cell">
                {token.poolCount}
              </td>
              <td className="poolix-numeric hidden px-4 py-3 text-right text-subtle md:table-cell">
                {copy.data.unavailable}
              </td>
              <td className="poolix-numeric hidden px-4 py-3 text-right text-subtle lg:table-cell">
                {copy.data.unavailable}
              </td>
              <td className="px-4 py-3 text-right">
                <Link href={`/token/${token.address}`} aria-label={`Open ${token.symbol}`}>
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
