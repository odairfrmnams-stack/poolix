import { TokenIcon } from "@/components/token/token-icon";
import { cn } from "@/lib/utils";

/*
  Shared label for a pair of tokens. Callers pass symbols for display; addresses are
  optional but strongly recommended, because they are what makes each icon a stable
  identicon rather than a shared letter chip. Pool tables always know both.
*/
export function PairBadge({
  symbol0,
  symbol1,
  address0,
  address1,
  className,
}: {
  symbol0: string;
  symbol1: string;
  address0?: string | null;
  address1?: string | null;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <span className="flex -space-x-2">
        <TokenIcon symbol={symbol0} address={address0 ?? null} size={24} />
        <TokenIcon
          symbol={symbol1}
          address={address1 ?? null}
          size={24}
          className="ring-1 ring-canvas/60"
        />
      </span>
      <span className="truncate text-fg">
        {symbol0} / {symbol1}
      </span>
    </span>
  );
}
