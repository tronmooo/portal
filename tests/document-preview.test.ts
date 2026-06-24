import { describe, it, expect } from "vitest";
import { classifyDocument, isTextLike, base64ToBlob } from "../client/src/lib/document-preview";
import { CONTENT_SECURITY_POLICY } from "../server/security-headers";

describe("classifyDocument", () => {
  it("classifies images", () => {
    expect(classifyDocument("image/png")).toBe("image");
    expect(classifyDocument("image/jpeg")).toBe("image");
    expect(classifyDocument("image/webp")).toBe("image");
  });

  it("classifies PDFs", () => {
    expect(classifyDocument("application/pdf")).toBe("pdf");
  });

  it("classifies text-like types", () => {
    expect(classifyDocument("text/plain")).toBe("text");
    expect(classifyDocument("text/csv")).toBe("text");
    expect(classifyDocument("application/json")).toBe("text");
  });

  it("classifies office/binary docs as other", () => {
    expect(
      classifyDocument("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    ).toBe("other");
    expect(
      classifyDocument("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ).toBe("other");
    expect(classifyDocument("application/octet-stream")).toBe("other");
    expect(classifyDocument("")).toBe("other");
  });
});

describe("isTextLike", () => {
  it("recognises text mime types", () => {
    expect(isTextLike("text/markdown")).toBe(true);
    expect(isTextLike("application/xml")).toBe(true);
  });
  it("rejects binary types", () => {
    expect(isTextLike("application/pdf")).toBe(false);
    expect(isTextLike("image/png")).toBe(false);
    expect(isTextLike("")).toBe(false);
  });
});

describe("base64ToBlob", () => {
  it("decodes a plain base64 string into a typed Blob", () => {
    // "hello" -> aGVsbG8=
    const blob = base64ToBlob("aGVsbG8=", "text/plain");
    expect(blob.type).toBe("text/plain");
    expect(blob.size).toBe(5);
  });

  it("strips a data: URL prefix before decoding", () => {
    const blob = base64ToBlob("data:text/plain;base64,aGVsbG8=", "text/plain");
    expect(blob.size).toBe(5);
  });

  it("defaults the type when none is given", () => {
    const blob = base64ToBlob("aGVsbG8=", "");
    expect(blob.type).toBe("application/octet-stream");
  });
});

describe("Content-Security-Policy allows blob document previews", () => {
  // Regression guard for "This content is blocked": the PDF/document viewer
  // embeds same-origin blob: URLs in <object>/<iframe>. The CSP must allow
  // blob: in both directives — and must NOT allow data: there (XSS vector).
  function directive(name: string): string {
    const part = CONTENT_SECURITY_POLICY.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + " "));
    return part || "";
  }

  it("frame-src includes 'self' and blob: but not data:", () => {
    const d = directive("frame-src");
    expect(d).toContain("'self'");
    expect(d).toContain("blob:");
    expect(d).not.toContain("data:");
  });

  it("object-src includes 'self' and blob: but not data: and is not 'none'", () => {
    const d = directive("object-src");
    expect(d).toContain("'self'");
    expect(d).toContain("blob:");
    expect(d).not.toContain("data:");
    expect(d).not.toContain("'none'");
  });
});
