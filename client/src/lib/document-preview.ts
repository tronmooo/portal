// Shared document-preview helpers.
//
// The whole app renders document binaries (PDFs, images, etc.) inside
// <img>/<object>/<iframe>. Two hard constraints shape this module:
//
//  1. CSP. The app's Content-Security-Policy allows `frame-src`/`object-src`
//     of `'self' blob:` ONLY — not `data:` (a data: frame/object is an XSS
//     vector). So anything embedded in an <object>/<iframe> MUST be a
//     same-origin blob: URL, never a data: URL.
//
//  2. Auth. The binary lives behind `/api/documents/:id/file`, which requires
//     an `Authorization: Bearer` header. The global fetch interceptor only
//     adds that header to JavaScript `fetch()` calls — native browser loads
//     (`<img src>`, `<object data>`, `<iframe src>`) bypass it and 401. So we
//     must fetch the binary via `apiRequest` and wrap the result in a blob URL.
//
// `useDocumentBlobUrl` resolves a blob: URL either by decoding inline base64
// locally (no network) or by fetching the authenticated /file endpoint, and
// cleans up the object URL on unmount / dependency change.
//
// PERF: resolved blobs live in a process-wide refcounted LRU (`blobCache`).
// Opening a document used to re-fetch and re-decode its bytes EVERY time — so
// closing a PDF and reopening it paid the full multi-second cost again. Now a
// second open is a synchronous cache hit that paints on the first frame, and
// `prefetchDocumentBlob()` lets a list start the download on pointer-down so
// the bytes are usually already in hand by the time the dialog mounts.

import { useEffect, useState } from "react";
import { hasInlineDocumentData } from "@shared/document-lazy";
import { apiRequest } from "./queryClient";

/**
 * Shared `accept` value for general document-upload <input type="file">s, so the
 * picker offers every type the app can store/preview consistently (images, PDFs,
 * Office docs, spreadsheets, text/CSV/JSON, presentations). Image- or PDF-only
 * flows (avatars, SmartFill extraction) keep their own narrower accept.
 */
export const DOCUMENT_UPLOAD_ACCEPT = [
  "image/*",
  "application/pdf",
  ".doc", ".docx",
  ".xls", ".xlsx",
  ".ppt", ".pptx",
  ".csv", ".txt", ".rtf", ".json",
  "text/*",
].join(",");

/** Convert a base64 string (optionally a `data:…;base64,` URL) into a Blob. */
export function base64ToBlob(base64: string, mime: string): Blob {
  const clean = base64.includes(",") ? base64.split(",")[1] : base64;
  const byteChars = atob(clean);
  // Chunk the decode so a multi-MB file doesn't allocate one giant array.
  const sliceSize = 1024;
  const byteArrays: Uint8Array[] = [];
  for (let offset = 0; offset < byteChars.length; offset += sliceSize) {
    const slice = byteChars.slice(offset, offset + sliceSize);
    const bytes = new Uint8Array(slice.length);
    for (let i = 0; i < slice.length; i++) bytes[i] = slice.charCodeAt(i);
    byteArrays.push(bytes);
  }
  return new Blob(byteArrays, { type: mime || "application/octet-stream" });
}

/** True for types we can render as plain text inline. */
export function isTextLike(mime: string): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  return (
    m.startsWith("text/") ||
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/x-ndjson"
  );
}

/** Coarse classification used by the viewers to pick a renderer. */
export function classifyDocument(mime: string): "image" | "pdf" | "text" | "other" {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf") return "pdf";
  if (isTextLike(m)) return "text";
  return "other";
}

// ─── Resolved-blob cache ──────────────────────────────────────────────────────
//
// Keyed by document id: the same id always denotes the same bytes, and the one
// event that can change them (replacing the file) calls
// `invalidateDocumentBlob`. Entries are refcounted so an LRU eviction can never
// revoke an object URL that a mounted <img>/<canvas> is still pointing at — the
// revoke is deferred until the last consumer releases it.

interface BlobCacheEntry {
  url: string;
  blob: Blob;
  bytes: number;
  refs: number;
  evicted: boolean;
}

/** Cap the retained bytes so a session spent browsing documents can't grow
 *  unbounded on a phone. Least-recently-used entries go first. */
