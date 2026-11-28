// @vitest-environment jsdom
//
// Deleting an uploaded file from the Artifacts tab. The confirmation reads
// "This permanently removes the file and any history. This cannot be undone."
// The tab sent DELETE /api/documents/:id, a SOFT delete that keeps the bytes in
// the storage bucket for a Trash no screen offers — so every "permanently
// removed" file stayed stored for good (integrity run ui-records.document,
// 2026-11-27). The tab now purges the file (POST /api/documents/:id/purge),
// and an artifact is still deleted by its own route.
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
    linkedProfiles: ["p1"], extractedData: { sex: "M" },
    // Two app-written tags ride along with the real one (F-59/F-55).
    tags: ["drivers_license", "sha256:deadbeef", "image-discarded"],
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


async function deleteVia(id: string) {
  await waitFor(() => expect(screen.getByTestId(`button-more-${id}`)).toBeTruthy());
  const trigger = screen.getByTestId(`button-more-${id}`);
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse", ctrlKey: false });
  fireEvent.keyDown(trigger, { key: "Enter" });
  const item = await waitFor(() => screen.getByTestId(`button-delete-${id}`));
  fireEvent.click(item);
  const confirm = await waitFor(() => screen.getByTestId("button-artifact-delete-confirm"));
  fireEvent.click(confirm);
}
const calls = () => fetchStub.mock.calls.map(([u, init]: any[]) => `${(init?.method || "GET").toUpperCase()} ${new URL(String(u), "http://x").pathname}`);

describe("Artifacts tab: Delete does what its confirmation says", () => {
  it("an uploaded file is purged (row and stored bytes), never only soft-deleted", async () => {
    mount();
    await deleteVia("s0");
    await waitFor(() => expect(calls()).toContain("POST /api/documents/s0/purge"));
    expect(calls()).not.toContain("DELETE /api/documents/s0");
  });
  it("an artifact is deleted by its own route", async () => {
    mount();
    await deleteVia("a1");
    await waitFor(() => expect(calls()).toContain("DELETE /api/artifacts/a1"));
  });
});
