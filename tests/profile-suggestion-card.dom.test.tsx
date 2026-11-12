// @vitest-environment jsdom
//
// The optional "Would you also like to create a profile for Bob?" card
// (user spec 2026-11-12). Yes sends an explicit request in the user's words;
// No writes nothing at all.
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ProfileSuggestionCard } from "../client/src/components/chat/ProfileSuggestionCard";
import { hasExplicitProfileCreateIntent } from "../shared/profile-intent";

afterEach(cleanup);

describe("ProfileSuggestionCard", () => {
  it("asks, and Yes sends an explicit request", () => {
    const onYes = vi.fn(); const onNo = vi.fn();
    render(<ProfileSuggestionCard suggestion={{ name: "Bob", type: "person" }} onYes={onYes} onNo={onNo} />);
    expect(screen.getByText(/Would you also like to create a profile for/)).toBeTruthy();
    expect(screen.getByText("Optional")).toBeTruthy();
    fireEvent.click(screen.getByTestId("profile-suggestion-yes"));
    expect(onYes).toHaveBeenCalledWith("Create a person profile for Bob");
    expect(hasExplicitProfileCreateIntent(onYes.mock.calls[0][0])).toBe(true);
    expect(onNo).not.toHaveBeenCalled();
  });

  it("No only closes the card", () => {
    const onYes = vi.fn(); const onNo = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch" as any).mockImplementation(() => { throw new Error("No must not write"); });
    render(<ProfileSuggestionCard suggestion={{ name: "Max", type: "pet" }} onYes={onYes} onNo={onNo} />);
    fireEvent.click(screen.getByTestId("profile-suggestion-no"));
    expect(onNo).toHaveBeenCalledTimes(1);
    expect(onYes).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("the chat page shows it under the latest reply and Yes sends through handleSend", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync("client/src/pages/chat.tsx", "utf8");
    expect(src).toMatch(/profileSuggestions: data\.profileSuggestions/);
    expect(src).toMatch(/<ProfileSuggestionCard[\s\S]{0,200}handleSend\(text\)/);
  });
});
