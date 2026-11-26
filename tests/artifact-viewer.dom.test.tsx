// @vitest-environment jsdom
//
// Owner, 2026-11-26: an artifact made in chat opened as a half-width pane
// reading "Unknown artifact type: markdown". An artifact now opens FULL SCREEN
// in one viewer (chat and the Artifacts tab alike): the whole artifact, an X,
// a star, Share, and its own controls working (a checklist box is written to
// the stored row). Opening it writes nothing (Rule 3).
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

const calls: Array<{ method: string; url: string; body?: any }> = [];
let respond: (method: string, url: string, body?: any) => any = () => [];

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/theme-provider", () => ({ useTheme: () => ({ resolvedMode: "dark" }) }));
vi.mock("@/hooks/useProfileScope", () => ({ useProfileScope: () => ({ mode: "everyone", selectedIds: [], selectedNames: [], isFiltered: false }) }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}) }) }));
vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    BROWSER_TIMEZONE: "America/Los_Angeles",
    queryClient: new QueryClient(),
    apiRequest: vi.fn(async (method: string, url: string, body?: any) => {
      calls.push({ method, url, body });
      const data = await respond(method, url, body);
      return { ok: true, json: async () => data, blob: async () => new Blob(["x"]) };
    }),
  };
});

import { ArtifactViewer } from "../client/src/components/artifacts/ArtifactViewer";
import { ArtifactPanel } from "../client/src/components/ArtifactPanel";
import ArtifactsPage, { rowWhen } from "../client/src/pages/artifacts";
import { artifactFile, artifactPlainText, sheetToCsv } from "../client/src/lib/artifact-share";

const writes = () => calls.filter((c) => c.method !== "GET");

const MARKDOWN = {
  id: "md-1", type: "markdown", title: "Sleep & Wellness Plan",
  content: "# Sleep & Wellness Plan\n\n**Biggest gap:** No sleep tracking yet.\n\n| Habit | Status |\n| --- | --- |\n| Morning Run | Perfect |",
  items: [], tags: [], linkedProfiles: [], pinned: false,
  createdAt: "2026-11-25T10:00:00.000Z", updatedAt: "2026-11-25T10:00:00.000Z",
};
const CHECKLIST = {
  id: "cl-1", type: "checklist", title: "Morning Routine", content: "",
  items: [{ id: "i1", text: "Drink water", checked: false }, { id: "i2", text: "Stretch", checked: true }],
  tags: [], linkedProfiles: [], pinned: false,
  createdAt: "2026-11-25T10:00:00.000Z", updatedAt: "2026-11-25T10:00:00.000Z",
};

function client() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: async ({ queryKey }) => {
          const r = await (await import("@/lib/queryClient")).apiRequest("GET", String(queryKey[0]));
          return (r as any).json();
        },
      },
    },
  });
}

