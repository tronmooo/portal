// @vitest-environment jsdom
//
// Everything on the Info tab is editable — by hand.
//
// The tab is where all the data that doesn't fit a tracker ends up: identity
// fields, the fields a scanned document wrote into nested groups, notes (both
// the scratchpad and saved Note records), tags, chat-saved facts, documents,
// and the activity log. Pieces of it have gone read-only one at a time and
// each one had to be reported before anyone noticed:
//
//   · nested-group fields (2026-07-26, "why won't it let me edit these")
//   · the profile NAME (2026-08-25, the rename that reported success and
//     changed nothing)
//   · the profile TYPE — never editable here at all, so "my truck shows up as
//     a person" had no manual fix
//   · saved notes — deletable but not correctable
//   · activity rows — dead text pointing at records that live elsewhere
//
// So this test walks the whole page and asserts the CRUD, rather than trusting
// that the next section to be added remembers to have any.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

type Call = { method: string; url: string; body: any };

const { apiRequest, calls, scope } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  calls: [] as Array<{ method: string; url: string; body: any }>,
  scope: { mode: "single" as string, selectedIds: ["bob-1"], selectedNames: ["Bob QA"], isFiltered: true },
}));

const PROFILE = {
  id: "bob-1",
  type: "person",
  name: "Bob QA",
  avatar: null,
  tags: ["household"],
  notes: "Free-text scratchpad.",
  fields: {
    phone: "555-0100",
    // A nested group — what a scanned document writes.
    identity: { licenseNumber: "D1234567" },
  },
  timeline: [
    { id: "e1", type: "tracker", title: "Running logged", data: { trackerId: "tr-1" }, timestamp: new Date().toISOString() },
    { id: "e2", type: "task", title: "Renew passport", timestamp: new Date().toISOString() },
  ],
  relatedJournal: [],
  relatedDocuments: [],
};

let selfMode = false;

const JANE = { id: "jane-1", type: "person", name: "Jane Doe", fields: {}, tags: [] };

const NOTES = [
  { id: "n1", title: "Bob favorite color", content: "Bob's favorite color is cobalt." },
];

vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest, BROWSER_TIMEZONE: "America/Los_Angeles" };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useProfileScope", () => ({ useProfileScope: () => scope }));
// The bus talks to a real queryClient elsewhere; the page's own invalidation is
// not what this test is about.
vi.mock("@/lib/cache-bus", () => ({
  invalidateDomain: vi.fn(async () => {}),
  invalidateDomains: vi.fn(async () => {}),
}));

import ProfileInfoPage from "../client/src/pages/profile-info";
import { queryClient as mockedQueryClient } from "@/lib/queryClient";

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const navigate = vi.fn();
  const hook = () => ["/profiles/bob-1/info", navigate] as [string, (to: string, opts?: any) => void];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Router hook={hook as any}>
        <ProfileInfoPage />
      </Router>
    </QueryClientProvider>,
  );
  return { navigate };
}

/** The write this interaction sent, or undefined. */
const wrote = (method: string, urlPart: string): Call | undefined =>
  calls.find(c => c.method === method && c.url.includes(urlPart));

