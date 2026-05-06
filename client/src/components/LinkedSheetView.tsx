// Wave 15: Reusable Google-Sheets-style table view for linked items.
// Used inside profile-detail tabs (documents, subscriptions, assets) to give
// the user a spreadsheet-like view of attached items, alongside the default
// list view. Toggle via <LinkedSheetToggle/>.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Table2, List } from "lucide-react";

export type SheetColumn<T> = {
  key: string;
  label: string;
  render?: (row: T) => React.ReactNode;
  width?: string; // e.g. "120px" or "minmax(120px, 1fr)"
  align?: "left" | "center" | "right";
};

export function LinkedSheetView<T extends { id: string }>({
  rows,
  columns,
  onRowClick,
  emptyMessage = "No items",
  testId,
}: {
  rows: T[];
  columns: SheetColumn<T>[];
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  testId?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="text-center py-6 text-xs text-muted-foreground border rounded-md bg-muted/20">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="border rounded-md overflow-hidden bg-background" data-testid={testId}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="bg-muted/50 sticky top-0">
            <tr>
              {/* Row number column (Google Sheets-style) */}
              <th className="w-8 px-1.5 py-1 text-center font-normal text-[10px] text-muted-foreground border-r border-b">
                #
              </th>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className="px-2 py-1 font-medium text-muted-foreground border-r border-b last:border-r-0 text-left"
                  style={{
                    minWidth: c.width || "100px",
                    textAlign: c.align || "left",
                  }}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr
                key={row.id}
                className={`hover:bg-muted/30 transition-colors ${onRowClick ? "cursor-pointer" : ""}`}
                onClick={() => onRowClick?.(row)}
                data-testid={`${testId}-row-${idx}`}
              >
                <td className="w-8 px-1.5 py-1 text-center text-[10px] text-muted-foreground bg-muted/30 border-r border-b">
                  {idx + 1}
                </td>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className="px-2 py-1 border-r border-b last:border-r-0"
                    style={{ textAlign: c.align || "left" }}
                  >
                    {c.render ? c.render(row) : ((row as any)[c.key] ?? "—")}
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

/** Small toggle button group: list / sheet. Returns the chosen view + a setter. */
export function useLinkedView() {
  const [view, setView] = useState<"list" | "sheet">("list");
  return { view, setView };
}

export function LinkedViewToggle({
  view,
  onChange,
}: {
  view: "list" | "sheet";
  onChange: (v: "list" | "sheet") => void;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-border p-0.5 bg-background">
      <Button
        variant={view === "list" ? "secondary" : "ghost"}
        size="sm"
        className="h-6 px-2 text-[11px] gap-1"
        onClick={() => onChange("list")}
        data-testid="linked-view-list"
        title="List view"
      >
        <List className="h-3 w-3" /> List
      </Button>
      <Button
        variant={view === "sheet" ? "secondary" : "ghost"}
        size="sm"
        className="h-6 px-2 text-[11px] gap-1"
        onClick={() => onChange("sheet")}
        data-testid="linked-view-sheet"
        title="Sheet view"
      >
        <Table2 className="h-3 w-3" /> Sheet
      </Button>
    </div>
  );
}