function mount(node: React.ReactElement) {
  return render(
    <QueryClientProvider client={client()}>
      <Router hook={() => ["/artifacts", () => {}] as any}>{node}</Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => { calls.length = 0; respond = (_m, url) => (url === "/api/artifacts" ? [MARKDOWN, CHECKLIST] : []); });
afterEach(cleanup);

describe("the artifact viewer opened from chat", () => {
  it("shows the whole markdown artifact full screen — never 'Unknown artifact type'", async () => {
    const onClose = vi.fn();
    mount(<ArtifactViewer artifact={MARKDOWN} from="chat" onClose={onClose} />);
    const viewer = await screen.findByTestId("artifact-viewer");
    expect(within(viewer).getByTestId("artifact-viewer-title").textContent).toBe("Sleep & Wellness Plan");
    const body = within(viewer).getByTestId("artifact-viewer-body");
    expect(within(body).getByTestId("artifact-markdown")).toBeTruthy();
    expect(body.textContent).toContain("No sleep tracking yet.");
    // The GFM table is a table, not pipes.
    expect(body.querySelector("table")).toBeTruthy();
    expect(screen.queryByText(/Unknown artifact type/)).toBeNull();
    // Star and Share are there; the X closes.
    expect(within(viewer).getByTestId("button-artifact-viewer-star")).toBeTruthy();
    expect(within(viewer).getByTestId("button-artifact-share")).toBeTruthy();
    fireEvent.click(within(viewer).getByTestId("button-artifact-viewer-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Opening and closing wrote nothing.
    expect(writes()).toEqual([]);
  });

  it("the old side panel draws a markdown artifact too (no 'Unknown artifact type')", () => {
    mount(<ArtifactPanel artifact={MARKDOWN} onClose={() => {}} />);
    expect(screen.queryByText(/Unknown artifact type/)).toBeNull();
    expect(screen.getByTestId("artifact-markdown").textContent).toContain("No sleep tracking yet.");
  });

  it("a checklist is interactive: a tap is written to the stored row through the toggle route", async () => {
    respond = (method, url) => {
      if (url === "/api/artifacts") return [MARKDOWN, CHECKLIST];
      if (method === "POST") return { ...CHECKLIST, items: [{ ...CHECKLIST.items[0], checked: true }, CHECKLIST.items[1]] };
      return [];
    };
    mount(<ArtifactViewer artifact={CHECKLIST} from="chat" onClose={() => {}} />);
    await screen.findByTestId("artifact-checklist");
    expect(screen.getByText("1 of 2 done")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId("artifact-checklist-item-0")); });
    await waitFor(() => expect(writes().map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/artifacts/cl-1/toggle/i1"]));
  });

  it("an HTML artifact runs in a sandbox with scripts but no access to this origin", async () => {
    const html = { ...MARKDOWN, id: "h-1", type: "html", content: "<button onclick='1'>Go</button>" };
    respond = (_m, url) => (url === "/api/artifacts" ? [html] : []);
    mount(<ArtifactViewer artifact={html} from="chat" onClose={() => {}} />);
    const frame = await screen.findByTestId("artifact-html-frame");
    const sandbox = frame.getAttribute("sandbox") || "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    // It runs in the frame page with its own CSP (the app's would block the
    // artifact's inline scripts in a srcdoc frame), not as srcdoc.
    expect(frame.getAttribute("src")).toBe("/artifact-frame.html");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    // When the frame says it is ready, the HTML is posted to THAT window only.
    const win = (frame as HTMLIFrameElement).contentWindow!;
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
    window.dispatchEvent(new MessageEvent("message", { data: { type: "portol-artifact-frame-ready" }, source: window as any }));
    expect(post).not.toHaveBeenCalled();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "portol-artifact-frame-ready" }, source: win as any }));
    expect(post).toHaveBeenCalledWith({ type: "portol-artifact-html", html: html.content }, "*");
  });

  it("the frame page lets the artifact's scripts run but reaches nothing else", async () => {
    const fs = await import("node:fs");
    const cfg = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
    const rule = cfg.headers.find((h: any) => h.source === "/artifact-frame.html");
    const csp = rule.headers.find((h: any) => h.key === "Content-Security-Policy").value as string;
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    // The app's own policy does not also apply to the frame page.
    const app = cfg.headers.find((h: any) => /assets\/\|api\//.test(h.source));
    expect(new RegExp(`^${app.source.replace(/\(\(\?!/, "((?!")}$`).test("/artifact-frame.html")).toBe(false);
    expect(fs.readFileSync("client/public/artifact-frame.html", "utf8")).toContain("e.source !== window.parent");
  });
});

describe("the Artifacts tab", () => {
  it("opens an artifact in the full-screen viewer, and every card can be shared", async () => {
    mount(<ArtifactsPage />);
    const card = await screen.findByTestId("artifact-card-md-1");
    expect(within(card).getByTestId("button-artifact-share")).toBeTruthy();
    fireEvent.click(card);
    const viewer = await screen.findByTestId("artifact-viewer");
    expect(within(viewer).getByTestId("artifact-viewer-body").textContent).toContain("No sleep tracking yet.");
    expect(writes()).toEqual([]);
  });

  it("Grid, List and Gallery show the same artifacts; the view never hides one", async () => {
    mount(<ArtifactsPage />);
    await screen.findByTestId("artifact-card-md-1");
    const count = () => screen.queryAllByTestId(/^artifact-card-/).length;
    expect(count()).toBe(2);
    for (const v of ["list", "gallery", "grid"]) {
      fireEvent.click(screen.getByTestId(`view-${v}`));
      expect(count()).toBe(2);
    }
    expect(writes()).toEqual([]);
  });

  it("the Checklists chip promises exactly what it shows", async () => {
    mount(<ArtifactsPage />);
    await screen.findByTestId("artifact-card-md-1");
    expect(screen.getByTestId("filter-checklists").textContent).toContain("(1)");
    fireEvent.click(screen.getByTestId("filter-checklists"));
    await waitFor(() => expect(screen.queryAllByTestId(/^artifact-card-/).length).toBe(1));
    expect(screen.getByTestId("artifact-card-cl-1")).toBeTruthy();
  });
});