beforeEach(() => {
  // Radix's Select probes APIs jsdom does not implement.
  (Element.prototype as any).hasPointerCapture ??= () => false;
  (Element.prototype as any).setPointerCapture ??= () => {};
  (Element.prototype as any).releasePointerCapture ??= () => {};
  (Element.prototype as any).scrollIntoView ??= () => {};
  calls.length = 0;
  selfMode = false;
  apiRequest.mockImplementation(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    if (method === "GET" && url.startsWith("/api/profile-bootstrap/")) {
      if (selfMode) {
        const me = { ...PROFILE, type: "self" };
        return json({ detail: me, profiles: [me, JANE] });
      }
      // The bootstrap payload seeds the profiles cache, which is what the
      // client-side collision check reads. (It is a courtesy check only: the
      // PATCH route enforces the same rule server-side, so a stale or partial
      // cache cannot let a duplicate name through.)
      return json({ detail: PROFILE, profiles: [PROFILE, JANE] });
    }
    if (method === "GET" && url.startsWith("/api/notes")) return json(NOTES);
    if (method === "GET" && url.startsWith("/api/memories")) return json([]);
    if (method === "GET" && url.startsWith("/api/profiles/")) return json(PROFILE);
    return json({ ok: true });
  });
  (mockedQueryClient as QueryClient).setQueryData(["/api/profiles"], [PROFILE, JANE]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const ready = () => waitFor(() => expect(screen.getByTestId("info-name")).toBeTruthy());

describe("identity: name and type", () => {
  it("renames the profile from the header", async () => {
    renderPage();
    await ready();

    fireEvent.click(screen.getByTestId("button-edit-info-name"));
    const input = screen.getByTestId("info-name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Bob Robertson" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(wrote("PATCH", "/api/profiles/bob-1")).toBeTruthy());
    expect(wrote("PATCH", "/api/profiles/bob-1")!.body).toEqual({ name: "Bob Robertson" });
  });

  it("refuses a name another profile already answers to — no write leaves", async () => {
    renderPage();
    await ready();

    fireEvent.click(screen.getByTestId("button-edit-info-name"));
    const input = screen.getByTestId("info-name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Jane Doe" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.queryByTestId("button-edit-info-name")).toBeTruthy());
    expect(wrote("PATCH", "/api/profiles/bob-1")).toBeUndefined();
  });

  it("re-types the record — the fix for 'my truck shows up as a person'", async () => {
    renderPage();
    await ready();
    // The trigger is a real control, not the static text it used to be.
    const trigger = screen.getByTestId("info-type");
    expect(trigger.getAttribute("aria-label")).toBe("Change type");
    expect(trigger.tagName.toLowerCase()).toBe("button");

    // Radix opens on pointerdown; jsdom has no pointer capture, so supply it.
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const option = await screen.findByTestId("info-type-vehicle");
    fireEvent.click(option);

    await waitFor(() => expect(wrote("PATCH", "/api/profiles/bob-1")).toBeTruthy());
    expect(wrote("PATCH", "/api/profiles/bob-1")!.body).toEqual({ type: "vehicle" });
  });

  it("the self profile keeps its type — the app resolves 'me' by it", async () => {
    selfMode = true;
    renderPage();
    await ready();
    const el = screen.getByTestId("info-type");
    expect(el.tagName.toLowerCase()).toBe("p");
    expect(el.textContent).toBe("self");
  });
});

describe("fields", () => {
  it("edits an identity field", async () => {
    renderPage();
    await ready();

    fireEvent.click(screen.getByTestId("info-cell-Phone"));
    const input = screen.getByTestId("info-edit-Phone") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "555-0199" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(wrote("PATCH", "/api/profiles/bob-1")).toBeTruthy());
    expect(wrote("PATCH", "/api/profiles/bob-1")!.body).toEqual({ fields: { phone: "555-0199" } });
  });

  it("deletes an identity field", async () => {
    renderPage();
    await ready();

    fireEvent.click(screen.getByTestId("info-remove-Phone"));
    await waitFor(() => expect(wrote("PATCH", "/api/profiles/bob-1")).toBeTruthy());
    expect(wrote("PATCH", "/api/profiles/bob-1")!.body).toEqual({ fieldsToDelete: ["phone"] });
  });

  it("adds a field", async () => {
    renderPage();
    await ready();

    fireEvent.click(screen.getByTestId("info-add-field"));
    fireEvent.change(screen.getByTestId("info-new-key"), { target: { value: "Nickname" } });
    fireEvent.change(screen.getByTestId("info-new-val"), { target: { value: "Bobby" } });
    fireEvent.click(screen.getByTestId("info-new-save"));

    await waitFor(() => expect(wrote("PATCH", "/api/profiles/bob-1")).toBeTruthy());
    expect(wrote("PATCH", "/api/profiles/bob-1")!.body).toEqual({ fields: { Nickname: "Bobby" } });
  });

  it("edits a NESTED-group field — the 2026-07-26 report", async () => {
    renderPage();
    await ready();
    expect(screen.getByTestId("info-group-identity")).toBeTruthy();

    fireEvent.click(screen.getByTestId("info-cell-License Number"));
    const input = screen.getByTestId("info-edit-License Number") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "D7654321" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(wrote("PATCH", "/api/profiles/bob-1")).toBeTruthy());
    expect(wrote("PATCH", "/api/profiles/bob-1")!.body.fields.licenseNumber).toBe("D7654321");
  });

  it("deletes a nested-group field by identity, not by exact key", async () => {
    renderPage();
    await ready();

    fireEvent.click(screen.getByTestId("info-remove-License Number"));
    await waitFor(() => expect(wrote("PATCH", "/api/profiles/bob-1")).toBeTruthy());
    expect(wrote("PATCH", "/api/profiles/bob-1")!.body).toEqual({ fieldsToDelete: ["licenseNumber"] });
  });
});

