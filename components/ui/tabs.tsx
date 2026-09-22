"use client";

import { motion, useReducedMotion } from "motion/react";
import { useId } from "react";

import { cn } from "@/lib/utils";

/*
  A segmented control for switching between views of the same thing.

  The active pill slides between options with a shared layoutId, which is the one piece
  of motion here that carries meaning: it shows which option you came from. It is dropped
  entirely under prefers-reduced-motion.
*/

export interface TabItem<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Optional count shown after the label, e.g. how many rows a tab holds. */
  readonly count?: number;
}

export interface TabsProps<T extends string> {
  readonly items: readonly TabItem<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly label: string;
  readonly className?: string;
}

export function Tabs<T extends string>({ items, value, onChange, label, className }: TabsProps<T>) {
  const reduceMotion = useReducedMotion();
  const layoutId = useId();

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1 rounded-poolix border border-line bg-surface p-1",
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={cn(
              "relative rounded-poolix-sm px-3 py-1.5 text-[13px] transition-colors",
              active ? "text-fg" : "text-muted hover:text-fg",
            )}
          >
            {active ? (
              <motion.span
                layoutId={reduceMotion ? undefined : layoutId}
                className="absolute inset-0 rounded-poolix-sm bg-raised"
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              />
            ) : null}
            <span className="relative flex items-center gap-1.5">
              {item.label}
              {item.count !== undefined ? (
                <span className={cn("text-[11px]", active ? "text-subtle" : "text-subtle")}>
                  {item.count.toLocaleString("en-US")}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
