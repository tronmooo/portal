// @vitest-environment jsdom
//
// Both profile detail pages had their headers replaced in one pass: the avatar
// upload, Edit, Delete, Pay, Back and the stat tiles were all lifted out of two
// hand-rolled gradient banners into one shared DetailHero.
//
// A restructure like that can leave every control rendering perfectly and wired
// to nothing, and neither tsc nor a source-grep guard would notice — the
// grep-based guards in tests/detail-hero.test.ts prove the treatment changed,
// not that the buttons still do anything.
//
// The riskiest piece is the file input. It used to be rendered unconditionally
// next to the avatar button; it is now conditional on the caller passing BOTH
// `avatar` and `avatar.inputRef`. If that plumbing is wrong the avatar button
// opens nothing, silently.

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Router } from "wouter";
import { Package, FileText, CheckCircle2, DollarSign } from "lucide-react";
import { DetailHero, type HeroStat } from "../client/src/components/profile/DetailHero";

afterEach(cleanup);

const wrap = (ui: React.ReactNode) => render(<Router>{ui}</Router>);

describe("the header's actions still reach their handlers", () => {
  it("fires Back", () => {
    const onBack = vi.fn();
    wrap(<DetailHero title="ChatGPT Pro" accent="0 72% 55%" icon={Package} onBack={onBack} />);
    fireEvent.click(screen.getByTestId("button-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders Back as a real link when given an href, so it is shareable", () => {
    wrap(<DetailHero title="iPhone" accent="262 60% 62%" icon={Package} backHref="/trackers" />);
    expect(screen.getByTestId("button-back").getAttribute("href")).toBe("/trackers");
  });

  it("renders whatever actions the page passes, and they fire", () => {
    // Edit / Delete / Pay live with the page, not the hero — the hero only has
    // to give them somewhere consistent to sit and not swallow their clicks.
    const edit = vi.fn(), del = vi.fn(), pay = vi.fn();
    wrap(
      <DetailHero
        title="ChatGPT Pro" accent="0 72% 55%" icon={Package}
        actions={<>
          <button data-testid="button-header-edit-profile" onClick={edit}>Edit</button>
          <button data-testid="button-delete-profile" onClick={del}>Delete</button>
          <button data-testid="quick-pay-min" onClick={pay}>Pay</button>
        </>}
      />);
    fireEvent.click(screen.getByTestId("button-header-edit-profile"));
    fireEvent.click(screen.getByTestId("button-delete-profile"));
    fireEvent.click(screen.getByTestId("quick-pay-min"));
    expect(edit).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(1);
    expect(pay).toHaveBeenCalledTimes(1);
  });
});

describe("avatar upload — the conditional file input", () => {
  const renderWithAvatar = (over: Record<string, any> = {}) => {
    const onPick = vi.fn();
    const onChange = vi.fn();
    const inputRef = React.createRef<HTMLInputElement>();
    const out = wrap(
      <DetailHero
        title="iPhone" accent="262 60% 62%" icon={Package}
        avatar={{ src: null, onPick, busy: false, inputRef, onChange, ...over }}
      />);
    return { onPick, onChange, inputRef, ...out };
  };

  it("renders the file input, and it accepts images", () => {
    renderWithAvatar();
    const input = screen.getByTestId("input-avatar-upload") as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.accept).toBe("image/*");
  });

  it("hands the caller a live ref, so avatarInputRef.current.click() works", () => {
    // This is the actual failure mode: the button calls
    // `avatarInputRef.current?.click()`, and `?.` means a null ref fails
    // SILENTLY — the button would look fine and open nothing.
    const { inputRef } = renderWithAvatar();
    expect(inputRef.current).not.toBeNull();
    expect(inputRef.current).toBe(screen.getByTestId("input-avatar-upload"));
  });

  it("pressing the avatar calls onPick", () => {
    const { onPick } = renderWithAvatar();
    fireEvent.click(screen.getByTestId("button-avatar-upload"));
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("routes the chosen file to the page's handler", () => {
    const { onChange } = renderWithAvatar();
    fireEvent.change(screen.getByTestId("input-avatar-upload"), {
      target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("disables the avatar button while an upload is in flight", () => {
    renderWithAvatar({ busy: true });
    expect((screen.getByTestId("button-avatar-upload") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the uploaded image once there is one", () => {
    const { container } = renderWithAvatar({ src: "https://example.test/a.png" });
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.test/a.png");
  });
});

describe("stat tiles", () => {
  const stats = (over: Partial<HeroStat>[] = []): HeroStat[] => ([
    { label: "Docs", countTo: 0, icon: FileText, testId: "hero-stat-docs" },
    { label: "Tasks", countTo: 0, icon: CheckCircle2, testId: "hero-stat-tasks" },
    ...over as HeroStat[],
  ]);

  it("drops a count of zero entirely", () => {
    wrap(<DetailHero title="iPhone" accent="262 60% 62%" icon={Package} stats={stats()} />);
    expect(screen.queryByTestId("hero-stat-docs")).toBeNull();
    expect(screen.queryByTestId("hero-stat-tasks")).toBeNull();
  });

  it("keeps a count above zero", () => {
    wrap(<DetailHero title="iPhone" accent="262 60% 62%" icon={Package}
      stats={[{ label: "Docs", countTo: 3, icon: FileText, testId: "hero-stat-docs" }]} />);
    expect(screen.getByTestId("hero-stat-docs")).toBeTruthy();
  });

  it("keeps a TEXT stat that happens to read zero-ish — those mean something", () => {
    // "Autopay: Off" and "Status: Upcoming" are facts. Only `countTo` is
    // treated as droppable, which is why the two are separate props.
    wrap(<DetailHero title="ChatGPT Pro" accent="0 72% 55%" icon={Package}
      stats={[{ label: "Autopay", value: "Off", icon: DollarSign, testId: "kpi-bill-autopay" }]} />);
    expect(screen.getByTestId("kpi-bill-autopay").textContent).toContain("Off");
  });

  it("fires a tile's onClick when it has one", () => {
    const onClick = vi.fn();
    wrap(<DetailHero title="ChatGPT Pro" accent="0 72% 55%" icon={Package}
      stats={[{ label: "Payments", countTo: 2, onClick, testId: "kpi-payments" }]} />);
    fireEvent.click(screen.getByTestId("kpi-payments"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders no tile grid at all when every stat is empty", () => {
    const { container } = wrap(
      <DetailHero title="iPhone" accent="262 60% 62%" icon={Package} stats={stats()} />);
    // Not an empty grid holding whitespace — no grid.
    expect(container.querySelectorAll(".grid").length).toBe(0);
  });
});

describe("identity is stated once", () => {
  it("shows the title, the type chip and the subtitle", () => {
    wrap(<DetailHero
      title="ChatGPT Pro" accent="0 72% 55%" icon={Package}
      typeLabel="liability" subtitle="OpenAI · ····4821" />);
    expect(screen.getByTestId("detail-hero-title").textContent).toBe("ChatGPT Pro");
    const root = screen.getByTestId("detail-hero");
    expect(root.textContent).toContain("liability");
    expect(root.textContent).toContain("OpenAI · ····4821");
  });

  it("renders the breadcrumb the page gives it", () => {
    wrap(<DetailHero title="iPhone" accent="262 60% 62%" icon={Package}
      breadcrumb={<nav data-testid="crumbs">robert sennabaum</nav>} />);
    expect(screen.getByTestId("crumbs")).toBeTruthy();
  });

  it("carries the accent onto the surface, so the page keeps its colour", () => {
    wrap(<DetailHero testId="liability-hero" title="X" accent="0 72% 55%" icon={Package} />);
    expect(screen.getByTestId("liability-hero").getAttribute("style")).toContain("0 72% 55%");
  });
});
