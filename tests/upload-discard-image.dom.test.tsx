// @vitest-environment jsdom
//
// The extract-only checkbox, as a person actually meets it.
//
// The server tests prove that a request carrying `discardImage` keeps no bytes.
// This one proves the user can actually ASK for that: the option is visible on
// the upload panel, it is OFF unless the person turns it on, and turning it on
// reports the change to the page that builds the upload payload. A privacy
// control that silently defaults on would be as wrong as one that never fires.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/queryClient", () => ({
  apiRequest: vi.fn(async () => ({ json: async () => [] })),
  BROWSER_TIMEZONE: "America/Los_Angeles",
}));

import { AttachmentPanel } from "../client/src/pages/chat";

afterEach(() => cleanup());

function renderPanel(overrides: Record<string, any> = {}) {
  const onDiscardImageChange = vi.fn();
  const onSend = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
    <AttachmentPanel
      attachment={{ name: "passport.jpg", mimeType: "image/jpeg", data: "", previewUrl: "blob:x" }}
      profiles={[]}
      profilesLoading={false}
      selectedProfileId="none"
      onProfileChange={() => {}}
      onRemove={() => {}}
      note=""
      onNoteChange={() => {}}
      onSend={onSend}
      onSaveOnly={() => {}}
      isSending={false}
      discardImage={false}
      onDiscardImageChange={onDiscardImageChange}
      {...overrides}
    />
    </QueryClientProvider>,
  );
  return { onDiscardImageChange, onSend };
}

describe("AttachmentPanel — extract-only option", () => {
  it("offers the option, unchecked, alongside the extraction action", () => {
    renderPanel();
    const box = screen.getByTestId("checkbox-discard-image");
    expect(box).toBeTruthy();
    // Unchecked by default: keeping the file stays the status quo.
    expect(box.getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByTestId("label-discard-image").textContent).toMatch(/don't keep the photo/i);
  });

  it("reports the choice up to the page when ticked", () => {
    const { onDiscardImageChange } = renderPanel();
    fireEvent.click(screen.getByTestId("checkbox-discard-image"));
    expect(onDiscardImageChange).toHaveBeenCalledWith(true);
  });

  it("reflects the choice back, and untick reports false", () => {
    const { onDiscardImageChange } = renderPanel({ discardImage: true });
    const box = screen.getByTestId("checkbox-discard-image");
    expect(box.getAttribute("data-state")).toBe("checked");
    fireEvent.click(box);
    expect(onDiscardImageChange).toHaveBeenCalledWith(false);
  });

  it("is unavailable while the photo is still being prepared, like every other action", () => {
    renderPanel({ attachment: { name: "p.jpg", mimeType: "image/jpeg", data: "", previewUrl: "blob:x", processing: true } });
    expect(screen.getByTestId("checkbox-discard-image").hasAttribute("disabled")).toBe(true);
  });
});