describe("the List view (owner's design, 2026-11-26)", () => {
  const PDF = {
    id: "d-pdf", name: "Resume.pdf", title: "Résumé", type: "other", mimeType: "application/pdf",
    createdAt: "2026-11-25T22:42:00.000Z", linkedProfiles: [], extractedData: { name: "Avery Chen" }, tags: ["plan", "career"], hasFile: true,
  };
  beforeEach(() => {
    try { localStorage.setItem("portol_artifacts_view", "list"); } catch { /* jsdom */ }
    respond = (_m, url) => (url === "/api/artifacts" ? [{ ...MARKDOWN, source: "chat", tags: ["sleep", "energy"] }] : url === "/api/documents" ? [PDF] : []);
  });
  afterEach(() => { try { localStorage.removeItem("portol_artifacts_view"); } catch { /* jsdom */ } });

  it("each row names its kind, format and time, shows its tags and a Send button", async () => {
    mount(<ArtifactsPage />);
    const row = await screen.findByTestId("artifact-card-d-pdf");
    expect(within(row).getByTestId("artifact-row-meta-d-pdf").textContent).toMatch(/^Document · PDF · /);
    expect(within(row).getAllByText("#plan").length).toBeGreaterThan(0);
    expect(within(row).getAllByText("Send").length).toBeGreaterThan(0);
    const note = screen.getByTestId("artifact-card-md-1");
    expect(within(note).getByTestId("artifact-row-meta-md-1").textContent).toMatch(/^AI Note · /);
    expect(screen.getAllByText(/Gallery shows larger previews/).length).toBeGreaterThan(0);
  });

  it("a file preview downloads nothing until its row is on screen, and opening the list writes nothing", async () => {
    mount(<ArtifactsPage />);
    await screen.findByTestId("artifact-card-d-pdf");
    expect(calls.some((c) => c.url.includes("/file"))).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("dates read like the design", () => {
    const now = new Date("2026-11-26T12:00:00");
    expect(rowWhen("2026-11-26T16:42:00", now)).toMatch(/^Today, /);
    expect(rowWhen("2026-11-25T14:16:00", now)).toMatch(/^Yesterday, /);
    expect(rowWhen("2026-09-01T10:24:00", now)).toMatch(/^Sep 1, /);
    expect(rowWhen("2025-09-01T10:24:00", now)).toMatch(/2025/);
  });
});

describe("sending an artifact anywhere", () => {
  it("writes a checklist as readable text with its boxes", () => {
    expect(artifactPlainText(CHECKLIST)).toBe("Morning Routine\n\n☐ Drink water\n☑ Stretch");
  });

  it("names each file by its kind", () => {
    expect(artifactFile(MARKDOWN).name).toBe("Sleep & Wellness Plan.md");
    expect(artifactFile({ title: "Script", type: "code", language: "python", content: "print(1)" }).name).toBe("Script.py");
    expect(artifactFile({ title: "Budget", type: "sheet", sheetData: { rows: 2, cols: 2, cells: {} } }).name).toBe("Budget.csv");
  });

  it("a sheet becomes CSV over its used area, quoting what needs it", () => {
    const csv = sheetToCsv({ rows: 10, cols: 10, cells: { "0,0": { v: "Item" }, "0,1": { v: "Cost" }, "1,0": { v: "Rent, May" }, "1,1": { v: 1200 } } });
    expect(csv).toBe('Item,Cost\n"Rent, May",1200');
  });
});
