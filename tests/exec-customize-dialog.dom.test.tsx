// @vitest-environment jsdom
//
// Customize Executive — the dialog behind the ⋮ menu (owner's design,
// 2026-11-22): tabs, Quiet Mode, a row per card with a drag handle, a size and
// a switch, Widget Ideas, Hidden Cards, the AI Builder, and Save / Cancel.
// Everything edits a draft: opening writes nothing, Save writes it all, Cancel
// drops it.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}) }) }));

let stored: string | null;
let writes: string[];
let suggest: (prompt: string) => { status: number; body: any };
const today = () => new Date().toLocaleDateString("en-CA");

beforeEach(() => {
  stored = null; writes = [];
  suggest = (prompt) => ({ status: 200, body: { by: "ai", widget: { id: "widget", title: "Work Journal", icon: "book", source: "journal", match: "work", limit: 3 } } });
  vi.stubGlobal("fetch", vi.fn(async (url: any, opts?: any) => {
    const u = String(url); const method = String(opts?.method || "GET");
    const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (u.includes("/api/preferences/exec_card_prefs")) {
      if (method === "PUT") { stored = JSON.parse(opts.body).value; writes.push(stored!); return json({ success: true }); }
      return json({ value: stored });
    }
    if (u.includes("/api/exec-widgets/suggest")) {
      const r = suggest(decodeURIComponent(u.split("prompt=")[1] || ""));
      return json(r.body, r.status);
    }
    if (method !== "GET") { writes.push(`${method} ${u}`); return json({}); }
    if (u.includes("/api/journal")) return json([
      { id: "j1", date: today(), title: "Work was rough", content: "", mood: "ok", tags: [], createdAt: new Date().toISOString() },
      { id: "j2", date: today(), title: "Lake day", content: "", mood: "great", tags: [], createdAt: new Date().toISOString() },
    ]);
    return json([]);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function open(onClose: () => void = () => {}) {
  const { ExecCustomizeDialog } = await import("../client/src/components/dashboard/ExecCustomize");
  const { queryClient } = await import("../client/src/lib/queryClient");
  queryClient.clear();
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={() => ["/dashboard", () => {}] as any}>
        <ExecCustomizeDialog open onClose={onClose} />
      </Router>
    </QueryClientProvider>,
  );
  await screen.findByTestId("exec-customize-list");
}
const rowIds = (list = "exec-customize-list") => within(screen.getByTestId(list)).getAllByTestId(/^exec-customize-row-/)
  .map((n) => n.getAttribute("data-testid")!.replace("exec-customize-row-", ""));
const saved = () => JSON.parse(stored!);

describe("the dialog matches the owner's design", () => {
  it("has the header, four tabs, Quiet Mode, the card rows, the builder, ideas, hidden cards and the footer", async () => {
    await open();
    const dlg = screen.getByTestId("exec-customize");
    expect(dlg.textContent).toContain("Customize Executive");
    expect(dlg.textContent).toContain("Choose what appears on your Executive tab and build your own.");
    expect(within(screen.getByTestId("exec-customize-tabs")).getAllByRole("tab").map((t) => t.textContent))
      .toEqual(["Cards & Widgets", "My Custom", "AI Builder", "Layout"]);
    expect(dlg.textContent).toContain("Quiet Mode");
    expect(dlg.textContent).toContain("Show only your essentials (Needs Attention, Timeline, Money, Tasks).");
    expect(dlg.textContent).toContain("Executive Cards");
    expect(dlg.textContent).toContain("Show, hide, and reorder the cards on your Executive dashboard.");
    // Quiet mode is the default: its four cards are the list, the rest are hidden.
    expect(rowIds()).toEqual(["attention", "tasks", "schedule", "money"]);
    expect(screen.getByTestId("exec-customize-hidden-toggle").textContent).toContain("Hidden Cards (4)");
    // Each row: a drag handle, a size, a switch, a details chevron.
    for (const part of ["drag", "size", "show", "more"]) expect(screen.getByTestId(`exec-customize-${part}-money`), part).toBeTruthy();
    expect((screen.getByTestId("exec-customize-size-money") as HTMLSelectElement).value).toBe("large");
    expect((screen.getByTestId("exec-customize-size-tasks") as HTMLSelectElement).value).toBe("medium");
    expect(screen.getByTestId("exec-customize-create").textContent).toContain("Create Your Own Widget");
    expect(screen.getByTestId("exec-customize-create").textContent).toContain("AI Powered");
    expect(within(screen.getByTestId("exec-customize-ideas")).getAllByRole("button").map((b) => b.textContent))
      .toEqual(["VehicleOverview", "FitnessSummary", "Pet CareTracker", "Home &Property", "SpendingThis Month", "RecentJournal"]);
    for (const id of ["exec-customize-reset", "exec-customize-cancel", "exec-customize-save"]) expect(screen.getByTestId(id), id).toBeTruthy();
    expect(screen.getByTestId("exec-customize-reset").textContent).toContain("Reset to Default");
    expect(screen.getByTestId("exec-customize-save").textContent).toBe("Save Changes");
  });
});

describe("a draft until Save", () => {
  it("opening and editing write nothing; Cancel drops the edits", async () => {
    const onClose = vi.fn();
    await open(onClose);
    expect((screen.getByTestId("exec-customize-save") as HTMLButtonElement).disabled).toBe(true); // nothing to save yet
    fireEvent.click(screen.getByTestId("exec-customize-quiet"));
    fireEvent.click(screen.getByTestId("exec-customize-show-money"));
    expect((screen.getByTestId("exec-customize-save") as HTMLButtonElement).disabled).toBe(false);
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByTestId("exec-customize-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
    expect(stored).toBeNull();
  });

  it("Save Changes writes the whole choice once and closes", async () => {
    const onClose = vi.fn();
    await open(onClose);
    fireEvent.click(screen.getByTestId("exec-customize-quiet"));            // quiet off → all eight
    fireEvent.change(screen.getByTestId("exec-customize-size-tasks"), { target: { value: "large" } });
    fireEvent.click(screen.getByTestId("exec-customize-save"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(writes).toHaveLength(1);
    expect(saved()).toEqual({ quiet: false, hidden: [], order: [], sizes: { tasks: "large" }, widgets: [] });
  });

  it("a failed save says so and keeps the dialog open", async () => {
    (globalThis.fetch as any).mockImplementation(async (url: any, opts?: any) =>
      new Response(JSON.stringify(opts?.method === "PUT" ? { error: "down" } : String(url).includes("exec_card_prefs") ? { value: null } : []),
        { status: opts?.method === "PUT" ? 500 : 200, headers: { "Content-Type": "application/json" } }));
    const onClose = vi.fn();
    await open(onClose);
    fireEvent.click(screen.getByTestId("exec-customize-quiet"));
    fireEvent.click(screen.getByTestId("exec-customize-save"));
    await new Promise((r) => setTimeout(r, 400));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("exec-customize-list")).toBeTruthy();
  });
});

describe("cards: show, hide, reorder, size", () => {
  it("reorders with the handle (arrow keys), within the cards that are listed", async () => {
    await open();
    const handle = screen.getByTestId("exec-customize-drag-money");
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(rowIds()).toEqual(["attention", "tasks", "money", "schedule"]);
    fireEvent.keyDown(screen.getByTestId("exec-customize-drag-money"), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByTestId("exec-customize-drag-money"), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByTestId("exec-customize-drag-money"), { key: "ArrowUp" }); // already first: no-op
    expect(rowIds()).toEqual(["money", "attention", "tasks", "schedule"]);
    fireEvent.click(screen.getByTestId("exec-customize-save"));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(saved().order.slice(0, 4)).toEqual(["money", "attention", "tasks", "schedule"]);
  });

  it("a card switched off stays in the list until saved; a hidden one is switched on under Hidden Cards", async () => {
    await open();
    fireEvent.click(screen.getByTestId("exec-customize-show-money"));
    expect(rowIds()).toContain("money");
    expect(screen.getByTestId("exec-customize-show-money").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByTestId("exec-customize-hidden-toggle"));
    const hidden = screen.getByTestId("exec-customize-hidden");
    expect(within(hidden).getAllByTestId(/^exec-customize-row-/).map((n) => n.getAttribute("data-testid")))
      .toEqual(["habits", "documents", "wellness", "activity"].map((id) => `exec-customize-row-${id}`));
    fireEvent.click(within(hidden).getByTestId("exec-customize-show-habits"));
    expect(within(hidden).getByTestId("exec-customize-show-habits").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("exec-customize-save"));
    await waitFor(() => expect(writes).toHaveLength(1));
    // Touching single cards leaves quiet mode; exactly those two changed.
    expect(saved().quiet).toBe(false);
    expect([...saved().hidden].sort()).toEqual(["activity", "documents", "money", "wellness"]);
  });

  it("the chevron opens a row's details", async () => {
    await open();
    expect(screen.queryByTestId("exec-customize-details-money")).toBeNull();
    fireEvent.click(screen.getByTestId("exec-customize-more-money"));
    expect(screen.getByTestId("exec-customize-details-money").textContent).toContain("Large: takes the full row.");
    expect(screen.getByTestId("exec-customize-details-money").textContent).toContain("Quiet Mode essentials");
  });

  it("Layout shows the order and sizes of what is showing", async () => {
    await open();
    fireEvent.click(screen.getByTestId("exec-customize-tab-layout"));
    const panel = screen.getByTestId("exec-customize-panel-layout");
    expect(within(panel).getAllByTestId(/^exec-customize-layout-row-/).map((n) => n.getAttribute("data-testid")!.replace("exec-customize-layout-row-", "")))
      .toEqual(["attention", "tasks", "schedule", "money"]);
    expect(within(screen.getByTestId("exec-customize-preview")).getByText("Money").className).toContain("col-span-2");
    expect(within(screen.getByTestId("exec-customize-preview")).getByText("Tasks").className).not.toContain("col-span-2");
  });
});

describe("cards you build", () => {
  it("a Widget Idea becomes a card in one tap, and is saved with the rest", async () => {
    await open();
    fireEvent.click(screen.getByTestId("exec-customize-idea-journal"));
    expect(rowIds()).toEqual(["attention", "tasks", "schedule", "money", "w:recent-journal"]);
    expect((screen.getByTestId("exec-customize-idea-journal") as HTMLButtonElement).disabled).toBe(true); // not twice
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByTestId("exec-customize-tab-custom"));
    expect(screen.getByTestId("exec-customize-panel-custom").textContent).toContain("Recent Journal");
    fireEvent.click(screen.getByTestId("exec-customize-save"));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(saved().widgets).toEqual([{ id: "recent-journal", title: "Recent Journal", icon: "book", source: "journal", limit: 3 }]);
  });

  it("the AI Builder turns a sentence into a card, previews it from the user's records, and adds it", async () => {
    let asked = "";
    suggest = (prompt) => { asked = prompt; return { status: 200, body: { by: "ai", widget: { id: "widget", title: "Work Journal", icon: "book", source: "journal", match: "work", limit: 3 } } }; };
    await open();
    fireEvent.click(screen.getByTestId("exec-customize-create"));
    fireEvent.change(screen.getByTestId("exec-customize-ai-input"), { target: { value: "journal entries about work" } });
    fireEvent.click(screen.getByTestId("exec-customize-ai-build"));
    const proposal = await screen.findByTestId("exec-customize-ai-proposal");
    expect(asked).toBe("journal entries about work");
    expect((screen.getByTestId("exec-customize-ai-title") as HTMLInputElement).value).toBe("Work Journal");
    expect(screen.getByTestId("exec-customize-ai-description").textContent).toBe("Your latest journal entries matching “work” (up to 3).");
    // The preview is the user's own data, filtered: one of the two entries.
    await waitFor(() => expect(proposal.textContent).toContain("Work was rough"));
    expect(proposal.textContent).not.toContain("Lake day");
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByTestId("exec-customize-ai-add"));
    await screen.findByTestId("exec-customize-list");
    expect(rowIds().slice(-1)).toEqual(["w:work-journal"]);
    fireEvent.click(screen.getByTestId("exec-customize-save"));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(saved().widgets).toEqual([{ id: "work-journal", title: "Work Journal", icon: "book", source: "journal", match: "work", limit: 3 }]);
  });

  it("a reply the app cannot draw is refused, not added", async () => {
    suggest = () => ({ status: 200, body: { by: "ai", widget: { id: "x", title: "Secrets", source: "passwords" } } });
    await open();
    fireEvent.click(screen.getByTestId("exec-customize-tab-ai"));
    fireEvent.change(screen.getByTestId("exec-customize-ai-input"), { target: { value: "show my passwords" } });
    fireEvent.click(screen.getByTestId("exec-customize-ai-build"));
    await screen.findByTestId("exec-customize-ai-error");
    expect(screen.queryByTestId("exec-customize-ai-proposal")).toBeNull();
  });

  it("removing a card you built takes two taps, and Reset to Default keeps your cards", async () => {
    stored = JSON.stringify({ quiet: false, hidden: ["money"], order: ["tasks"], sizes: {}, widgets: [{ id: "recent-journal", title: "Recent Journal", icon: "book", source: "journal", limit: 3 }] });
    await open();
    await waitFor(() => expect(rowIds()).toContain("w:recent-journal"));
    fireEvent.click(screen.getByTestId("exec-customize-reset"));
    fireEvent.click(screen.getByTestId("exec-customize-more-w:recent-journal"));
    const remove = screen.getByTestId("exec-customize-remove-recent-journal");
    fireEvent.click(remove);
    expect(remove.textContent).toContain("Tap again to remove");
    expect(rowIds()).toContain("w:recent-journal");
    fireEvent.click(screen.getByTestId("exec-customize-save"));
    await waitFor(() => expect(writes).toHaveLength(1));
    // Reset: built-in layout and quiet mode; the card the user built is kept.
    expect(saved()).toEqual({ quiet: true, hidden: [], order: [], sizes: {}, widgets: [{ id: "recent-journal", title: "Recent Journal", icon: "book", source: "journal", limit: 3 }] });
  });

  it("the second tap removes it", async () => {
    stored = JSON.stringify({ quiet: false, hidden: [], order: [], sizes: {}, widgets: [{ id: "recent-journal", title: "Recent Journal", icon: "book", source: "journal", limit: 3 }] });
    await open();
    await waitFor(() => expect(rowIds()).toContain("w:recent-journal"));
    fireEvent.click(screen.getByTestId("exec-customize-more-w:recent-journal"));
    fireEvent.click(screen.getByTestId("exec-customize-remove-recent-journal"));
    fireEvent.click(screen.getByTestId("exec-customize-remove-recent-journal"));
    expect(rowIds()).not.toContain("w:recent-journal");
    fireEvent.click(screen.getByTestId("exec-customize-save"));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(saved().widgets).toEqual([]);
  });
});

describe("where it opens from", () => {
  it("the ⋮ menu's Customize opens this dialog, and the tab has no Customize control of its own", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    // (Paths, not file URLs: under jsdom `URL` is the browser's, which fs rejects.)
    const page = readFileSync(join(process.cwd(), "client/src/pages/dashboard.tsx"), "utf8");
    expect(page).toContain('<DropdownMenuItem onClick={() => setCustomizeOpen(true)} data-testid="btn-customize">');
    expect(page).toContain("<ExecCustomizeDialog open={customizeOpen} onClose={() => setCustomizeOpen(false)}");
    expect(page).not.toContain("<CustomizeDialog open={customizeOpen}");
    const tab = readFileSync(join(process.cwd(), "client/src/components/dashboard/ExecutiveBriefing.tsx"), "utf8");
    expect(tab).not.toContain("exec-customize-toggle");
    expect(tab).not.toContain("<ExecCustomizeDialog");
  });
});
