// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));

vi.mock("@/lib/queryClient", () => ({ apiRequest }));
vi.mock("recharts", () => {
  const Box = ({ children }: any) => <div>{children}</div>;
  return {
    ResponsiveContainer: Box,
    BarChart: Box,
    Bar: Box,
    LineChart: Box,
    Line: Box,
    AreaChart: Box,
    Area: Box,
    PieChart: Box,
    Pie: Box,
    Cell: Box,
    XAxis: Box,
    YAxis: Box,
    Tooltip: Box,
    CartesianGrid: Box,
  };
});

import {
  ArtifactPanel,
  chartSourceRequestPath,
  normalizeChartSourceRows,
  selectChartDisplayData,
} from "../client/src/components/ArtifactPanel";

function json(body: any) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function renderArtifact(type: string, data: any) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ArtifactPanel artifact={{ type, title: "Audit artifact", data }} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue(json({ entries: [] }));
});

afterEach(cleanup);

describe("artifact chart sources", () => {
  it("builds a tracker-detail request from source.ref and rejects unsupported kinds", () => {
    expect(chartSourceRequestPath({ kind: "tracker", ref: "tracker/id" }))
      .toBe("/api/trackers/tracker%2Fid");
    expect(chartSourceRequestPath({ kind: "expense", ref: "tracker/id" })).toBeNull();
    expect(chartSourceRequestPath({ kind: "tracker", ref: " " })).toBeNull();
  });

  it("unwraps tracker entries and safely falls back to inline rows", () => {
    const series = [{ key: "weight" }];
    expect(normalizeChartSourceRows({
      entries: [{ timestamp: "2026-09-03T12:00:00Z", values: { weight: 172 } }],
    }, series)).toEqual([
      expect.objectContaining({ name: "2026-09-03T12:00:00Z", weight: 172 }),
    ]);

    const inline = [{ name: "Inline", weight: 170 }];
    expect(selectChartDisplayData({ error: "bad shape" }, inline, series)).toBe(inline);
    expect(selectChartDisplayData({ entries: [] }, inline, series)).toBe(inline);
  });

  it("requests the referenced tracker rather than the tracker list", async () => {
    apiRequest.mockResolvedValue(json({
      entries: [{ timestamp: "2026-09-03T12:00:00Z", values: { weight: 172 } }],
    }));
    renderArtifact("chart", {
      chartType: "bar",
      source: { kind: "tracker", ref: "tracker-1" },
      series: [{ key: "weight" }],
      data: [{ name: "Inline", weight: 170 }],
    });

    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("GET", "/api/trackers/tracker-1"));
    expect(apiRequest).not.toHaveBeenCalledWith("GET", "/api/trackers");
  });
});

describe("unfinished artifact controls", () => {
  it("labels task conversion and plan actions as non-interactive previews", () => {
    const checklist = renderArtifact("checklist", {
      items: [{ text: "One" }],
      convert_to_tasks: true,
    });
    expect(screen.getByTestId("artifact-checklist-preview-only").textContent).toContain("preview only");
    expect(screen.queryByRole("button", { name: "Create as Tasks" })).toBeNull();
    checklist.unmount();

    renderArtifact("structured_plan", {
      sections: [],
      actions: [{ label: "Start plan" }],
    });
    expect(screen.getByTestId("artifact-plan-preview-only").textContent).toContain("preview only");
    expect(screen.queryByRole("button", { name: "Start plan" })).toBeNull();
    expect(screen.getByLabelText("Start plan (preview only)")).toBeTruthy();
  });

  it("does not present calculator inputs or quick-entry fields as working controls", () => {
    const calculator = renderArtifact("calculator", {
      inputs: [{ key: "principal", label: "Principal", value: 100, editable: true }],
      outputs_schema: [{ key: "total", label: "Total" }],
    });
    expect(screen.getByTestId("artifact-calculator-preview-only").textContent).toContain("Live calculations are not available");
    expect((screen.getByLabelText("Principal (preview only)") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Not calculated")).toBeTruthy();
    calculator.unmount();

    renderArtifact("quick_entry_form", {
      fields: [
        { key: "name", label: "Name", type: "text" },
        { key: "details", label: "Details", type: "textarea" },
        { key: "done", label: "Done", type: "boolean" },
      ],
      submit_label: "Log entry",
    });
    expect(screen.getByTestId("artifact-form-preview-only").textContent).toContain("preview only");
    expect(screen.queryByRole("button", { name: "Log entry" })).toBeNull();
    expect((screen.getByLabelText("Name (preview only)") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Details (preview only)") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByLabelText("Done (preview only)") as HTMLButtonElement).disabled).toBe(true);
  });
});
