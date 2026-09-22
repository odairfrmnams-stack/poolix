"use client";

import { Search } from "lucide-react";
import type { InputHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

/*
  Text and search fields.

  Focus is drawn with a border and ring on the wrapper rather than the browser outline,
  so the whole field reads as focused rather than just the inner element — and the ring
  uses the accent so keyboard users get the same affordance as the primary action.
*/

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Rendered inside the field, before the text. */
  leading?: ReactNode;
  /** Rendered inside the field, after the text. */
  trailing?: ReactNode;
  wrapperClassName?: string;
}

export function Input({ className, leading, trailing, wrapperClassName, ...props }: InputProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-poolix border border-line bg-raised px-3",
        "transition-colors focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20",
        wrapperClassName,
      )}
    >
      {leading ? <span className="shrink-0 text-subtle">{leading}</span> : null}
      <input
        className={cn(
          "h-10 min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-subtle",
          // The wrapper already shows focus; a second outline inside it reads as a bug.
          "outline-none focus-visible:outline-none",
          className,
        )}
        {...props}
      />
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </div>
  );
}

/** A search field with the icon already in place. */
export function SearchInput({ className, ...props }: Omit<InputProps, "leading">) {
  return (
    <Input
      type="search"
      leading={<Search className="size-4" aria-hidden />}
      className={cn("[&::-webkit-search-cancel-button]:appearance-none", className)}
      {...props}
    />
  );
}
