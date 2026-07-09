// @vitest-environment jsdom
//
// Render smoke tests for the shared design kit — proves each primitive mounts,
// renders its content, and fires its interaction, so the app-wide unification
// rests on components that are actually verified.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MetricCard } from "../client/src/components/ui/metric-card";
import { ModalShell, PopupSection, ModalState } from "../client/src/components/ui/modal-shell";
import { FilterChip, StatusBadge, CollapseArrow, IconButton, DashboardCard, DataTable } from "../client/src/components/ui/kit";
import { EmptyState } from "../client/src/components/ui/empty-state";
import { PageContainer, PageHeader } from "../client/src/components/ui/page-shell";
import { Activity, Plus, Target } from "lucide-react";

vi.mock("wouter", () => ({ Link: ({ children }: any) => <>{children}</> }));

afterEach(cleanup);

describe("design kit", () => {
  it("MetricCard renders label + value and fires onClick", () => {
    const onClick = vi.fn();
    render(<MetricCard label="Net Worth" value="$284,650" hsl="155 65% 45%" icon={Activity} sub="1.8% mo" onClick={onClick} testId="mc" />);
    const el = screen.getByTestId("mc");
    expect(el.textContent).toContain("Net Worth");
    expect(el.textContent).toContain("$284,650");
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalled();
  });

  it("ModalShell renders title + children when open", () => {
    render(
      <ModalShell open onOpenChange={() => {}} title="Cash Flow" icon={Activity} accent="199 89% 60%" testId="shell">
        <PopupSection title="Inflow">body-content</PopupSection>
      </ModalShell>,
    );
    expect(screen.getByTestId("shell").textContent).toContain("Cash Flow");
    expect(screen.getByTestId("shell").textContent).toContain("body-content");
    expect(screen.getByTestId("shell").textContent).toContain("Inflow");
  });

  it("ModalShell is not in the DOM when closed", () => {
    render(<ModalShell open={false} onOpenChange={() => {}} title="Hidden" testId="shell2">x</ModalShell>);
    expect(screen.queryByTestId("shell2")).toBeNull();
  });

  it("ModalState renders loading / empty / error", () => {
    const { rerender } = render(<ModalState state="loading" rows={2} />);
    expect(screen.getByTestId("modal-loading")).toBeTruthy();
    rerender(<ModalState state="empty" label="No bills" />);
    expect(screen.getByText("No bills")).toBeTruthy();
    rerender(<ModalState state="error" />);
    expect(screen.getByText("Something went wrong")).toBeTruthy();
  });

  it("FilterChip reflects active state and fires onClick", () => {
    const onClick = vi.fn();
    render(<FilterChip active onClick={onClick} testId="chip">Dining</FilterChip>);
    const chip = screen.getByTestId("chip");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalled();
  });

  it("StatusBadge renders its tone content", () => {
    render(<StatusBadge tone="neg" testId="sb">Overdue</StatusBadge>);
    expect(screen.getByTestId("sb").textContent).toContain("Overdue");
  });

  it("CollapseArrow rotates when open", () => {
    const { container, rerender } = render(<CollapseArrow open={false} />);
    expect(container.querySelector(".rotate-180")).toBeNull();
    rerender(<CollapseArrow open={true} />);
    expect(container.querySelector(".rotate-180")).toBeTruthy();
  });

  it("IconButton fires onClick with an accessible label", () => {
    const onClick = vi.fn();
    render(<IconButton icon={Plus} label="Add expense" onClick={onClick} testId="ib" />);
    const btn = screen.getByTestId("ib");
    expect(btn.getAttribute("aria-label")).toBe("Add expense");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it("DashboardCard renders children", () => {
    render(<DashboardCard testId="dc">neutral-card</DashboardCard>);
    expect(screen.getByTestId("dc").textContent).toContain("neutral-card");
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

  it("DataTable renders rows and fires onRowClick; shows empty slot when no rows", () => {
    const onRowClick = vi.fn();
    const rows = [{ id: "a", name: "Rent", amount: 2400 }];
    const { rerender } = render(
      <DataTable
        testId="dt"
        columns={[
          { key: "name", header: "Name", cell: (r: any) => r.name },
          { key: "amt", header: "Amount", align: "right", cell: (r: any) => `$${r.amount}` },
        ]}
        rows={rows}
        rowKey={(r: any) => r.id}
        onRowClick={onRowClick}
      />,
    );
    expect(screen.getByTestId("dt").textContent).toContain("Rent");
    expect(screen.getByTestId("dt").textContent).toContain("$2400");
    fireEvent.click(screen.getByText("Rent"));
    expect(onRowClick).toHaveBeenCalled();
    rerender(
      <DataTable testId="dt2" columns={[{ key: "name", header: "Name", cell: (r: any) => r.name }]}
        rows={[]} rowKey={(r: any) => r.id} empty={<EmptyState label="No data" />} />,
    );
    expect(screen.getByText("No data")).toBeTruthy();
  });
});
