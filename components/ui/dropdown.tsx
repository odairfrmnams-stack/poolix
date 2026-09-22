"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

const DropdownContext = createContext<{ close: () => void } | null>(null);

/** Items close the menu themselves, so callers never thread a close callback through. */
function useDropdownClose(): () => void {
  return useContext(DropdownContext)?.close ?? (() => {});
}

interface DropdownProps {
  /** Rendered inside the trigger button. */
  trigger: ReactNode;
  triggerClassName?: string;
  triggerLabel?: string;
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}

/**
 * A small menu popover. Closes on outside pointer-down, on Escape, and returns
 * focus to the trigger so keyboard users are not dropped at the top of the page.
 */
export function Dropdown({
  trigger,
  triggerClassName,
  triggerLabel,
  align = "end",
  className,
  children,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const reduceMotion = useReducedMotion();

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const contextValue = useMemo(() => ({ close }), [close]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={triggerLabel}
        onClick={() => setOpen((value) => !value)}
        className={triggerClassName}
      >
        {trigger}
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            id={menuId}
            role="menu"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "absolute top-[calc(100%+6px)] z-50 min-w-[200px] overflow-hidden rounded-poolix",
              "border border-line bg-raised p-1 shadow-xl shadow-black/40",
              align === "end" ? "right-0" : "left-0",
              className,
            )}
          >
            <DropdownContext value={contextValue}>{children}</DropdownContext>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function DropdownItem({
  onSelect,
  children,
  destructive = false,
  closeOnSelect = true,
}: {
  onSelect: () => void;
  children: ReactNode;
  destructive?: boolean;
  closeOnSelect?: boolean;
}) {
  const close = useDropdownClose();

  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onSelect();
        if (closeOnSelect) close();
      }}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-left text-[13px] transition-colors",
        destructive ? "text-negative hover:bg-negative/10" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

export function DropdownLink({ href, children }: { href: string; children: ReactNode }) {
  const close = useDropdownClose();

  return (
    <a
      role="menuitem"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={close}
      className="flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-left text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
    >
      {children}
    </a>
  );
}

export function DropdownSeparator() {
  return <div className="my-1 h-px bg-line" role="separator" />;
}
