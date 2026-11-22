// @vitest-environment jsdom
//
// The chat box's Journal / Note buttons (owner request 2026-11-20): a hard
// switch, so the chat never has to guess whether a message is a diary entry,
// a note or a question. This renders the real composer.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { ChatComposer, type CaptureMode } from "../client/src/components/chat/ChatComposer";

const PEOPLE = [
  { id: "self-1", name: "Tron", isSelf: true },
  { id: "bob-1", name: "Bob" },
];

function Harness({ onSubmit, onFillEdit }: { onSubmit: (text: string, capture: CaptureMode, profileId: string) => void; onFillEdit?: () => void }) {
  const [capture, setCapture] = React.useState<CaptureMode>(null);
  const [profileId, setProfileId] = React.useState("");
  return (
    <ChatComposer
      onSubmit={(text) => { onSubmit(text, capture, profileId); return true; }}
      isPending={false}
      searchOpen={false}
      onToggleSearch={() => {}}
      onAttach={() => {}}
      showReset={false}
      onReset={() => {}}
      capture={capture}
      onCaptureChange={setCapture}
      captureProfileId={profileId}
      onCaptureProfileChange={setProfileId}
      captureProfiles={PEOPLE}
      onFillEdit={onFillEdit}
    />
  );
}
afterEach(cleanup);

describe("Journal / Note buttons", () => {
  it("off by default: an ordinary chat message", () => {
    const sent = vi.fn();
    render(<Harness onSubmit={sent} />);
    expect(screen.getByTestId("button-capture-journal").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("capture-hint")).toBeNull();
    expect(screen.queryByTestId("select-capture-profile")).toBeNull();
    fireEvent.change(screen.getByTestId("input-chat"), { target: { value: "what's on my calendar?" } });
    fireEvent.click(screen.getByTestId("button-send"));
    expect(sent).toHaveBeenCalledWith("what's on my calendar?", null, "");
  });

  it("Journal on: the box says what will happen, and the send is a journal save", () => {
    const sent = vi.fn();
    render(<Harness onSubmit={sent} />);
    fireEvent.click(screen.getByTestId("button-capture-journal"));
    expect(screen.getByTestId("button-capture-journal").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("capture-hint").textContent).toMatch(/Saved to the journal exactly as written/);
    expect((screen.getByTestId("input-chat") as HTMLTextAreaElement).placeholder).toBe("Write your journal entry…");
    expect(screen.getByTestId("button-send").textContent).toMatch(/Save entry/);
    fireEvent.change(screen.getByTestId("input-chat"), { target: { value: "Why was today so hard?" } });
    fireEvent.click(screen.getByTestId("button-send"));
    expect(sent).toHaveBeenCalledWith("Why was today so hard?", "journal", "");
  });

  it("the For menu picks whose it is; Me is the default", () => {
    const sent = vi.fn();
    render(<Harness onSubmit={sent} />);
    fireEvent.click(screen.getByTestId("button-capture-note"));
    const who = screen.getByTestId("select-capture-profile") as HTMLSelectElement;
    expect(who.value).toBe("");
    expect(Array.from(who.options).map((o) => o.textContent)).toEqual(["Me", "Bob"]);
    fireEvent.change(who, { target: { value: "bob-1" } });
    fireEvent.change(screen.getByTestId("input-chat"), { target: { value: "prefers mornings" } });
    fireEvent.click(screen.getByTestId("button-send"));
    expect(sent).toHaveBeenCalledWith("prefers mornings", "note", "bob-1");
  });

  it("tapping the active button goes back to chat; the two are exclusive", () => {
    render(<Harness onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByTestId("button-capture-journal"));
    fireEvent.click(screen.getByTestId("button-capture-note"));
    expect(screen.getByTestId("button-capture-journal").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("button-capture-note").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("button-capture-note"));
    expect(screen.getByTestId("button-capture-note").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("button-send").textContent).toMatch(/Send/);
  });
});

// Owner request 2026-11-22: Document and Fill & Edit beside Journal.
describe("Document and Fill & Edit buttons", () => {
  it("Document on: the box says what will happen, there is no For menu, and the send is a document request", () => {
    const sent = vi.fn();
    render(<Harness onSubmit={sent} />);
    fireEvent.click(screen.getByTestId("button-capture-document"));
    expect(screen.getByTestId("button-capture-document").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("capture-hint").textContent).toMatch(/left as a marked blank, never guessed/);
    expect(screen.getByTestId("capture-hint").textContent).not.toMatch(/start with a name/);
    expect(screen.queryByTestId("select-capture-profile")).toBeNull();
    expect(screen.getByTestId("button-send").textContent).toMatch(/Write document/);
    fireEvent.change(screen.getByTestId("input-chat"), { target: { value: "a cover letter" } });
    fireEvent.click(screen.getByTestId("button-send"));
    expect(sent).toHaveBeenCalledWith("a cover letter", "document", "");
  });

  it("one mode at a time: Document turns Journal off", () => {
    render(<Harness onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByTestId("button-capture-journal"));
    fireEvent.click(screen.getByTestId("button-capture-document"));
    expect(screen.getByTestId("button-capture-journal").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("button-capture-document").getAttribute("aria-pressed")).toBe("true");
  });

  it("Fill & Edit opens the file picker and changes no mode", () => {
    const pick = vi.fn();
    render(<Harness onSubmit={vi.fn()} onFillEdit={pick} />);
    fireEvent.click(screen.getByTestId("button-fill-edit"));
    expect(pick).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("capture-hint")).toBeNull();
  });

  it("no Fill & Edit handler, no button", () => {
    render(<Harness onSubmit={vi.fn()} />);
    expect(screen.queryByTestId("button-fill-edit")).toBeNull();
  });
});
