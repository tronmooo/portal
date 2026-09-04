// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiRequestMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...actual, apiRequest: apiRequestMock };
});
vi.mock("@/lib/cache-bus", () => ({ invalidateDomains: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

import { QuickAddSection } from "../client/src/components/CalendarManagerPanel";
import { useCalendarOccurrences } from "../client/src/hooks/useCalendarOccurrences";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function testClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, queryFn: async () => [] },
      mutations: { retry: false },
    },
  });
}

afterEach(() => {
  cleanup();
  apiRequestMock.mockReset();
  toastMock.mockReset();
});

describe("Calendar Quick Add commit behavior", () => {
  it("keeps the draft and does not navigate when creation fails", async () => {
    apiRequestMock.mockRejectedValueOnce(new Error("offline"));
    const onCreated = vi.fn();
    const client = testClient();
    render(
      <QueryClientProvider client={client}>
        <QuickAddSection onCreated={onCreated} />
      </QueryClientProvider>,
    );

    const input = screen.getByTestId("quick-add-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Pay rent every month on the 1st $2500" } });
    fireEvent.click(screen.getByTestId("quick-add-submit"));

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't add", variant: "destructive" }),
    ));
    expect(input.value).toBe("Pay rent every month on the 1st $2500");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("clears and navigates only after creation succeeds", async () => {
    let resolveRequest!: (response: Response) => void;
    apiRequestMock.mockReturnValueOnce(new Promise((resolve) => { resolveRequest = resolve; }));
    const onCreated = vi.fn();
    const client = testClient();
    render(
      <QueryClientProvider client={client}>
        <QuickAddSection onCreated={onCreated} />
      </QueryClientProvider>,
    );

    const input = screen.getByTestId("quick-add-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Pay rent every month on the 1st $2500" } });
    fireEvent.click(screen.getByTestId("quick-add-submit"));

    expect(input.value).toBe("Pay rent every month on the 1st $2500");
    expect(onCreated).not.toHaveBeenCalled();
    resolveRequest(jsonResponse({ id: "created" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(input.value).toBe("");
  });
});

function CalendarProbe() {
  const result = useCalendarOccurrences();
  return (
    <div>
      <span data-testid="degraded">{String(result.isDegraded)}</span>
      <span data-testid="errors">{result.sourceErrors.map((e) => e.source).join(",")}</span>
    </div>
  );
}

describe("calendar source failure signaling", () => {
  it("exposes a rejected source instead of caching it as successful empty data", async () => {
    apiRequestMock.mockImplementation(async (_method: string, url: string) => {
      if (url.includes("/api/events")) throw new Error("events unavailable");
      return jsonResponse([]);
    });
    const client = testClient();
    render(
      <QueryClientProvider client={client}>
        <CalendarProbe />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("degraded").textContent).toBe("true"));
    expect(screen.getByTestId("errors").textContent).toContain("events");
    const eventState = client.getQueryState(["/api/events", "everyone"]);
    expect(eventState?.status).toBe("error");
    expect(eventState?.data).toBeUndefined();
  });
});
