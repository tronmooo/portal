// @vitest-environment jsdom
//
// Artifacts page — the counters must equal the data (user report 2026-08-17).
//
// Reported: the page showed "9 Documents / 1 Artifacts / 10 Showing" and type
// chips "All 10 · Documents 0 · AI Reports 1 · Scans 9", but selecting
// AI Reports + #drivers_license rendered "No artifacts yet" while the band
// still read "10 Showing". Three separate defects:
//
//   1. "Showing" was the profile scope, not the rendered set — so it never
//      moved when a filter did.
//   2. The type chips counted the scope while ignoring the active tag, so
//      "AI Reports 1" promised a card that the tag filter then removed.
//   3. The tag chips ignored the active type in the same way.
//   4. An empty RESULT rendered the empty-LIBRARY copy ("No artifacts yet").
//
// The invariant every case below asserts: rendered cards === Showing, and each
// chip's number equals what pressing it actually yields.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import ArtifactsPage from "../client/src/pages/artifacts";

vi.mock("../client/src/lib/auth", () => ({
  useAuth: () => ({ getAuthHeader: () => ({}) }),
}));

// The page reads the global profile filter; keep every test in "everyone"
// scope so the profile dimension is constant and the type/tag dimensions are
// what the assertions actually exercise.
// The page reads the scope through useProfileScope; drive it directly so each
// test controls the profile dimension.
const scope = { mode: "everyone" as string, selectedIds: [] as string[] };
vi.mock("../client/src/hooks/useProfileScope", () => ({
  useProfileScope: () => scope,
}));

const iso = (d: string) => new Date(d).toISOString();

// 9 image scans + 1 AI report — the shape from the report.
const DOCUMENTS = [
  ...Array.from({ length: 8 }, (_, i) => ({
    id: `s${i}`, name: `Scan ${i}`, title: `Scan ${i}`, type: "other",
    mimeType: "image/jpeg", createdAt: iso("2026-03-20"), linkedProfiles: ["p1"],
    extractedData: {}, tags: [],
  })),
  {
    id: "s-dl", name: "Florida Driver License", title: "Florida Driver License",
    type: "identification", mimeType: "image/jpeg", createdAt: iso("2026-03-28"),
    linkedProfiles: ["p1"], extractedData: { sex: "M" }, tags: ["drivers_license"],
  },
];
const ARTIFACTS = [
  {
    id: "a1", title: "Chat citation note", type: "note", content: "hello",
    createdAt: iso("2026-04-01"), linkedProfiles: ["p1"], tags: ["citation", "chat"],
    pinned: false, items: [],
  },
];

let fetchStub: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchStub = vi.fn(async (url: any) => {
    const u = String(url);
    const body = u.includes("/api/documents") ? DOCUMENTS
      : u.includes("/api/artifacts") ? ARTIFACTS
      : u.includes("/api/profiles") ? [{ id: "p1", name: "Robert", type: "self" }, { id: "p2", name: "Other", type: "person" }]
      : [];
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={() => ["/artifacts", () => {}] as any}>
        <ArtifactsPage />
      </Router>
    </QueryClientProvider>,
  );
}

/** The number the "Showing" tile claims. */
const showing = () =>
  Number(within(screen.getByTestId("artifacts-stat-showing")).getByText(/^\d+$/).textContent);
/** The cards actually rendered. */
const cards = () => screen.queryAllByTestId(/^artifact-card-/).length;
/** A type chip's advertised count. */
const chipCount = (key: string) => {
  const chip = screen.getByTestId(`filter-${key}`);
  const nums = (chip.textContent || "").match(/\d+/g) || [];
  return Number(nums[nums.length - 1]);
};

async function ready() {
  await waitFor(() => expect(screen.getByTestId("artifacts-summary")).toBeTruthy());
  await waitFor(() => expect(chipCount("all")).toBeGreaterThan(0));
}

