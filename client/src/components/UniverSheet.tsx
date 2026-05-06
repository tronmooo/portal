// UniverSheet — Google-Sheets-equivalent spreadsheet powered by Univer.
//
// Why Univer:
//   - Real formula bar with =FORMULA autocomplete (SUM, AVERAGE, IF, VLOOKUP, …
//     500+ functions out of the box).
//   - Drag-fill, freeze panes, merge cells, format toolbar, conditional fmt,
//     find/replace, comments, multi-sheet tabs — all native, no custom code.
//   - Apache 2.0, free for commercial use.
//
// Phase 8 / Wave 16: replaces react-spreadsheet for newly-created sheets.
// Existing artifacts continue to render in the legacy view (read-only) until
// the user opts to upgrade them — see editor.tsx routing for details.

import { useEffect, useRef } from "react";
import { LocaleType, merge } from "@univerjs/presets";
import { createUniver } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/presets/preset-sheets-core";
import sheetsCoreEnUS from "@univerjs/presets/preset-sheets-core/locales/en-US";

// Univer ships its own CSS; load it once per page.
import "@univerjs/presets/lib/styles/preset-sheets-core.css";

export interface UniverSheetProps {
  /**
   * Optional initial workbook snapshot. If omitted, an empty workbook is
   * created with one sheet named "Sheet1".
   */
  initialSnapshot?: any;
  /**
   * Called whenever the workbook changes. Receives the full snapshot so the
   * parent can persist it to the artifact backend.
   */
  onChange?: (snapshot: any) => void;
  /**
   * Optional sheet display name shown in the bottom tab.
   */
  sheetName?: string;
  /**
   * Light or dark theme tint.
   */
  darkMode?: boolean;
}

/**
 * Build an empty workbook snapshot. Univer expects the standard IWorkbookData
 * shape — a top-level workbook with named sheets keyed by id.
 */
function emptyWorkbook(sheetName = "Sheet1"): any {
  const sheetId = "sheet-1";
  return {
    id: "portol-workbook",
    sheetOrder: [sheetId],
    name: sheetName,
    appVersion: "0.21.1",
    locale: LocaleType.EN_US,
    styles: {},
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: sheetName,
        cellData: {},
        rowCount: 1000,
        columnCount: 26,
        zoomRatio: 1,
        scrollTop: 0,
        scrollLeft: 0,
        defaultColumnWidth: 88,
        defaultRowHeight: 24,
        mergeData: [],
        rowData: {},
        columnData: {},
        showGridlines: 1,
        rowHeader: { width: 46, hidden: 0 },
        columnHeader: { height: 20, hidden: 0 },
        selections: ["A1"],
        rightToLeft: 0,
      },
    },
    resources: [],
  };
}

export default function UniverSheet({
  initialSnapshot,
  onChange,
  sheetName,
  darkMode,
}: UniverSheetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const univerApiRef = useRef<any>(null);
  const disposeRef = useRef<(() => void) | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let unsub: (() => void) | null = null;

    (async () => {
      const { univerAPI, univer } = createUniver({
        locale: LocaleType.EN_US,
        locales: { [LocaleType.EN_US]: merge({}, sheetsCoreEnUS as any) },
        theme: darkMode ? undefined : undefined, // default theme; Univer auto-detects.
        presets: [
          UniverSheetsCorePreset({
            container: containerRef.current!,
          }),
        ],
      });

      if (disposed) {
        univer.dispose();
        return;
      }

      univerApiRef.current = univerAPI;

      // Load workbook (provided snapshot or fresh empty book).
      const snapshot = initialSnapshot && initialSnapshot.sheets
        ? initialSnapshot
        : emptyWorkbook(sheetName);
      univerAPI.createWorkbook(snapshot);

      // Wire change tracking. Univer fires CommandExecuted for every cell edit;
      // we debounce snapshot dumps so we only push to the parent ~once per 400ms.
      let saveTimer: any = null;
      const scheduleSave = () => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          try {
            const wb = univerAPI.getActiveWorkbook?.();
            if (wb && onChangeRef.current) {
              const snap = wb.save();
              onChangeRef.current(snap);
            }
          } catch (e) {
            console.warn("[UniverSheet] save failed", e);
          }
        }, 400);
      };

      // CommandExecuted is the universal "something changed" hook.
      const handler = univerAPI.addEvent?.(
        (univerAPI as any).Event?.CommandExecuted,
        () => scheduleSave(),
      );
      unsub = () => {
        if (saveTimer) clearTimeout(saveTimer);
        try { handler?.dispose?.(); } catch { /* ignore */ }
      };

      disposeRef.current = () => {
        try { unsub?.(); } catch { /* ignore */ }
        try { univer.dispose(); } catch { /* ignore */ }
      };
    })();

    return () => {
      disposed = true;
      try { disposeRef.current?.(); } catch { /* ignore */ }
      disposeRef.current = null;
      univerApiRef.current = null;
    };
    // We intentionally only initialize Univer once per mount. Snapshot/sheetName
    // changes after first render are ignored — re-key the component to reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      data-testid="univer-sheet-container"
      style={{ minHeight: 480 }}
    />
  );
}
