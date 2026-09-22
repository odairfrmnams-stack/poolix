import { Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const TONES = {
  neutral: { border: "border-line", background: "bg-surface", accent: "text-subtle", Icon: Info },
  warning: { border: "border-warning/30", background: "bg-warning/5", accent: "text-warning", Icon: TriangleAlert },
} as const;

/**
 * Explains a limitation in place. Used wherever a value reads `--` so the gap is
 * accounted for rather than left as a mystery.
 */
export function Notice({
  title,
  tone = "neutral",
  children,
}: {
  title: string;
  tone?: keyof typeof TONES;
  children: ReactNode;
}) {
  const { border, background, accent, Icon } = TONES[tone];

  return (
    <div className={cn("flex gap-3 rounded-poolix-lg border px-4 py-3.5", border, background)}>
      <Icon className={cn("mt-px size-4 shrink-0", accent)} aria-hidden="true" />
      <div className="min-w-0">
        <p className={cn("text-[13px] font-medium", tone === "warning" ? accent : "text-fg")}>{title}</p>
        <div className="mt-1 text-[12.5px] leading-relaxed text-muted">{children}</div>
      </div>
    </div>
  );
}