describe("Artifacts counts match the rendered data", () => {
  it("covers everything: All === Documents + AI Reports", async () => {
    mount();
    await ready();
    // Every item is either a documents-table row or an in-app artifact, and
    // the Documents chip covers all of the former plus doc/sheet artifacts —
    // so these two chips partition All.
    expect(chipCount("documents") + chipCount("ai_reports"))
      .toBe(chipCount("all"));
  });

  it("Scans are a subset of Documents, not a sibling of it", async () => {
    mount();
    await ready();
    // A scan IS a document — a documents-table row whose file is an image.
    // Excluding scans from the Documents chip made a profile whose documents
    // were all photographed receipts read "3 items" beside "Documents 0".
    expect(chipCount("scans")).toBeGreaterThan(0);
    expect(chipCount("documents")).toBeGreaterThanOrEqual(chipCount("scans"));
  });

  it("Showing equals the rendered cards for every type filter", async () => {
    mount();
    await ready();
    for (const key of ["all", "documents", "ai_reports", "scans"]) {
      const promised = chipCount(key);
      fireEvent.click(screen.getByTestId(`filter-${key}`));
      await waitFor(() => expect(showing()).toBe(cards()));
      // The chip promised a number; pressing it delivered exactly that.
      expect(cards(), `${key} chip promised ${promised}`).toBe(promised);
    }
  });

  it("THE reported case: #drivers_license + AI Reports shows 0, and says so", async () => {
    mount();
    await ready();
    // Pick the tag first (the order in the report — the tag strip stays put
    // while the type chips are pressed).
    fireEvent.click(screen.getByTestId("tag-filter-drivers_license"));
    await waitFor(() => expect(cards()).toBe(1));
    // With the tag applied, the AI Reports chip must count WITHIN the tag —
    // zero — rather than advertising the global 1 that produced the
    // contradiction ("AI Reports 1" → press → "No artifacts yet").
    expect(chipCount("ai_reports")).toBe(0);

    fireEvent.click(screen.getByTestId("filter-ai_reports"));
    await waitFor(() => expect(cards()).toBe(0));
    // The band agrees with the list instead of contradicting it.
    expect(showing()).toBe(0);
    // The active tag stays pressable so the filter can be undone.
    expect(screen.getByTestId("tag-filter-drivers_license")).toBeTruthy();
  });

  it("a tag that cannot match the active type is not offered at all", async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByTestId("filter-ai_reports"));
    await waitFor(() => expect(cards()).toBe(1));
    // #drivers_license belongs to a scan; under AI Reports it would yield
    // nothing, so it is not advertised. #citation (on the AI report) is.
    expect(screen.queryByTestId("tag-filter-drivers_license")).toBeNull();
    expect(screen.getByTestId("tag-filter-citation")).toBeTruthy();
  });

  it("Scans + #drivers_license shows exactly the one matching scan", async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByTestId("filter-scans"));
    fireEvent.click(screen.getByTestId("tag-filter-drivers_license"));
    await waitFor(() => expect(cards()).toBe(1));
    expect(showing()).toBe(1);
    expect(chipCount("scans")).toBe(1);
    expect(screen.getByText(/Florida Driver License/)).toBeTruthy();
  });

  it("an empty RESULT is not the empty LIBRARY", async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByTestId("tag-filter-drivers_license"));
    fireEvent.click(screen.getByTestId("filter-ai_reports"));
    await waitFor(() => expect(screen.getByTestId("artifacts-empty-filtered")).toBeTruthy());
    // The library is NOT empty, so it must not claim to be.
    expect(screen.queryByTestId("artifacts-empty-none")).toBeNull();
    expect(screen.queryByText("No artifacts yet")).toBeNull();
  });

  it("Clear filters restores the full scope, and the numbers follow", async () => {
    mount();
    await ready();
    const total = chipCount("all");
    fireEvent.click(screen.getByTestId("tag-filter-drivers_license"));
    fireEvent.click(screen.getByTestId("filter-ai_reports"));
    await waitFor(() => expect(showing()).toBe(0));
    fireEvent.click(screen.getByText("Clear filters"));
    await waitFor(() => expect(showing()).toBe(total));
    expect(cards()).toBe(total);
  });

  it("search narrows Showing and the cards together", async () => {
    mount();
    await ready();
    fireEvent.change(screen.getByTestId("input-artifacts-search"), {
      target: { value: "Florida" },
    });
    await waitFor(() => expect(cards()).toBe(1));
    expect(showing()).toBe(1);
    // Type chips re-count under the search too.
    expect(chipCount("all")).toBe(1);
    expect(chipCount("ai_reports")).toBe(0);
  });

  it("the Files + Artifacts split always adds up to Showing", async () => {
    mount();
    await ready();
    const num = (t: string) =>
      Number(within(screen.getByTestId(t)).getByText(/^\d+$/).textContent);
    const sums = () =>
      expect(num("artifacts-stat-files") + num("artifacts-stat-artifacts")).toBe(showing());
    sums();
    // …and it keeps adding up as the filters move.
    fireEvent.click(screen.getByTestId("filter-scans"));
    await waitFor(() => expect(showing()).toBe(cards()));
    sums();
    fireEvent.click(screen.getByTestId("tag-filter-drivers_license"));
    await waitFor(() => expect(showing()).toBe(1));
    sums();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile isolation: "Do not count records belonging to other profiles in the
// top counters while hiding them from the list." Every fixture row is owned by
// p1, so selecting p2 must empty BOTH the list and every counter.
// ─────────────────────────────────────────────────────────────────────────────
describe("counts respect the profile scope", () => {
  afterEach(() => { scope.mode = "everyone"; scope.selectedIds = []; });

  it("a profile that owns nothing shows nothing — and counts nothing", async () => {
    scope.mode = "selected"; scope.selectedIds = ["p2"];
    mount();
    await waitFor(() => expect(screen.getByTestId("artifacts-summary")).toBeTruthy());
    await waitFor(() => expect(cards()).toBe(0));
    expect(showing()).toBe(0);
    expect(chipCount("all")).toBe(0);
    expect(chipCount("scans")).toBe(0);
    expect(chipCount("ai_reports")).toBe(0);
    // That scope genuinely holds no records, so the empty-LIBRARY copy is right.
    expect(screen.getByTestId("artifacts-empty-none")).toBeTruthy();
  });

  it("the owning profile sees exactly its own records", async () => {
    scope.mode = "selected"; scope.selectedIds = ["p1"];
    mount();
    await waitFor(() => expect(chipCount("all")).toBe(10));
    expect(cards()).toBe(10);
    expect(showing()).toBe(10);
  });
});