const BLOB_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const BLOB_CACHE_MAX_ENTRIES = 12;

// Map preserves insertion order — re-inserting on read gives us LRU ordering.
const blobCache = new Map<string, BlobCacheEntry>();
// In-flight fetches, so a prefetch and the viewer that follows it share ONE
// request instead of racing two downloads of the same file.
const inflight = new Map<string, Promise<Blob>>();
// Bumped by `invalidateDocumentBlob`. A response that was already on the wire
// when the file got replaced must not be written into the cache — otherwise the
// superseded bytes could land after the fresh ones and stick.
const generation = new Map<string, number>();

function releaseEntry(entry: BlobCacheEntry) {
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.evicted && entry.refs === 0) URL.revokeObjectURL(entry.url);
}

function trimBlobCache() {
  let total = 0;
  for (const e of blobCache.values()) total += e.bytes;
  for (const [key, entry] of blobCache) {
    if (total <= BLOB_CACHE_MAX_BYTES && blobCache.size <= BLOB_CACHE_MAX_ENTRIES) break;
    // Never evict something currently on screen — skip it and keep scanning.
    if (entry.refs > 0) continue;
    blobCache.delete(key);
    total -= entry.bytes;
    entry.evicted = true;
    URL.revokeObjectURL(entry.url);
  }
}

function putBlob(id: string, blob: Blob): BlobCacheEntry {
  const existing = blobCache.get(id);
  if (existing) return existing;
  const entry: BlobCacheEntry = {
    url: URL.createObjectURL(blob),
    blob,
    bytes: blob.size,
    refs: 0,
    evicted: false,
  };
  blobCache.set(id, entry);
  trimBlobCache();
  return entry;
}

function takeBlob(id: string): BlobCacheEntry | undefined {
  const entry = blobCache.get(id);
  if (!entry) return undefined;
  // Refresh LRU position.
  blobCache.delete(id);
  blobCache.set(id, entry);
  return entry;
}

/** Drop a document's cached bytes — call after replacing/re-uploading its file. */
export function invalidateDocumentBlob(id: string) {
  inflight.delete(id);
  generation.set(id, (generation.get(id) ?? 0) + 1);
  const entry = blobCache.get(id);
  if (!entry) return;
  blobCache.delete(id);
  entry.evicted = true;
  if (entry.refs === 0) URL.revokeObjectURL(entry.url);
}

/** Fetch a document's binary through the authenticated endpoint, deduped. */
function fetchDocumentBlob(id: string, mimeType: string): Promise<Blob> {
  const pending = inflight.get(id);
  if (pending) return pending;
  const gen = generation.get(id) ?? 0;
  const p = apiRequest("GET", `/api/documents/${id}/file`)
    .then((res) => res.blob())
    .then((b) => {
      // Honor the server-declared content type when present.
      const typed = mimeType && b.type !== mimeType ? new Blob([b], { type: mimeType }) : b;
      // Superseded by an invalidation while in flight — hand the bytes to this
      // caller but keep them out of the cache.
      if ((generation.get(id) ?? 0) === gen) putBlob(id, typed);
      return typed;
    })
    .finally(() => {
      // Only clear OUR entry: an invalidation may already have started a newer
      // request under the same id.
      if (inflight.get(id) === p) inflight.delete(id);
    });
  inflight.set(id, p);
  return p;
}

/**
 * Start downloading a document's binary before anything renders it.
 *
 * Call from a list row's pointer-down / hover: the viewer that opens a moment
 * later finds the bytes already cached (or joins the in-flight request) instead
 * of starting from zero after its dialog has mounted.
 */
export function prefetchDocumentBlob(id: string, mimeType: string = "") {
  if (!id || blobCache.has(id) || inflight.has(id)) return;
  fetchDocumentBlob(id, mimeType).catch(() => { /* prefetch is best-effort */ });
}

/**
 * Warm the PDF.js renderer chunk (~1MB + its worker).
 *
 * Loading it only once a PDF's bytes have arrived puts a chunk download and a
 * worker spin-up on the critical path, right where the user is already staring
 * at a spinner. Kicking it off alongside the file download overlaps the two.
 */
export function preloadPdfRenderer() {
  import("@/components/PdfCanvas")
    .then((m) => m.preloadPdfjs?.())
    .catch(() => { /* best-effort warm-up */ });
}

