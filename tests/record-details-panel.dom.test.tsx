// @vitest-environment jsdom
//
// The Details panel, rendered for real against an in-memory /api/details that
// is built from the same shared module the server uses:
//   • opening it writes nothing (Rule 3);
//   • a condition is set with its scale's buttons, and the request carries
//     the structured value;
//   • removing a value takes two taps (Rule 8);
//   • "Add detail" defines a new characteristic with a TYPE and stores a typed
//     value — not a free-text pair;
//   • a load failure is an error with a retry, never an empty panel (Rule 7).
import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  applyDetailChange, buildDefinition, buildRecordDetailsView, emptyRecordDetails, findDefinition,
  normalizeDetailValue, suggestedTemplates, type DetailDefinition, type RecordDetails,
} from "../shared/record-details";

const h = vi.hoisted(() => ({
  client: null as any,
  calls: [] as Array<{ method: string; url: string; body?: any }>,
  failGets: false,
}));

const server = {
  defs: [] as DetailDefinition[],
  details: emptyRecordDetails() as RecordDetails,
};

function payload() {
  const view = buildRecordDetailsView({
    entityType: "profile", entityId: "car", record: { type: "vehicle" },
    definitions: server.defs, details: server.details, todayISO: "2026-11-21",
  });
  return { ...view, name: "Honda Civic", suggestions: suggestedTemplates(view.scopeTokens, server.defs) };
}

function fail(status: number, error: string): never {
  throw new Error(`${status}: ${error}`);
}

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/cache-bus", () => ({ invalidateDomains: vi.fn(async () => {}) }));
vi.mock("wouter", () => ({ Link: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a> }));
vi.mock("@/lib/queryClient", () => ({
  get queryClient() { return h.client; },
  apiRequest: vi.fn(async (method: string, url: string, body?: any) => {
    h.calls.push({ method, url, body });
    const json = (v: unknown) => ({ json: async () => v }) as any;
    if (method === "GET" && h.failGets) fail(500, "boom");
    if (method === "GET" && url === "/api/details/definitions") return json({ definitions: server.defs, usage: {} });
    if (method === "GET" && url === "/api/details/profile/car") return json(payload());
    const put = /^\/api\/details\/profile\/car\/([^/]+)$/.exec(url);
    if (put && (method === "PUT" || method === "DELETE")) {
      const def = server.defs.find((d) => d.id === put[1])!;
      if (method === "DELETE") {
        server.details = applyDetailChange(server.details, def.id, null, "2026-11-21T00:00:00Z");
      } else {
        const v = normalizeDetailValue(def, body.value);
        if (!v.ok) fail(400, v.error);
        server.details = applyDetailChange(server.details, def.id, v.value, "2026-11-21T00:00:00Z");
      }
      return json(payload());
    }
    if (method === "POST" && url === "/api/details/profile/car") {
      let def = findDefinition(server.defs, body.definition.label);
      if (!def) {
        const built = buildDefinition(body.definition, { id: body.definition.label.toLowerCase().replace(/\s+/g, "-"), now: "2026-11-21T00:00:00Z" });
        if (!built.ok) fail(400, built.error);
        def = built.value;
        server.defs = [...server.defs, def];
      }
      const v = normalizeDetailValue(def, body.value);
      if (!v.ok) fail(400, v.error);
      server.details = applyDetailChange(server.details, def.id, v.value, "2026-11-21T00:00:00Z");
      return json({ ...payload(), definition: def, createdDefinition: true });
    }
    fail(404, `unexpected ${method} ${url}`);
  }),
}));

import { RecordDetailsPanel } from "../client/src/components/details/RecordDetailsPanel";

function renderPanel() {
  h.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={h.client}>
      <RecordDetailsPanel entityType="profile" entityId="car" />
    </QueryClientProvider>,
  );
}

const writes = () => h.calls.filter((c) => c.method !== "GET");

