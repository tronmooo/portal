import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const editorSource = readFileSync(
  resolve(process.cwd(), "client/src/pages/editor.tsx"),
  "utf8",
);

describe("editor chart and mobile-sheet affordances", () => {
  it("mounts exactly one insert-chart dialog", () => {
    expect(editorSource.match(/<Dialog open=\{chartOpen\}/g) ?? []).toHaveLength(1);
    expect(editorSource.match(/data-testid="input-chart-range"/g) ?? []).toHaveLength(1);
    expect(editorSource.match(/data-testid="input-chart-title"/g) ?? []).toHaveLength(1);
  });

  it("does not expose fake comments or multi-sheet controls", () => {
    const mobileBarAt = editorSource.indexOf('data-testid="mobile-sheet-tab-bar"');
    const mobileBarSource = editorSource.slice(Math.max(0, mobileBarAt - 500), mobileBarAt + 1_500);
    expect(editorSource).not.toContain('data-testid="button-mobile-comments"');
    expect(editorSource).not.toContain('data-testid="button-sheet-menu"');
    expect(editorSource).not.toContain('data-testid="button-sheet-tab-active"');
    expect(mobileBarSource).not.toContain('data-testid="button-sheet-add"');
    expect(editorSource).toContain('data-testid="mobile-sheet-current"');
    expect(editorSource).toContain("Single-sheet mobile view");
  });

  it("marks mobile sheet undo and redo unavailable instead of leaving no-op buttons", () => {
    expect(editorSource).toContain('aria-label={type === "sheet" ? "Undo unavailable in mobile sheet view" : "Undo"}');
    expect(editorSource).toContain('aria-label={type === "sheet" ? "Redo unavailable in mobile sheet view" : "Redo"}');
    expect(editorSource.match(/disabled=\{type === "sheet"\}/g) ?? []).toHaveLength(2);
  });
});
