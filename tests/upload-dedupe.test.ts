// Idempotent re-upload guard (processFileUpload).
//
// "Load failed" on iOS means the connection died mid-upload — the client can't
// know whether the server finished, so it retries. A retry of the SAME file
// must never create a second document or a second expense. Every stored upload
// is tagged with its content hash (sha256:…); an identical file re-sent within
// the window short-circuits to the existing document — no AI reprocessing, no
// new rows — and rebuilds the extraction checklist from the saved
// extractedData so the confirm-and-save flow still works.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

const { stubState, stubStorage } = vi.hoisted(() => {
  const state = {
    documents: [] as any[],
    created: [] as any[],
  };
  const impl: any = {
    async getDocuments() { return state.documents; },
    async createDocument(data: any) {
      const row = { id: `doc-${state.created.length + 1}`, createdAt: new Date().toISOString(), ...data };
      state.created.push(row);
      state.documents.push(row);
      return row;
    },
    async getProfiles() { return []; },
  };
  const storage = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  });
  return { stubState: state, stubStorage: storage };
});

vi.mock("../server/storage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, storage: stubStorage };
});

// If the dedupe guard works, no AI call ever happens for a duplicate upload.
// Make any attempted call fail loudly so a regression is unmissable.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: async () => { throw new Error("AI must NOT be called for a duplicate upload"); },
    };
  },
}));

import { processFileUpload } from "../server/ai-engine";

const FILE_BASE64 = Buffer.from("oil change receipt image bytes").toString("base64");
const HASH_TAG = `sha256:${createHash("sha256").update(FILE_BASE64).digest("hex").slice(0, 32)}`;

describe("processFileUpload — idempotent re-upload guard", () => {
  beforeEach(() => {
    stubState.documents.length = 0;
    stubState.created.length = 0;
  });

  it("returns the existing document for a re-sent identical file instead of creating a duplicate", async () => {
    stubState.documents.push({
      id: "doc-original",
      name: "Oil Change Service Receipt",
      type: "vehicle_service_receipt",
      mimeType: "image/jpeg",
      createdAt: new Date().toISOString(),
      tags: ["vehicle_service_receipt", HASH_TAG],
      extractedData: {
        currentMileage: { value: 69063, confidence: 0.98 },
        serviceDate: "2026-07-22",
        totalAmount: 118.14,
      },
    });

    const result = await processFileUpload("image.jpg", "image/jpeg", FILE_BASE64);

    // Reused, not recreated.
    expect(result.documentId).toBe("doc-original");
    expect(stubState.created).toHaveLength(0);
    expect(result.reply).toContain("existing document");

    // The extraction checklist still works: fields rebuilt from the saved
    // extractedData with wrapped {value,confidence} objects unwrapped.
    const fields = result.pendingExtraction?.extractedFields || [];
    const byKey = Object.fromEntries(fields.map((f: any) => [f.key, f.value]));
    expect(byKey.currentMileage).toBe(69063);
    expect(byKey.serviceDate).toBe("2026-07-22");
    expect(result.pendingExtraction.extractionId).toBe("doc-original");
  });

  it("ignores stale hash matches outside the dedupe window", async () => {
    stubState.documents.push({
      id: "doc-old",
      name: "Old upload",
      type: "other",
      mimeType: "image/jpeg",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
      tags: [HASH_TAG],
      extractedData: {},
    });

    // Outside the window the guard must NOT short-circuit — processing
    // proceeds and (with the AI mocked to fail) falls into the error path
    // that still stores the document. Either way a NEW document is created.
    const result = await processFileUpload("image.jpg", "image/jpeg", FILE_BASE64);
    expect(result.documentId).not.toBe("doc-old");
    expect(stubState.created.length).toBeGreaterThan(0);
    // The new document carries the hash tag so the NEXT retry dedupes.
    expect(stubState.created[0].tags).toContain(HASH_TAG);
  });
});
