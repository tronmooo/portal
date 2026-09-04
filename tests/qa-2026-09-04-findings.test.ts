// QA pass 2026-09-04 (signed-in production walkthrough of portol.me).
//
// The report:
//   1. stale deployment chunks crashed navigation and forced reloads
//   2. document links inside a profile did nothing when clicked
//   3. extracted receipt data rendered as "items: [object Object],[object Object]"
//   4. "Documents" meant three different sets in three places
//   6. Settings' "Profiles" count (30) contradicted the Profiles screen (1 person)
//
// Each test below pins the fix for one of those so it cannot silently return.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  stringifyField,
  formatLineItem,
  formatLineItems,
  isLineItemArray,
} from "../client/src/lib/field-display";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("3. extracted receipt data renders as text, never [object Object]", () => {
  const items = [
    { name: "Flat White", quantity: 2, price: 4.5 },
    { name: "Avocado Toast", quantity: 1, price: 12 },
  ];

  it("formats a receipt's line items with name, quantity and price", () => {
    expect(formatLineItem(items[0])).toBe("2 × Flat White — $4.50");
    // Quantity 1 is noise — a receipt line for one item just names it.
    expect(formatLineItem(items[1])).toBe("Avocado Toast — $12.00");
    expect(formatLineItems(items)).toBe("2 × Flat White — $4.50 · Avocado Toast — $12.00");
  });

  it("recognizes a line-item array, and only a line-item array", () => {
    expect(isLineItemArray(items)).toBe(true);
    expect(isLineItemArray([])).toBe(false);
    expect(isLineItemArray(["a", "b"])).toBe(false);
    expect(isLineItemArray([{ city: "Austin", state: "TX" }])).toBe(false);
    expect(isLineItemArray("items")).toBe(false);
  });

  it("stringifyField never produces the literal the QA pass saw", () => {
    for (const value of [items, items[0], { street: "1 Main", city: "Austin" }, [1, 2, 3]]) {
      expect(stringifyField(value)).not.toContain("[object Object]");
    }
    expect(stringifyField(items)).toContain("Flat White");
  });

  it("keeps an already-formatted price string as written, in any currency", () => {
    expect(formatLineItem({ name: "Espresso", price: "€3,50" })).toBe("Espresso — €3,50");
  });

  it("every renderer of extractedData goes through the safe stringifier", () => {
    for (const file of [
      "client/src/pages/artifacts.tsx",
      "client/src/pages/profile-detail.tsx",
      "client/src/pages/document-detail.tsx",
      "client/src/components/DocumentViewer.tsx",
    ]) {
      expect(read(file)).toContain("field-display");
    }
    // The two shapes that produced the bug: `${v}` interpolation and String().
    expect(read("client/src/pages/artifacts.tsx")).not.toContain("`${k}: ${v}`");
    expect(read("client/src/pages/profile-detail.tsx")).not.toContain("{String(value)}");
    expect(read("client/src/components/DocumentViewer.tsx")).not.toContain('{String(val ?? "—")}');
    expect(read("client/src/pages/document-detail.tsx")).not.toContain('{String(val ?? "—")}');
  });
});

describe("2. a document row inside a profile opens when its name is clicked", () => {
  it("does not wrap the title in a click-swallowing div", () => {
    const src = read("client/src/pages/profile-detail.tsx");
    // The rename control (EditableTitle) stops propagation on its own pencil,
    // input and save/cancel buttons. A wrapper that stopped EVERY click also
    // ate the one on the document name — the primary way to open the viewer.
    expect(src).not.toContain(
      '<div className="text-sm font-medium text-primary" onClick={(e) => e.stopPropagation()}>',
    );
    expect(src).toContain('<div className="text-sm font-medium text-primary">');
  });

  it("EditableTitle still guards its own controls", () => {
    const src = read("client/src/components/EditableTitle.tsx");
    expect(src).toContain("e.stopPropagation()");
    expect(src).toContain("onClick={(e) => { stop(e); setEditing(true); }}");
  });
});

describe("1. a stale deploy recovers instead of looping", () => {
  const src = read("client/src/components/ErrorBoundary.tsx");

  it("drops the cached app shell before reloading", () => {
    // Reloading alone re-served the same stale index.html out of the
    // NetworkFirst shell cache, so the chunk 404'd again.
    expect(src).toContain("purgeShellCaches");
    expect(src).toContain("portol-shell");
  });

  it("still reloads if the Cache API is unavailable or hangs", () => {
    expect(src).toContain("Promise.race");
    expect(src).toContain("window.location.reload()");
  });

  it("keeps the reload rate limit that prevents a loop", () => {
    expect(src).toContain("RELOAD_COOLDOWN_MS");
  });

  it("retries a failed chunk once before spending a whole page reload", () => {
    const retry = read("client/src/lib/lazy-retry.ts");
    expect(retry).toContain("isStaleChunkError");
    expect(retry).toContain("reloadForStaleChunk");
    // Every route goes through the retrying wrapper, not bare React.lazy.
    const app = read("client/src/App.tsx");
    expect(app).toContain("lazyWithRetry");
    expect(app).not.toMatch(/= lazy\(_\w+Import\)/);
  });

  it("gives a cold navigation time to answer before falling back to the cache", () => {
    // A 3s timeout fired routinely on a cold serverless start, handing an
    // ONLINE user the previous deploy's shell.
    const vite = read("vite.config.ts");
    const timeout = vite.match(/networkTimeoutSeconds:\s*(\d+)/);
    expect(timeout).toBeTruthy();
    expect(Number(timeout![1])).toBeGreaterThanOrEqual(8);
  });
});

describe("4 & 6. a count says which question it answers", () => {
  const settings = read("client/src/pages/settings.tsx");

  it("labels the account-wide Documents and Profiles tiles", () => {
    expect(settings).toContain('label="Documents" hint="Across all profiles"');
    expect(settings).toContain('label="Profiles" hint="People, pets, property & accounts"');
  });

  it("links each tile to the screen showing the number it prints", () => {
    // "30 Profiles" linked to the Self profile, whose screen says "1 person".
    expect(settings).toContain('hint="People, pets, property & accounts" value={profiles.length} href="/profiles/list"');
  });

  it("counts a scan as a document on the Artifacts page", () => {
    const artifacts = read("client/src/pages/artifacts.tsx");
    expect(artifacts).toContain('tab === "documents" ? (i.type === "document" || i.type === "scan")');
    expect(artifacts).toContain('documents: base.filter(i => i.type === "document" || i.type === "scan").length');
  });
});

describe("5. the first-ever visit does not wait on a cold serverless start", () => {
  it("seeds auth config from build-time constants when they exist", () => {
    const auth = read("client/src/lib/auth.tsx");
    expect(auth).toContain("import.meta.env?.VITE_SUPABASE_URL");
    expect(auth).toContain("import.meta.env?.VITE_SUPABASE_ANON_KEY");
    // Still revalidated against the server on the cached-config path.
    expect(auth).toContain("fetchFreshConfig");
  });
});
