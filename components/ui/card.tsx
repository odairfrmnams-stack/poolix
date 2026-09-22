import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

/*
  The panel every surface is built from.

  Three tones rather than one: `plain` for content that sits on the canvas, `raised` for
  a control that needs to read as interactive, and `inset` for a field nested inside
  another card — the sell and buy rows of the swap form are inset inside the swap card.
  Radius grows with the tone so nothing inside a card is rounder than the card itself.
*/
const card = cva("border transition-colors", {
  variants: {
    tone: {
      plain: "border-line bg-surface",
      raised: "border-line bg-raised",
      inset: "border-transparent bg-raised",
      outline: "border-line bg-transparent",
    },
    radius: {
      md: "rounded-poolix",
      lg: "rounded-poolix-lg",
      xl: "rounded-poolix-xl",
    },
    padding: {
      none: "",
      sm: "p-3",
      md: "p-4",
      lg: "p-5",
    },
    interactive: {
      true: "hover:border-line-strong hover:bg-hover",
      false: "",
    },
  },
  defaultVariants: { tone: "plain", radius: "lg", padding: "md", interactive: false },
});

export interface CardProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof card> {
  children?: ReactNode;
}

export function Card({ className, tone, radius, padding, interactive, ...props }: CardProps) {
  return <div className={cn(card({ tone, radius, padding, interactive }), className)} {...props} />;
}

/** Title row for a card. Keeps the label/action pairing consistent across surfaces. */
export function CardHeader({
  title,
  action,
  className,
}: {
  title: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-center justify-between gap-3", className)}>
      <h2 className="text-[14px] font-medium text-fg">{title}</h2>
      {action}
    </div>
  );
}

export { card as cardVariants };
