// @vitest-environment jsdom
//
// Render smoke tests for the shared design kit — proves each surviving
// primitive mounts, renders its content, and fires its interaction, so the
// app-wide unification rests on components that are actually verified.
//
// Rewritten 2026-07-30. This file previously tested nine primitives that no
// page imported (FilterChip, DataTable, DashboardCard, CollapseArrow,
// IconButton, StatusBadge, ModalShell, PopupSection, ModalState) — a green
// suite proving that dead code worked. The components are deleted and the
// coverage moved to the ones the app actually renders.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MetricCard } from "../client/src/components/ui/metric-card";
import { EntityCard } from "../client/src/components/ui/entity-card";
import { SectionHeading } from "../client/src/components/ui/section-heading";
import { BubbleModal, BubbleRow } from "../client/src/components/ui/bubble-modal";
import { EmptyState } from "../client/src/components/ui/empty-state";
import { BubbleSkeleton, BubbleSkeletonGrid } from "../client/src/components/ui/skeleton";
import { PageContainer, PageHeader } from "../client/src/components/ui/page-shell";
import { Pill } from "../client/src/components/dashboard/visuals";
import { Activity, FileText, Target, TrendingDown } from "lucide-react";

vi.mock("wouter", () => ({ Link: ({ children }: any) => <>{children}</> }));

afterEach(cleanup);

