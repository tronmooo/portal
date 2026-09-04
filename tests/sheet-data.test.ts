import { describe, expect, it } from "vitest";
import { decodeSheetData, sheetCellDisplayValue } from "../shared/sheet-data";

describe("canonical sheet-data decoder", () => {
  it("decodes legacy coordinate cells without changing values or formulas", () => {
    const decoded = decodeSheetData({
      rows: 3,
      cols: 2,
      cells: {
        "0,0": { v: "Month" },
        "1,0": { v: "Jan" },
        "1,1": { f: "=SUM(C1:C2)", v: 42 },
      },
    });

    expect(decoded.format).toBe("legacy");
    expect(decoded.rows).toBe(3);
    expect(decoded.cols).toBe(2);
    expect(decoded.cells["1,0"]?.v).toBe("Jan");
    expect(decoded.cells["1,1"]).toEqual({ f: "=SUM(C1:C2)", v: 42 });
    expect(sheetCellDisplayValue(decoded.cells["1,1"])).toBe("=SUM(C1:C2)");
  });

  it("decodes sparse Univer cellData and grows bounds to include used cells", () => {
    const snapshot = {
      id: "book",
      sheetOrder: ["sheet-1"],
      sheets: {
        "sheet-1": {
          id: "sheet-1",
          rowCount: 1000,
          columnCount: 26,
          cellData: {
            0: { 0: { v: "Month" }, 1: { v: "Revenue" } },
            1: { 0: { v: "Jan" }, 1: { v: 1200 } },
            44: { 5: { f: "=SUM(B2:B10)", v: 4200 } },
          },
        },
      },
    };
    const decoded = decodeSheetData({
      rows: 30,
      cols: 4,
      cells: { __univer__: { v: JSON.stringify(snapshot) } },
    });

    expect(decoded.format).toBe("univer");
    expect(decoded.univerSnapshot).toEqual(snapshot);
    expect(decoded.cells["0,0"]?.v).toBe("Month");
    expect(decoded.cells["1,1"]?.v).toBe(1200);
    expect(decoded.cells["44,5"]).toEqual({ f: "=SUM(B2:B10)", v: 4200 });
    expect(decoded.rows).toBe(45);
    expect(decoded.cols).toBe(6);
  });

  it("fails safely for a malformed Univer payload instead of throwing", () => {
    const decoded = decodeSheetData({
      rows: 2,
      cols: 2,
      cells: { __univer__: { v: "{not-json" } },
    });
    expect(decoded).toMatchObject({ format: "legacy", rows: 2, cols: 2, cells: {} });
  });
});