beforeEach(() => {
  h.calls.length = 0;
  h.failGets = false;
  const condition = buildDefinition({ label: "Condition", kind: "condition", appliesTo: ["vehicle"] }, { id: "condition", now: "2026-01-01T00:00:00Z" });
  if (!condition.ok) throw new Error(condition.error);
  server.defs = [condition.value];
  server.details = applyDetailChange(emptyRecordDetails(), "condition", "Good", "2026-01-01T00:00:00Z");
});
afterEach(cleanup);

describe("RecordDetailsPanel", () => {
  it("shows the record's characteristics and writes nothing on open", async () => {
    renderPanel();
    const row = await screen.findByTestId("record-detail-condition");
    expect(within(row).getByTestId("detail-input-condition-Good").getAttribute("aria-checked")).toBe("true");
    expect(writes()).toEqual([]);
  });

  it("a tap on the scale saves the structured value and keeps what it was", async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId("detail-input-condition-Fair"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: "PUT", url: "/api/details/profile/car/condition", body: { value: "Fair" } });
    await waitFor(() => expect(screen.getByTestId("detail-input-condition-Fair").getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByTestId("record-detail-prev-condition").textContent).toMatch(/was Good/);
  });

  it("removing a value takes two taps", async () => {
    renderPanel();
    const x = await screen.findByTestId("record-detail-remove-condition");
    fireEvent.click(x);
    expect(writes()).toEqual([]);
    expect(x.textContent).toMatch(/Remove\?/);
    fireEvent.click(x);
    await waitFor(() => expect(writes()).toEqual([{ method: "DELETE", url: "/api/details/profile/car/condition", body: undefined }]));
    await waitFor(() => expect(screen.queryByTestId("record-detail-condition")).toBeNull());
  });

  it("'Add detail' defines a new typed characteristic on the spot", async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId("record-details-add"));
    const dialog = await screen.findByTestId("add-detail-dialog");
    fireEvent.change(within(dialog).getByTestId("add-detail-name"), { target: { value: "Tire tread" } });
    fireEvent.click(within(dialog).getByTestId("add-detail-kind-condition"));
    // Default scope is the record's own kind.
    expect(within(dialog).getByTestId("add-detail-scope-vehicle").getAttribute("aria-checked")).toBe("true");
    const save = within(dialog).getByTestId("add-detail-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true); // no value yet
    fireEvent.click(within(dialog).getByTestId("add-detail-value-Fair"));
    fireEvent.click(save);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      method: "POST",
      url: "/api/details/profile/car",
      body: { definition: { label: "Tire tread", kind: "condition", appliesTo: ["vehicle"] }, value: "Fair" },
    });
    await waitFor(() => expect(screen.getByTestId("record-detail-tire-tread")).toBeTruthy());
  });

  it("typing an existing characteristic's name reuses it instead of asking for a type", async () => {
    server.details = emptyRecordDetails();
    renderPanel();
    fireEvent.click(await screen.findByTestId("record-details-add"));
    const dialog = await screen.findByTestId("add-detail-dialog");
    fireEvent.change(within(dialog).getByTestId("add-detail-name"), { target: { value: "condition" } });
    expect(within(dialog).getByTestId("add-detail-existing").textContent).toMatch(/existing Condition/);
    expect(within(dialog).queryByTestId("add-detail-kinds")).toBeNull();
    fireEvent.click(within(dialog).getByTestId("add-detail-value-Excellent"));
    fireEvent.click(within(dialog).getByTestId("add-detail-save"));
    await waitFor(() => expect(writes()[0]?.body).toEqual({ definition: { label: "Condition" }, value: "Excellent" }));
  });

  it("a failed load is an error with a retry, not 'no details'", async () => {
    h.failGets = true;
    renderPanel();
    expect(await screen.findByTestId("record-details-error")).toBeTruthy();
    expect(screen.queryByTestId("record-details-empty")).toBeNull();
  });
});
