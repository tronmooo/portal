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

import { useEffect, useState } from "react";
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
 * @param data      Optional inline base64 ("" / "__LAZY_LOAD__" = not present).
 * @param enabled   Skip all work when false (e.g. dialog closed).
 */
export function useDocumentBlobUrl(
  id: string,
  mimeType: string,
  data?: string,
  enabled: boolean = true,
): DocumentBlobState {
  const [url, setUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!enabled || !id) {
      setUrl(null);
      setBlob(null);
      setLoading(false);
      setError(false);
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;
    const hasInline = !!data && data !== "__LAZY_LOAD__" && data.length > 0;

    setError(false);

    if (hasInline) {
      // Fast path: decode the base64 we already have, no network round-trip.
      try {
        const b = base64ToBlob(data as string, mimeType);
        createdUrl = URL.createObjectURL(b);
        setBlob(b);
        setUrl(createdUrl);
        setLoading(false);
      } catch (e) {
        console.error("[useDocumentBlobUrl] base64 decode failed:", e);
        setUrl(null);
        setBlob(null);
        setError(true);
        setLoading(false);
      }
    } else {
      // Fetch the binary through the authenticated API, then wrap in a blob URL.
      setLoading(true);
      apiRequest("GET", `/api/documents/${id}/file`)
        .then((res) => res.blob())
        .then((b) => {
          if (cancelled) return;
          // Honor the server-declared content type when present.
          const typed = mimeType && b.type !== mimeType
            ? new Blob([b], { type: mimeType })
            : b;
          createdUrl = URL.createObjectURL(typed);
          setBlob(typed);
          setUrl(createdUrl);
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("[useDocumentBlobUrl] failed to fetch file blob:", err);
          setUrl(null);
          setBlob(null);
          setError(true);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [id, mimeType, data, enabled]);

  return { url, blob, loading, error };
}
