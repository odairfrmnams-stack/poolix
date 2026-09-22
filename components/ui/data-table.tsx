import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/*
  A table of real rows.

  Two things it deliberately does. It scrolls horizontally on a narrow screen rather than
  wrapping cells into an unreadable stack — a column of numbers that has lost its heading
  is worse than one you have to scroll to. And it takes an explicit `empty` message,
  because an empty table with no explanation reads as broken when the truth is usually
  "nothing matched" or "not scanned yet".
*/

export interface Column<Row> {
  readonly key: string;
  readonly header: ReactNode;
  readonly align?: "left" | "right";
  /** Hides the column below the given breakpoint, for secondary detail on a phone. */
  readonly hideBelow?: "sm" | "md" | "lg";
  readonly width?: string;
  readonly cell: (row: Row, index: number) => ReactNode;
}

export interface DataTableProps<Row> {
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row, index: number) => string;
  readonly empty: ReactNode;
  /** Wraps each row, e.g. in a link. Receives the rendered cells. */
  readonly rowHref?: (row: Row) => string | undefined;
  readonly caption?: string;
  readonly className?: string;
}

const hideClass = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
} as const;

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  empty,
  caption,
  className,
}: DataTableProps<Row>) {
  if (rows.length === 0) {
    return (
      <div className="rounded-poolix-lg border border-line bg-surface px-4 py-10 text-center text-[13px] text-subtle">
        {empty}
      </div>
    );
  }

  return (
    <div className={cn("overflow-hidden rounded-poolix-lg border border-line bg-surface", className)}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead>
            <tr className="border-b border-line">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  style={column.width ? { width: column.width } : undefined}
                  className={cn(
                    "px-4 py-3 text-[11px] font-medium uppercase tracking-[0.07em] text-subtle",
                    column.align === "right" ? "text-right" : "text-left",
                    column.hideBelow ? hideClass[column.hideBelow] : "",
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={rowKey(row, index)}
                className="border-b border-line/60 transition-colors last:border-0 hover:bg-hover"
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn(
                      "px-4 py-3 align-middle",
                      column.align === "right" ? "text-right" : "text-left",
                      column.hideBelow ? hideClass[column.hideBelow] : "",
                    )}
                  >
                    {column.cell(row, index)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
