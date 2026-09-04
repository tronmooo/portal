/**
 * Canonical reader for the two spreadsheet formats Portol persists.
 *
 * Legacy sheets store sparse cells directly as `"row,column"` keys. New sheets
 * store a serialized Univer workbook snapshot in `cells.__univer__.v`. Keeping
 * this decoder shared prevents export, charts and public sharing from silently
 * interpreting every modern workbook as an empty legacy grid.
 */

export interface SheetDataLike {
  rows?: number;
  cols?: number;
  cells?: Record<string, any>;
}

export interface DecodedSheetCell {
  v?: unknown;
  f?: string;
}

export interface DecodedSheetData {
  rows: number;
  cols: number;
  cells: Record<string, DecodedSheetCell>;
  format: "legacy" | "univer";
  /** Parsed workbook snapshot, when the persisted Univer payload is valid. */
  univerSnapshot?: any;
}

function positiveInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function normalizeCell(raw: any): DecodedSheetCell | null {
  if (!raw || typeof raw !== "object") return null;
  const out: DecodedSheetCell = {};
  if (raw.v !== undefined && raw.v !== null) out.v = raw.v;
  if (typeof raw.f === "string" && raw.f.length > 0) out.f = raw.f;

  // Univer rich-text cells keep their displayed text in a paragraph payload.
  if (out.v === undefined && typeof raw.p?.body?.dataStream === "string") {
    out.v = raw.p.body.dataStream.replace(/\r\n$/, "");
  }
  return out.v !== undefined || out.f !== undefined ? out : null;
}

function parseUniverSnapshot(payload: unknown): any | undefined {
  if (payload && typeof payload === "object") return payload;
  if (typeof payload !== "string" || payload.length === 0) return undefined;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function firstWorksheet(snapshot: any): any | undefined {
  if (!snapshot?.sheets || typeof snapshot.sheets !== "object") return undefined;
  const preferredIds = [
    snapshot.activeSheetId,
    snapshot.currentSheetId,
    ...(Array.isArray(snapshot.sheetOrder) ? snapshot.sheetOrder : []),
    ...Object.keys(snapshot.sheets),
  ].filter((id): id is string => typeof id === "string" && id.length > 0);
  for (const id of preferredIds) {
    if (snapshot.sheets[id]) return snapshot.sheets[id];
  }
  return undefined;
}

export function decodeSheetData(input: SheetDataLike | null | undefined): DecodedSheetData {
  const baseRows = positiveInteger(input?.rows, 1);
  const baseCols = positiveInteger(input?.cols, 1);
  const cells: Record<string, DecodedSheetCell> = {};
  let maxRow = -1;
  let maxCol = -1;

  const put = (row: number, col: number, raw: any) => {
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) return;
    const cell = normalizeCell(raw);
    if (!cell) return;
    cells[`${row},${col}`] = cell;
    maxRow = Math.max(maxRow, row);
    maxCol = Math.max(maxCol, col);
  };

  // Decode coordinate-map cells first. A valid Univer snapshot below wins if a
  // migration artifact happens to contain both representations.
  for (const [key, raw] of Object.entries(input?.cells || {})) {
    const match = /^(\d+),(\d+)$/.exec(key);
    if (match) put(Number(match[1]), Number(match[2]), raw);
  }

  const snapshot = parseUniverSnapshot((input?.cells as any)?.__univer__?.v);
  const worksheet = firstWorksheet(snapshot);
  if (worksheet?.cellData && typeof worksheet.cellData === "object") {
    for (const [rowKey, rowCells] of Object.entries(worksheet.cellData)) {
      if (!rowCells || typeof rowCells !== "object") continue;
      for (const [colKey, raw] of Object.entries(rowCells as Record<string, any>)) {
        put(Number(rowKey), Number(colKey), raw);
      }
    }
  }

  return {
    // Do not render Univer's full default 1000×26 empty canvas in public views.
    // Preserve the artifact's declared grid and only grow it to include used
    // cells that lie outside those legacy bounds.
    rows: Math.max(baseRows, maxRow + 1),
    cols: Math.max(baseCols, maxCol + 1),
    cells,
    format: snapshot ? "univer" : "legacy",
    ...(snapshot ? { univerSnapshot: snapshot } : {}),
  };
}

export function sheetCellDisplayValue(cell: DecodedSheetCell | undefined): string {
  if (!cell) return "";
  if (cell.f) return cell.f.startsWith("=") ? cell.f : `=${cell.f}`;
  return cell.v === undefined || cell.v === null ? "" : String(cell.v);
}
