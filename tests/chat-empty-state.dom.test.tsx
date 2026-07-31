// @vitest-environment jsdom
//
// The chat empty state. Four defects were visible in one screenshot:
//
//   1. the logo hung off the top of the scroll box
//   2. the welcome bubble was sliced mid-sentence
//   3. a screen of dead space between them
//   4. the hero and the bubble said the same thing twice
//
// 1–3 were all the same cause — a `min-h-[72vh] flex flex-col justify-end`
// container with a `flex-1` hero, plus the chips rendering OUTSIDE the scroll
// box. Those are layout facts a jsdom test cannot see (no layout engine), so
// they're covered by a Playwright bounds check in the harness. What IS testable
// here is the structure that caused them, and the content contract.

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ChatSuggestions, ChatFollowUps } from "../client/src/components/chat/ChatSuggestions";
import { buildChatSuggestions, buildFollowUps } from "../shared/chat-suggestions";

afterEach(cleanup);

const NOW = new Date("2026-07-31T08:30:00");
const inDays = (n: number) => {
  const d = new Date(NOW.getTime() + n * 86400000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const SUGGESTIONS = buildChatSuggestions({
  now: NOW,
  habits: [{ id: "h1", name: "morning walk", frequency: "daily", checkins: [] } as any],
  obligations: [{ id: "o1", name: "Progressive Auto", amount: 155, nextDueDate: inDays(1) }],
}, 6);

describe("chat empty state", () => {
  it("greets by name and summarises with COUNTS, not a repeat of the list", () => {
    // The first version echoed the top two suggestions verbatim directly above
    // cards saying exactly that — the duplicate-information problem the
    // Executive tab was rebuilt to remove.
    render(<ChatSuggestions suggestions={SUGGESTIONS} name="Robert" now={NOW} onPick={() => {}} />);
    const root = screen.getByTestId("chat-suggestions");
    expect(root.textContent).toContain("Good morning, Robert.");
    expect(root.textContent).toContain("2 things need you");
    // The summary must not restate a suggestion's full label + reason.
    expect(root.textContent).not.toContain("Mark morning walk done · still due today");
  });

  it("shows each suggestion's reason, so it reads as an observation", () => {
    render(<ChatSuggestions suggestions={SUGGESTIONS} name="Robert" now={NOW} onPick={() => {}} />);
    expect(screen.getByTestId("chat-suggestion-habit:h1").textContent).toContain("still due today");
    expect(screen.getByTestId("chat-suggestion-bill:o1").textContent).toContain("tomorrow");
  });

  it("submits the suggestion's TEXT, which may differ from its label", () => {
    // The chip reads "Pay Progressive Auto"; the message carries the amount, so
    // the parser gets everything it needs.
    const onPick = vi.fn();
    render(<ChatSuggestions suggestions={SUGGESTIONS} name="Robert" now={NOW} onPick={onPick} />);
    fireEvent.click(screen.getByTestId("chat-suggestion-bill:o1"));
    expect(onPick).toHaveBeenCalledWith("Pay Progressive Auto $155");
  });

  it("greets without a name when the scope is Everyone", () => {
    render(<ChatSuggestions suggestions={SUGGESTIONS} now={NOW} onPick={() => {}} />);
    expect(screen.getByTestId("chat-suggestions").textContent).toContain("Good morning.");
  });

  it("falls back to a plain invitation when nothing is pending", () => {
    const quiet = buildChatSuggestions({ now: NOW });
    render(<ChatSuggestions suggestions={quiet} now={NOW} onPick={() => {}} />);
    const root = screen.getByTestId("chat-suggestions");
    expect(root.textContent).toContain("Ask me anything, or start with one of these.");
    expect(root.textContent).not.toContain("need");
  });

  it("keeps the logo decorative — the greeting is the heading", () => {
    // alt="" so a screen reader hears "Good morning, Robert." rather than the
    // brand name twice.
    const { container } = render(
      <ChatSuggestions suggestions={SUGGESTIONS} name="Robert" now={NOW} onPick={() => {}} />);
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
  });
});

describe("follow-ups after a reply", () => {
  it("renders nothing when the reply did nothing", () => {
    const { container } = render(<ChatFollowUps suggestions={[]} onPick={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("offers the next step and submits it", () => {
    const onPick = vi.fn();
    const fu = buildFollowUps([{ type: "log_entry", data: { _trackerName: "Weight" } }]);
    render(<ChatFollowUps suggestions={fu} onPick={onPick} />);
    const chip = screen.getByTestId("chat-followup-fu:trend:Weight");
    expect(chip.textContent).toBe("What's my weight trend?");
    fireEvent.click(chip);
    expect(onPick).toHaveBeenCalledWith("What's my weight trend?");
  });
});

describe("the page no longer carries hardcoded demo copy", () => {
  // Comments are stripped before matching. The removed strings are QUOTED in
  // the comments that explain why they went — a guard that fires on its own
  // documentation is a guard people delete.
  const code = () => {
    const fs = require("fs");
    return fs.readFileSync("client/src/pages/chat.tsx", "utf8")
      .split("\n")
      // Note the `{`: a JSX comment opens with `{/*`, so a filter written for
      // plain JS comments walks straight past it.
      .filter((l: string) => !/^\s*(\{?\/\*|\/\/|\*)/.test(l))
      .join("\n");
  };

  it("has removed the SUGGESTIONS constant", () => {
    // The eight demo strings shown to every user on every visit.
    expect(code()).not.toContain("I ate a chicken sandwich and ran 2 miles");
    expect(code()).not.toContain("Add my cat Luna");
    expect(code()).not.toMatch(/^const SUGGESTIONS = \[/m);
  });

  it("no longer bottom-aligns the empty state inside a 72vh box", () => {
    // The single cause of BOTH the clipped logo and the dead space.
    expect(code()).not.toContain("min-h-[72vh]");
    expect(code()).not.toContain("chat-brand-hero");
  });
});
