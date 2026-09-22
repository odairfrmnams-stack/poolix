import { cn } from "@/lib/utils";

/**
 * Plain, unhighlighted code. A syntax highlighter would add a large dependency for
 * a handful of snippets, and the monospace contrast is enough to read them.
 */
export function CodeBlock({
  children,
  label,
  className,
}: {
  children: string;
  label?: string;
  className?: string;
}) {
  return (
    <figure className={cn("overflow-hidden rounded-poolix-lg border border-line bg-canvas", className)}>
      {label ? (
        <figcaption className="border-b border-line px-4 py-2 text-[11.5px] tracking-wide text-subtle uppercase">
          {label}
        </figcaption>
      ) : null}
      <pre className="overflow-x-auto px-4 py-3.5 text-[12.5px] leading-relaxed">
        <code className="poolix-numeric text-muted">{children}</code>
      </pre>
    </figure>
  );
}
