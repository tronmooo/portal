// @vitest-environment jsdom
//
// Runtime verification of `useDocumentBlobUrl` — the hook every document
// preview in the app (dashboard dialog, profile pages, chat bubbles) resolves
// its bytes through.
//
// The reported symptom was a preview that spun for seconds every single time a
// document was opened, including reopening one that had just been closed. These
// mount the real hook and assert the behaviors that fix it:
//
//   1. A reopen paints on the FIRST render — no network, no spinner frame.
//   2. Two previews of the same document share ONE download.
//   3. A prefetch issued before the viewer mounts is the download the viewer
//      then uses, rather than a second one racing it.
//   4. Unmounting doesn't revoke a URL another live preview is still using —
//      the failure mode a naive cache would introduce.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { render, act, cleanup, waitFor } from "@testing-library/react";

const apiRequest = vi.fn();
vi.mock("../client/src/lib/queryClient", () => ({
  apiRequest: (...args: any[]) => apiRequest(...args),
}));

type Preview = typeof import("../client/src/lib/document-preview");

/** Reload the module so each test starts with an empty process-wide cache. */
async function freshModule(): Promise<Preview> {
  vi.resetModules();
  apiRequest.mockReset();
  apiRequest.mockImplementation(async () => ({
    blob: async () => new Blob(["hello"], { type: "image/png" }),
  }));
  return await import("../client/src/lib/document-preview");
}

/** Mounts the hook and records the state of every render it produced. */
function makeProbe(useDocumentBlobUrl: Preview["useDocumentBlobUrl"]) {
  const renders: Array<{ url: string | null; loading: boolean; error: boolean }> = [];
  const Probe = ({ id }: { id: string }) => {
    const s = useDocumentBlobUrl(id, "image/png");
    renders.push({ url: s.url, loading: s.loading, error: s.error });
    return React.createElement("div", { "data-url": s.url ?? "" });
  };
  return { Probe, renders };
}

beforeEach(() => { cleanup(); });

describe("useDocumentBlobUrl", () => {
  it("resolves a blob URL from the authenticated file endpoint", async () => {
    const m = await freshModule();
    const { Probe, renders } = makeProbe(m.useDocumentBlobUrl);

    render(React.createElement(Probe, { id: "doc-1" }));
    // First frame has nothing yet, so it must say so rather than render blank.
    expect(renders[0]).toMatchObject({ url: null, loading: true, error: false });

    await waitFor(() => expect(renders[renders.length - 1].url).toBeTruthy());
    expect(renders[renders.length - 1].loading).toBe(false);
    expect(apiRequest).toHaveBeenCalledWith("GET", "/api/documents/doc-1/file");
  });

  it("reopening the same document paints on the first render, with no request", async () => {
    const m = await freshModule();

    const first = makeProbe(m.useDocumentBlobUrl);
    const view = render(React.createElement(first.Probe, { id: "doc-1" }));
    await waitFor(() => expect(first.renders[first.renders.length - 1].url).toBeTruthy());
    expect(apiRequest).toHaveBeenCalledTimes(1);

    // Close the viewer, then open it again — the case that used to re-download
    // and re-decode the whole file.
    act(() => { view.unmount(); });

    const second = makeProbe(m.useDocumentBlobUrl);
    render(React.createElement(second.Probe, { id: "doc-1" }));

    expect(second.renders[0].url).toBeTruthy();
    expect(second.renders[0].loading).toBe(false);
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it("uses the bytes a prefetch already started, instead of a second download", async () => {
    const m = await freshModule();

    // Pointer-down on the list row.
    m.prefetchDocumentBlob("doc-1", "image/png");
    // Dialog mounts a moment later, while that request is still in flight.
    const { Probe, renders } = makeProbe(m.useDocumentBlobUrl);
    render(React.createElement(Probe, { id: "doc-1" }));

    await waitFor(() => expect(renders[renders.length - 1].url).toBeTruthy());
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it("two previews of one document share a single download and a single URL", async () => {
    const m = await freshModule();
    const a = makeProbe(m.useDocumentBlobUrl);
    const b = makeProbe(m.useDocumentBlobUrl);

    render(React.createElement(a.Probe, { id: "doc-1" }));
    render(React.createElement(b.Probe, { id: "doc-1" }));

    await waitFor(() => {
      expect(a.renders[a.renders.length - 1].url).toBeTruthy();
      expect(b.renders[b.renders.length - 1].url).toBeTruthy();
    });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(a.renders[a.renders.length - 1].url).toBe(b.renders[b.renders.length - 1].url);
  });

  it("unmounting one preview leaves the other's URL usable", async () => {
    const m = await freshModule();
    const revoke = vi.spyOn(URL, "revokeObjectURL");

    const a = makeProbe(m.useDocumentBlobUrl);
    const b = makeProbe(m.useDocumentBlobUrl);
    const viewA = render(React.createElement(a.Probe, { id: "doc-1" }));
    render(React.createElement(b.Probe, { id: "doc-1" }));
    await waitFor(() => expect(b.renders[b.renders.length - 1].url).toBeTruthy());

    const sharedUrl = b.renders[b.renders.length - 1].url;
    act(() => { viewA.unmount(); });

    // The surviving preview is still pointing at this URL — revoking it here is
    // exactly the bug refcounting exists to prevent.
    expect(revoke).not.toHaveBeenCalledWith(sharedUrl);
    revoke.mockRestore();
  });

  it("surfaces an error when the document has no file to serve", async () => {
    const m = await freshModule();
    apiRequest.mockRejectedValue(new Error("404: Not found"));
    const { Probe, renders } = makeProbe(m.useDocumentBlobUrl);

    render(React.createElement(Probe, { id: "doc-missing" }));
    await waitFor(() => expect(renders[renders.length - 1].error).toBe(true));
    expect(renders[renders.length - 1].loading).toBe(false);
  });
});