/** Prefetch everything a document's preview will need (bytes + renderer). */
export function prefetchDocument(id: string, mimeType: string = "") {
  prefetchDocumentBlob(id, mimeType);
  if (classifyDocument(mimeType) === "pdf") preloadPdfRenderer();
}

export interface DocumentBlobState {
  /** Same-origin blob: URL ready to drop into src/data, or null while pending. */
  url: string | null;
  /** The underlying Blob — pass its bytes to PDF.js via `blob.arrayBuffer()`
   *  (no fetch / connect-src involved). Null until resolved. */
  blob: Blob | null;
  loading: boolean;
  error: boolean;
}

/**
 * Resolve a same-origin blob: URL for a document so it renders under the strict
 * CSP regardless of whether the caller already has the base64 in hand.
 *
 * @param id        Document id (used for the authenticated /file fallback).
 * @param mimeType  MIME type for the resulting Blob.
 * @param data      Optional inline base64 ("" / the lazy sentinel = not present).
 * @param enabled   Skip all work when false (e.g. dialog closed).
 */
export function useDocumentBlobUrl(
  id: string,
  mimeType: string,
  data?: string,
  enabled: boolean = true,
): DocumentBlobState {
  // Seed from the cache during render, not in an effect: a re-open of an
  // already-resolved document then paints its bytes on the FIRST frame with no
  // spinner at all, instead of flashing a loader for at least one commit.
  const cached = enabled && id ? blobCache.get(id) : undefined;
  const [state, setState] = useState<DocumentBlobState>(() =>
    cached
      ? { url: cached.url, blob: cached.blob, loading: false, error: false }
      : { url: null, blob: null, loading: !!(enabled && id), error: false }
  );

  useEffect(() => {
    if (!enabled || !id) {
      setState({ url: null, blob: null, loading: false, error: false });
      return;
    }

    // Overlap the renderer chunk with the byte fetch below. Without this the
    // ~1MB PDF.js download only STARTS once the file has fully arrived, adding
    // its latency to every first PDF view of a session.
    if (classifyDocument(mimeType) === "pdf") preloadPdfRenderer();

    let cancelled = false;
    // The entry this mount is holding a reference on, so cleanup releases it.
    let held: BlobCacheEntry | null = null;
    // An object URL this mount created outside the cache (see below), which it
    // is therefore responsible for revoking.
    let standaloneUrl: string | null = null;
    const hold = (entry: BlobCacheEntry) => {
      entry.refs += 1;
      held = entry;
      if (!cancelled) setState({ url: entry.url, blob: entry.blob, loading: false, error: false });
    };

    const hit = takeBlob(id);
    if (hit) {
      hold(hit);
    } else {
      const hasInline = hasInlineDocumentData(data);
      if (hasInline) {
        // Decode the base64 we already have — no network round-trip. Cached
        // like a fetched blob so the (CPU-heavy on mobile) atob runs once.
        try {
          hold(putBlob(id, base64ToBlob(data as string, mimeType)));
        } catch (e) {
          console.error("[useDocumentBlobUrl] base64 decode failed:", e);
          setState({ url: null, blob: null, loading: false, error: true });
        }
      } else {
        setState((s) => (s.loading ? s : { url: null, blob: null, loading: true, error: false }));
        fetchDocumentBlob(id, mimeType)
          .then((b) => {
            if (cancelled) return;
            // Normally the fetch just populated the cache. It won't have if an
            // invalidation superseded it mid-flight — show the bytes we were
            // handed rather than a phantom error, on a URL we own and revoke.
            const entry = takeBlob(id);
            if (entry) { hold(entry); return; }
            standaloneUrl = URL.createObjectURL(b);
            setState({ url: standaloneUrl, blob: b, loading: false, error: false });
          })
          .catch((err) => {
            if (cancelled) return;
            console.error("[useDocumentBlobUrl] failed to fetch file blob:", err);
            setState({ url: null, blob: null, loading: false, error: true });
          });
      }
    }

    return () => {
      cancelled = true;
      if (held) releaseEntry(held);
      if (standaloneUrl) URL.revokeObjectURL(standaloneUrl);
    };
  }, [id, mimeType, data, enabled]);

  return state;
}