describe("design kit", () => {
  it("MetricCard renders label + value and fires onClick", () => {
    const onClick = vi.fn();
    render(
      <MetricCard label="Net Worth" value="$284,650" accent="155 65% 45%" icon={Activity}
        sub="1.8% mo" onClick={onClick} testId="mc" />,
    );
    const el = screen.getByTestId("mc");
    expect(el.textContent).toContain("Net Worth");
    expect(el.textContent).toContain("$284,650");
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalled();
  });

  it("MetricCard activates by keyboard, not only by click", () => {
    // The dashboard's tracker card used to carry its own
    // onKeyDown={onEnterOrSpace(...)}; converting it to MetricCard dropped that
    // call-site handler because the component supplies one. If it ever stops,
    // every stat tile in the app becomes mouse-only.
    const onClick = vi.fn();
    render(<MetricCard label="Weight" value="183" accent="0 72% 58%" onClick={onClick} testId="mck" />);
    const el = screen.getByTestId("mck");
    expect(el.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(el, { key: "Enter" });
    fireEvent.keyDown(el, { key: " " });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("MetricCard is inert — and not press-styled — without onClick", () => {
    render(<MetricCard label="Streak" value="12" accent="25 90% 58%" testId="mc2" />);
    const el = screen.getByTestId("mc2");
    expect(el.getAttribute("role")).toBeNull();
    // A decorative container must not advertise a press it can't honour.
    expect(el.className).not.toContain("pressable");
  });

  it("MetricCard draws its progress bar with accessible bounds", () => {
    render(
      <MetricCard label="Streak" value="1" accent="25 90% 58%"
        progress={{ value: 1 / 7, caption: "6 to a 7-day streak" }} testId="mc3" />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("14");
    expect(screen.getByTestId("mc3").textContent).toContain("6 to a 7-day streak");
  });

  it("EntityCard renders title, headline, meta and footer pills", () => {
    render(
      <EntityCard
        accent="0 72% 55%" icon={TrendingDown} title="Progressive Auto"
        value="$155.00" valueUnit="bal"
        meta={[{ label: "Type", value: "Insurance" }]}
        pills={<Pill tone="critical">27d overdue</Pill>}
        testId="ec"
      />,
    );
    const el = screen.getByTestId("ec");
    expect(el.textContent).toContain("Progressive Auto");
    expect(el.textContent).toContain("$155.00");
    expect(el.textContent).toContain("Insurance");
    expect(el.textContent).toContain("27d overdue");
  });

  it("EntityCard drops the headline row entirely when there is no value", () => {
    // A document has no number worth shouting. The row must vanish rather than
    // render an empty 21px line that pushes the meta rows out of the card.
    render(
      <EntityCard accent="25 80% 54%" icon={FileText} title="Florida Driver License"
        meta={[{ label: "Format", value: "Image" }]} testId="ec2" />,
    );
    const el = screen.getByTestId("ec2");
    expect(el.querySelector(".metric-value")).toBeNull();
    expect(el.textContent).toContain("Florida Driver License");
  });

  it("SectionHeading renders title + count, and becomes a button when clickable", () => {
    const onClick = vi.fn();
    render(<SectionHeading title="Variable Liabilities" icon={TrendingDown}
      accent="0 72% 55%" count={4} onClick={onClick} expanded testId="sh" />);
    const el = screen.getByTestId("sh");
    expect(el.textContent).toContain("Variable Liabilities");
    expect(el.textContent).toContain("4");
    expect(el.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalled();
  });

  it("BubbleModal renders title + rows when open, nothing when closed", () => {
    const { rerender } = render(
      <BubbleModal open onClose={() => {}} title="Bills Due" icon={Activity}
        accent="25 90% 58%" count={2} testId="bm">
        <BubbleRow title="ChatGPT Pro" meta="today" testId="row-1" />
      </BubbleModal>,
    );
    expect(screen.getByTestId("bm").textContent).toContain("Bills Due");
    expect(screen.getByTestId("row-1").textContent).toContain("ChatGPT Pro");

    rerender(
      <BubbleModal open={false} onClose={() => {}} title="Bills Due" icon={Activity}
        accent="25 90% 58%" testId="bm">x</BubbleModal>,
    );
    expect(screen.queryByTestId("bm")).toBeNull();
  });

  it("BubbleRow is pressable only when it goes somewhere", () => {
    const onClick = vi.fn();
    const { rerender } = render(<BubbleRow title="Inert" testId="r1" />);
    expect(screen.getByTestId("r1").getAttribute("role")).toBeNull();

    rerender(<BubbleRow title="Live" onClick={onClick} testId="r2" />);
    const row = screen.getByTestId("r2");
    expect(row.getAttribute("role")).toBe("button");
    fireEvent.click(row);
    expect(onClick).toHaveBeenCalled();
  });

  it("EmptyState states the outcome and fires its CTA", () => {
    const onCta = vi.fn();
    render(<EmptyState tone="good" label="You're clear for 14 days"
      hint="Nothing due before Aug 13." ctaLabel="Add a bill" onCta={onCta} />);
    expect(screen.getByTestId("empty-state-title").textContent).toBe("You're clear for 14 days");
    fireEvent.click(screen.getByTestId("empty-state-cta"));
    expect(onCta).toHaveBeenCalled();
  });

  it("BubbleSkeleton draws a card silhouette, not a grey bar", () => {
    const { container } = render(<BubbleSkeleton rows={2} height={178} />);
    const root = container.firstElementChild as HTMLElement;
    // It must BE a bubble, so the real card replaces it without a layout jump.
    expect(root.className).toContain("bubble");
    expect(root.style.height).toBe("178px");
    // Medallion circle + title + 2 meta bars + footer pill.
    expect(container.querySelectorAll(".skeleton-shimmer").length).toBeGreaterThanOrEqual(5);
    expect(container.querySelector(".rounded-full")).toBeTruthy();
  });

  it("BubbleSkeletonGrid staggers its shimmer so the grid doesn't pulse in lockstep", () => {
    const { container } = render(<BubbleSkeletonGrid count={3} />);
    const cards = container.querySelectorAll('[style*="--i"]');
    expect(cards.length).toBe(3);
    expect((cards[2] as HTMLElement).style.getPropertyValue("--i")).toBe("2");
  });

  it("PageHeader renders title + subtitle + back button + actions", () => {
    const onBack = vi.fn();
    render(
      <PageHeader title="Goals" subtitle="Track your targets" icon={Target} accent="262 70% 62%"
        onBack={onBack} actions={<button data-testid="hdr-action">+ New</button>} testId="ph" />,
    );
    expect(screen.getByTestId("ph").textContent).toContain("Goals");
    expect(screen.getByTestId("ph").textContent).toContain("Track your targets");
    expect(screen.getByTestId("hdr-action")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-back"));
    expect(onBack).toHaveBeenCalled();
  });

  it("PageContainer renders its children in one scroll frame", () => {
    render(<PageContainer width="5xl" testId="pc"><div>page-body</div></PageContainer>);
    expect(screen.getByTestId("pc").textContent).toContain("page-body");
  });
});
