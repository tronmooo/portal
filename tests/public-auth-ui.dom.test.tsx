// @vitest-environment jsdom
//
// Logged-out UI regressions confirmed in browser inspection on 2026-09-03:
// Forgot Password must participate in hash-router history, and the public
// feature carousel must be operable without relying on an imprecise drag.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import AuthPage, { OnboardingSection } from "../client/src/pages/auth";

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    signIn: vi.fn(),
    signUp: vi.fn(),
    signInWithGoogle: vi.fn(),
  }),
}));

vi.mock("@/lib/queryClient", () => ({
  apiRequest: vi.fn(),
}));

function renderAuth() {
  return render(
    <Router hook={useHashLocation}>
      <AuthPage />
    </Router>,
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/#/");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("logged-out public UI regression ledger", () => {
  it("BUG-20260903-forgot-password-history: creates a hash history entry and Back restores sign-in", async () => {
    renderAuth();

    fireEvent.click(screen.getByTestId("link-forgot-password"));
    expect(window.location.hash).toBe("#/auth/forgot-password");
    expect(screen.getByText("Reset your password")).toBeTruthy();

    act(() => window.history.back());

    await waitFor(() => {
      expect(window.location.hash).toBe("#/");
      expect(screen.getByText("Welcome back")).toBeTruthy();
    });
  });

  it("BUG-20260903-forgot-password-history: in-view Back returns a direct hash route to sign-in", () => {
    window.history.replaceState(null, "", "/#/auth/forgot-password");
    renderAuth();

    fireEvent.click(screen.getByTestId("link-back-to-signin-2"));

    expect(window.location.hash).toBe("#/auth");
    expect(screen.getByText("Welcome back")).toBeTruthy();
  });

  it("BUG-20260903-public-feature-carousel: supports controls, direct selection, keyboard, and contained touch scrolling", () => {
    render(<OnboardingSection onScrollToLogin={vi.fn()} />);

    const track = screen.getByRole("group", { name: "Feature cards" });
    const previous = screen.getByRole("button", { name: "Previous feature" });
    const next = screen.getByRole("button", { name: "Next feature" });

    expect((previous as HTMLButtonElement).disabled).toBe(true);
    expect(track.className).toContain("overflow-x-auto");
    expect(track.className).toContain("overscroll-x-contain");
    expect(track.className).toContain("touch-pan-x");
    expect(track.className).toContain("select-none");

    fireEvent.click(next);
    expect(screen.getByTestId("feature-card-1").getAttribute("aria-current")).toBe("true");
    expect((previous as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Show Documents" }));
    expect(screen.getByTestId("feature-card-3").getAttribute("aria-current")).toBe("true");

    fireEvent.keyDown(track, { key: "ArrowLeft" });
    expect(screen.getByTestId("feature-card-2").getAttribute("aria-current")).toBe("true");

    fireEvent.keyDown(track, { key: "End" });
    expect(screen.getByTestId("feature-card-5").getAttribute("aria-current")).toBe("true");
    expect((next as HTMLButtonElement).disabled).toBe(true);
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled();
  });
});