describe("notes and tags", () => {
  it("edits the free-text notes", async () => {
    renderPage();
    await ready();

    fireEvent.click(screen.getByLabelText("Edit notes"));
    fireEvent.change(screen.getByTestId("info-notes-input"), { target: { value: "Updated scratchpad." } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(wrote("PATCH", "/api/profiles/bob-1")).toBeTruthy());
    expect(wrote("PATCH", "/api/profiles/bob-1")!.body).toEqual({ notes: "Updated scratchpad." });
  });

  it("edits a SAVED note in place — title and body", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("saved-note-n1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("saved-note-edit-n1"));
    fireEvent.change(screen.getByTestId("saved-note-title-input-n1"), { target: { value: "Bob's favorite colour" } });
    fireEvent.change(screen.getByTestId("saved-note-content-input-n1"), { target: { value: "It is cobalt blue." } });
    fireEvent.click(screen.getByTestId("saved-note-save-n1"));

    await waitFor(() => expect(wrote("PATCH", "/api/notes/n1")).toBeTruthy());
    expect(wrote("PATCH", "/api/notes/n1")!.body).toEqual({
      title: "Bob's favorite colour",
      content: "It is cobalt blue.",
    });
  });

  it("emptying a saved note's body cancels rather than erasing it", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("saved-note-n1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("saved-note-edit-n1"));
    fireEvent.change(screen.getByTestId("saved-note-content-input-n1"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("saved-note-save-n1"));

    await waitFor(() => expect(screen.getByTestId("saved-note-edit-n1")).toBeTruthy());
    expect(wrote("PATCH", "/api/notes/n1")).toBeUndefined();
  });

  it("deletes a saved note", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("saved-note-n1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("saved-note-delete-n1"));
    await waitFor(() => expect(wrote("DELETE", "/api/notes/n1")).toBeTruthy());
  });

  it("adds and removes a tag", async () => {
    renderPage();
    await ready();

    const tagInput = screen.getByTestId("info-tag-input");
    fireEvent.change(tagInput, { target: { value: "vip" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    await waitFor(() => expect(wrote("PATCH", "/api/profiles/bob-1")).toBeTruthy());
    expect(wrote("PATCH", "/api/profiles/bob-1")!.body).toEqual({ tags: ["household", "vip"] });

    calls.length = 0;
    fireEvent.click(screen.getByLabelText("Remove household"));
    await waitFor(() => expect(wrote("PATCH", "/api/profiles/bob-1")).toBeTruthy());
    expect(wrote("PATCH", "/api/profiles/bob-1")!.body).toEqual({ tags: [] });
  });
});

describe("activity rows reach the record they describe", () => {
  it("a tracker entry opens its tracker", async () => {
    const { navigate } = renderPage();
    await waitFor(() => expect(screen.getByTestId("info-activity-e1")).toBeTruthy());

    fireEvent.click(screen.getByTestId("info-activity-e1"));
    expect(navigate.mock.calls[0][0]).toBe("/trackers?tracker=tr-1");
  });

  it("a task row opens Tasks", async () => {
    const { navigate } = renderPage();
    await waitFor(() => expect(screen.getByTestId("info-activity-e2")).toBeTruthy());

    fireEvent.click(screen.getByTestId("info-activity-e2"));
    expect(navigate.mock.calls[0][0]).toBe("/tasks");
  });
});
