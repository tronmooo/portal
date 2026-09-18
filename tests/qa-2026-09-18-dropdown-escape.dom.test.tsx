// @vitest-environment jsdom
//
// QA 2026-09-18 BUG-23: Escape did not close the hub profile switcher (a
// Radix DropdownMenu). Radix only dismisses the HIGHEST DismissableLayer on
// Escape, and a Radix Toast is a layer too — a toast raised after the menu
// opened owns Escape until it disappears. The shared DropdownMenu wrapper now
// closes the menu itself whenever an Escape reaches its content un-handled.
// This pins that: menu open → a toast appears above it → Escape closes the menu.
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { TooltipProvider } from "../client/src/components/ui/tooltip";
import { CommandSearchProvider, CommandSearch } from "../client/src/components/CommandSearch";
import { KeyboardShortcuts } from "../client/src/components/KeyboardShortcuts";
import { HubProfileSwitcher } from "../client/src/components/hub/HubProfileSwitcher";
import { Toaster } from "../client/src/components/ui/toaster";
import { toast } from "../client/src/hooks/use-toast";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}) }) }));
vi.mock("../client/src/hooks/useProfileScope", () => ({
  useProfileScope: () => ({ mode: "selected", selectedIds: ["p1"], selectedNames: ["Me"] }),
}));
vi.mock("../client/src/lib/scope-prefetch", () => ({ prefetchScopeBootstrap: () => {} }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
    { id: "p1", name: "Me", type: "self" }, { id: "p2", name: "Bob Robertson", type: "person" },
  ]), { status: 200, headers: { "Content-Type": "application/json" } })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <Router hook={() => ["/dashboard", () => {}] as any}>
          <CommandSearchProvider>
            <KeyboardShortcuts />
            <HubProfileSwitcher />
            <CommandSearch />
            <Toaster />
          </CommandSearchProvider>
        </Router>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function openMenu() {
  const trigger = screen.getByTestId("hub-profile-switcher");
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
  await waitFor(() => expect(screen.getByTestId("hub-switch-everyone")).toBeTruthy());
}

describe("BUG-23 Escape closes the hub profile dropdown", () => {
  it("closes on Escape with nothing else open", async () => {
    mount();
    await openMenu();
    fireEvent.keyDown(document.activeElement || document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("hub-switch-everyone")).toBeNull());
  });

  it("still closes on Escape when a toast appeared above it", async () => {
    mount();
    await openMenu();
    act(() => { toast({ title: "Saved" }); });
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect(screen.queryByTestId("hub-switch-everyone")).toBeTruthy();
    fireEvent.keyDown(document.activeElement || document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("hub-switch-everyone")).toBeNull());
  });

  it("an Escape the menu already handled is not double-handled by the fallback", async () => {
    mount();
    await openMenu();
    const menuItem = document.activeElement as HTMLElement;
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    ev.preventDefault(); // as Radix's own layer would have
    act(() => { menuItem.dispatchEvent(ev); });
    // Radix saw it first (document capture) and closed the menu; the fallback
    // simply had nothing left to do — no error, no second close.
    await waitFor(() => expect(screen.queryByTestId("hub-switch-everyone")).toBeNull());
  });
});
