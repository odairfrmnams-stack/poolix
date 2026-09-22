"use client";

import { Info } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState } from "react";

/** A short explanation attached to a label. Opens on hover and on keyboard focus. */
export function InfoTip({ label, body }: { label: string; body: string }) {
  const [open, setOpen] = useState(false);
  const tipId = useId();

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label={`About ${label}`}
        aria-describedby={open ? tipId : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((value) => !value)}
        className="text-subtle transition-colors hover:text-muted"
      >
        <Info className="size-3.5" aria-hidden="true" />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.span
            id={tipId}
            role="tooltip"
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 3 }}
            transition={{ duration: 0.12 }}
            className="absolute bottom-[calc(100%+7px)] left-1/2 z-50 w-56 -translate-x-1/2 rounded-poolix border border-line bg-raised px-3 py-2 text-[12px] leading-relaxed text-muted shadow-xl shadow-black/40"
          >
            {body}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </span>
  );
}
