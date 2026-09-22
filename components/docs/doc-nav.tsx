"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isActivePath } from "@/lib/navigation";
import { cn } from "@/lib/utils";

const sections = [
  {
    title: "Overview",
    items: [{ href: "/docs", label: "Introduction" }],
  },
  {
    title: "Reference",
    items: [
      { href: "/docs/contracts", label: "Contract Addresses" },
      { href: "/docs/integration", label: "Integration" },
    ],
  },
] as const;

export function DocNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Documentation" className="space-y-6">
      {sections.map((section) => (
        <div key={section.title}>
          <p className="text-[11px] font-medium tracking-wider text-subtle uppercase">{section.title}</p>
          <ul className="mt-2.5 space-y-0.5">
            {section.items.map((item) => {
              // Exact match for the index, so it does not stay lit on every subpage.
              const active = item.href === "/docs" ? pathname === "/docs" : isActivePath(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-poolix px-3 py-1.5 text-[13px] transition-colors",
                      active ? "bg-accent-wash text-accent-text" : "text-muted hover:bg-raised hover:text-fg",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
