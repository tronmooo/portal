/**
 * Chat writes must land in the UI without a refresh — and must not make the
 * reply wait on a document download.
 *
 * Both halves of the 2026-08-02 report are pinned here:
 *   a) "I had to refresh the entire app for all the trackers to show up" — the
 *      client never acted on the tool_result frames, which arrive with the write
 *      already committed.
 *   b) "opening documents through the chat… the whole reply is slow to arrive" —
 *      `open_document` shipped the file's bytes inside the AI response while
 *      every other document path used a lazy sentinel.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { LAZY_DOCUMENT_SENTINEL, hasInlineDocumentData } from "@shared/document-lazy";

const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Strip LINE comments before scanning. Prose explaining what a call site USED
 * to do ("this used to be storage.getDocument(...)") is not a call site, and
 * the comments in these files deliberately name the very patterns these tests
 * forbid.
 *
 * Line comments only, on purpose: a naive block-comment strip mangles both
 * files, because chat.tsx contains block-comment openers inside regex and
 * string literals — stripping from there to the next closer swallows real
 * code. The `[^:]` guard keeps `https://` intact.
 */
function stripComments(src: string): string {
  return src.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const AI_ENGINE = stripComments(readFileSync(path.join(REPO_ROOT, "server", "ai-engine.ts"), "utf8"));
const CHAT_PAGE = stripComments(readFileSync(path.join(REPO_ROOT, "client", "src", "pages", "chat.tsx"), "utf8"));

describe("lazy document previews", () => {
  it("treats the sentinel as 'no bytes here'", () => {
    expect(hasInlineDocumentData(LAZY_DOCUMENT_SENTINEL)).toBe(false);
    expect(hasInlineDocumentData("")).toBe(false);
    expect(hasInlineDocumentData(undefined)).toBe(false);
    expect(hasInlineDocumentData(null)).toBe(false);
    expect(hasInlineDocumentData("aGVsbG8=")).toBe(true);
  });

  it("open_document returns the sentinel instead of downloading the file", () => {
    // It used to `return storage.getDocument(bestDoc.id)`, which downloads the
    // object from Storage and base64-encodes it (~1.33x file size) — and the
    // caller embedded that in the chat response, so the whole reply waited on
    // it. The model never sees the bytes (summarizeResult strips fileData) and
    // the client fetches them itself.
    const start = AI_ENGINE.indexOf('case "open_document"');
    expect(start, "open_document tool case not found").toBeGreaterThan(-1);
    const body = AI_ENGINE.slice(start, AI_ENGINE.indexOf('case "create_document"', start));
    expect(
      /storage\.getDocument\(/.test(body),
      "open_document downloads the file again — return the lazy sentinel instead.",
    ).toBe(false);
    expect(body).toContain("LAZY_DOCUMENT_SENTINEL");
  });

  it("uses the shared constant, never a bare string literal", () => {
    // Ten copies of "__LAZY_LOAD__" is how open_document ended up as the one
    // path that forgot it.
    expect(AI_ENGINE).not.toContain('"__LAZY_LOAD__"');
  });
});

describe("tool_result frames drive the cache", () => {
  it("stamps each frame with the domains the write touched", () => {
    expect(AI_ENGINE).toContain("streamDomainsForTool");
    // Emitted on the frame, not just computed.
    expect(/domains:\s*streamDomains/.test(AI_ENGINE)).toBe(true);
  });

  it("advances the data version BEFORE telling the client to refresh", () => {
    // Otherwise the mid-stream refetch races the 2s cache-version memo and
    // caches a PRE-write list as fresh for the full staleTime — reintroducing
    // the original bug, just earlier in the turn.
    const emitIdx = AI_ENGINE.indexOf("domains: streamDomains");
    const bumpIdx = AI_ENGINE.indexOf("streamDataVersion = Number(await");
    expect(bumpIdx).toBeGreaterThan(-1);
    expect(emitIdx).toBeGreaterThan(bumpIdx);
    expect(AI_ENGINE).toContain("dataVersion: streamDataVersion");
  });

  it("the client refreshes from the frame instead of waiting for the turn to end", () => {
    expect(CHAT_PAGE).toContain("onToolResult");
    // Routed through the cache bus (which also broadcasts cross-tab) rather
    // than a local queryClient call.
    expect(/void invalidateDomains\(\.\.\.frame\.domains\)/.test(CHAT_PAGE)).toBe(true);
    // …and records the floor first, so that refetch can't read pre-write data.
    const noteIdx = CHAT_PAGE.indexOf("noteDataVersion(frame.dataVersion)");
    const invalidateIdx = CHAT_PAGE.indexOf("void invalidateDomains(...frame.domains)");
    expect(noteIdx).toBeGreaterThan(-1);
    expect(invalidateIdx).toBeGreaterThan(noteIdx);
  });

  it("starts the document download from the frame, not from preview mount", () => {
    expect(/frame\.document\?\.id/.test(CHAT_PAGE)).toBe(true);
    expect(CHAT_PAGE).toContain("prefetchDocument(frame.document.id");
  });

  it("no longer papers over the version race with a 1200ms timeout", () => {
    // 1200ms was SHORTER than the 2000ms memo it was racing, so it lost about
    // as often as it won — and doubled every post-chat refetch when it won.
    expect(
      /setTimeout\(\s*\(\)\s*=>\s*queryClient\.invalidateQueries/.test(CHAT_PAGE),
      "chat.tsx re-added a delayed blanket invalidation; the version floor replaces it.",
    ).toBe(false);
  });

  it("falls back to a full sweep when no manifest arrived", () => {
    // Older server, a turn that wrote nothing, or a dropped stream must still
    // refresh — under-refreshing is the failure mode being fixed.
    expect(CHAT_PAGE).toContain("queryClient.invalidateQueries({ predicate: isData })");
  });
});
