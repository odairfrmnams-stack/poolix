import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

/*
  Small status marks. Tones map to meaning, not decoration: `accent` for brand and active
  state, `warning` for something the reader should weigh, `negative` for failure, and
  `neutral` for a plain label that should not compete with anything around it.
*/
const badge = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-poolix-full border font-medium",
  {
    variants: {
      tone: {
        neutral: "border-line bg-raised text-muted",
        accent: "border-accent/25 bg-accent-wash text-accent-text",
        warning: "border-warning/30 bg-warning/10 text-warning",
        negative: "border-negative/30 bg-negative/10 text-negative",
        outline: "border-line-strong bg-transparent text-muted",
      },
      size: {
        sm: "px-2 py-0.5 text-[11px]",
        md: "px-2.5 py-1 text-[12px]",
      },
    },
    defaultVariants: { tone: "neutral", size: "sm" },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badge> {
  children?: ReactNode;
}

export function Badge({ className, tone, size, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone, size }), className)} {...props} />;
}

export { badge as badgeVariants };
