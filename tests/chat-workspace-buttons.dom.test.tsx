// @vitest-environment jsdom
//
// The chat box's Notes / Journal / Document / Fill In buttons (owner request
// 2026-11-22): each OPENS its own full-screen workspace. They are not modes
// of the chat box — the box keeps its label, placeholder and Send. Files can
// be dropped onto the box. This renders the real composer and the real shell.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
const navigated: string[] = [];
vi.mock("@/lib/hashNavigate", () => ({ hashNavigate: (to: string) => { navigated.push(to); } }));

import { ChatComposer } from "../client/src/components/chat/ChatComposer";
import { WorkspaceShell, WORKSPACES, leaveWorkspace } from "../client/src/components/workspace/WorkspaceShell";

function Composer(props: Partial<React.ComponentProps<typeof ChatComposer>>) {
  return (
    <ChatComposer
      onSubmit={() => true}
      isPending={false}
      searchOpen={false}
      onToggleSearch={() => {}}
      onAttach={() => {}}
      showReset={false}
      onReset={() => {}}
      {...props}
    />
  );
}
afterEach(() => { cleanup(); navigated.length = 0; });

describe("workspace buttons in the chat box", () => {
  it("there are four, and each asks for its own workspace", () => {
    const open = vi.fn();
    render(<Composer onOpenWorkspace={open} />);
    for (const kind of ["notes", "journal", "document", "fill"] as const) {
      fireEvent.click(screen.getByTestId(`button-workspace-${kind}`));
    }
    expect(open.mock.calls.map((c) => c[0])).toEqual(["notes", "journal", "document", "fill"]);
    expect(screen.getByTestId("button-workspace-fill").textContent).toMatch(/Fill In/);
  });

  it("a button does not turn the chat box into something else", () => {
    const sent = vi.fn(() => true);
    render(<Composer onOpenWorkspace={() => {}} onSubmit={sent} />);
    fireEvent.click(screen.getByTestId("button-workspace-journal"));
    expect(screen.getByTestId("button-workspace-journal").getAttribute("aria-pressed")).toBeNull();
    expect(screen.queryByTestId("capture-hint")).toBeNull();
    expect(screen.getByTestId("button-send").textContent).toMatch(/Send/);
    fireEvent.change(screen.getByTestId("input-chat"), { target: { value: "what's on my calendar?" } });
    fireEvent.click(screen.getByTestId("button-send"));
    expect(sent).toHaveBeenCalledWith("what's on my calendar?");
  });

  it("every workspace has a route of its own; Document is the editor", () => {
    expect(WORKSPACES.notes.route).toBe("/workspace/notes");
    expect(WORKSPACES.journal.route).toBe("/workspace/journal");
    expect(WORKSPACES.fill.route).toBe("/workspace/fill");
    expect(WORKSPACES.document.route).toBe("/editor/new/doc?source=chat");
  });

  it("files dropped on the box are handed over; dragging text is left alone", () => {
    const dropped = vi.fn();
    render(<Composer onDropFiles={dropped} />);
    const zone = screen.getByTestId("chat-drop-zone");
    const file = new File(["%PDF"], "form.pdf", { type: "application/pdf" });
    fireEvent.dragOver(zone, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(screen.getByTestId("chat-drop-hint").textContent).toMatch(/Drop to attach/);
    fireEvent.drop(zone, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(dropped).toHaveBeenCalledTimes(1);
    expect(dropped.mock.calls[0][0][0].name).toBe("form.pdf");
    expect(screen.queryByTestId("chat-drop-hint")).toBeNull();

    fireEvent.dragOver(zone, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(screen.queryByTestId("chat-drop-hint")).toBeNull();
    fireEvent.drop(zone, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(dropped).toHaveBeenCalledTimes(1);
  });
});

describe("the full-screen shell", () => {
  it("covers the screen, hides the app's floating chrome while open, and shows title and save status", () => {
    const { unmount } = render(
      <WorkspaceShell kind="notes" title={<span>Groceries</span>} status="Saved" onClose={() => {}}>
        <p>body</p>
      </WorkspaceShell>,
    );
    const shell = screen.getByTestId("workspace-notes");
    expect(shell.className).toMatch(/fixed inset-0/);
    expect(document.body.getAttribute("data-workspace")).toBe("1");
    expect(screen.getByTestId("workspace-save-status").textContent).toBe("Saved");
    expect(shell.textContent).toContain("Groceries");
    unmount();
    expect(document.body.getAttribute("data-workspace")).toBeNull();
  });

  it("the X waits for the workspace's save before leaving for AI Chat", async () => {
    const order: string[] = [];
    let finishSave!: () => void;
    const onClose = async () => {
      order.push("save started");
      await new Promise<void>((r) => { finishSave = r; });
      order.push("saved");
      leaveWorkspace();
    };
    render(<WorkspaceShell kind="journal" onClose={onClose}><p>body</p></WorkspaceShell>);
    fireEvent.click(screen.getByTestId("button-workspace-close"));
    fireEvent.click(screen.getByTestId("button-workspace-close")); // a second tap does not run it twice
    await waitFor(() => expect(order).toEqual(["save started"]));
    expect(navigated).toEqual([]);
    finishSave();
    await waitFor(() => expect(navigated).toEqual(["/chat"]));
    expect(order).toEqual(["save started", "saved"]);
  });
});
