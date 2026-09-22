import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

const button = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium " +
    "transition-[background-color,border-color,color,transform,opacity] duration-150 " +
    // A small scale on press rather than a translate: it reads as the control taking the
    // click, and it does not nudge neighbouring layout.
    "active:scale-[0.985] disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        /*
          Primary: black on the mint canvas — the darkest thing on the page. On a
          dark card, mint fill is redefined by the surface scope, so this stays
          black-bg-mint-text without a second variant. `text-mint-bright` names the
          fixed Aqua-Mint token that never re-scopes.
        */
        primary: "bg-ink text-mint-bright hover:bg-mint-bright hover:text-ink active:opacity-90",
        /** Swap CTA: mint-tinted button that reads as accent without going solid. */
        accentSoft:
          "border border-accent/40 bg-accent-wash text-accent-text hover:border-accent/60 hover:bg-accent/15",
        /*
          Secondary: transparent with a black outline on the mint canvas. Inside a
          dark card the outline goes light via the scoped `border-line-strong` and
          the fill inverts on hover, so one class serves both surfaces.
        */
        secondary:
          "border border-line-strong bg-transparent text-fg hover:bg-ink hover:text-mint-bright",
        ghost: "text-muted hover:text-fg hover:bg-raised",
        outline: "border border-line-strong text-fg hover:bg-raised",
        danger: "bg-negative/10 text-negative border border-negative/30 hover:bg-negative/15",
      },
      size: {
        sm: "h-8 px-3 text-[13px] rounded-poolix-sm",
        md: "h-10 px-4 text-sm rounded-poolix",
        lg: "h-12 px-6 text-[15px] rounded-poolix",
        xl: "h-[52px] px-6 text-base rounded-poolix-lg",
        icon: "size-9 rounded-poolix",
        pill: "h-9 px-3.5 text-[13px] rounded-poolix-full",
      },
      full: { true: "w-full", false: "" },
    },
    defaultVariants: { variant: "primary", size: "md", full: false },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  children?: ReactNode;
}

export function Button({ className, variant, size, full, ...props }: ButtonProps) {
  return <button className={cn(button({ variant, size, full }), className)} {...props} />;
}

export { button as buttonVariants };
