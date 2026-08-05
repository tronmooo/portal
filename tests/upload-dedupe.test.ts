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

// getAnthropicClient refuses to construct a client without a key, and it throws
// BEFORE the mocked SDK below is ever reached — which would quietly turn every
// "AI returns X" test into an "AI is unavailable" test. Set in vi.hoisted so it
// lands before the ai-engine import is evaluated.
vi.hoisted(() => { process.env.ANTHROPIC_API_KEY ||= "test-key-not-used"; });

const { stubState, stubStorage } = vi.hoisted(() => {
  const state = {
    documents: [] as any[],
    created: [] as any[],
    // Queued model replies, consumed in order. An empty queue means "the AI
    // must not have been called" — see the mock below.
    aiReplies: [] as string[],
    // Make storage.getProfile fail from the Nth call onward, to land a failure
    // AFTER the document has been written.
    getProfileFailsFromCall: 0,
    getProfileCalls: 0,
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
    async getProfile(id: string) {
      state.getProfileCalls++;
      if (state.getProfileFailsFromCall && state.getProfileCalls >= state.getProfileFailsFromCall) {
        throw new Error("supabase: connection reset by peer");
      }
      return { id, name: "Jane Doe", type: "person", fields: {} };
    },
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

// Replies come from stubState.aiReplies, in order. An EMPTY queue throws: if
// the dedupe guard works, no AI call ever happens for a duplicate upload, and
// leaving the queue empty makes that regression unmissable.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: async () => {
        const next = stubState.aiReplies.shift();
        if (next === undefined) throw new Error("AI must NOT be called for a duplicate upload");
        return { content: [{ type: "text", text: next }] };
      },
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
    stubState.aiReplies.length = 0;
    stubState.getProfileFailsFromCall = 0;
    stubState.getProfileCalls = 0;
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

  // User, 2026-08-05: "when I uploaded the photo there was an error message
  // even though it was uploaded". Extraction writes the document and THEN keeps
  // working over it (propagation, expense synthesis, checklist assembly). A
  // failure in any of that hit a catch that called createDocument again, so a
  // single upload left TWO copies of the same file behind the error message.
  it("never creates a second document when the failure lands after the file is stored", async () => {
    stubState.aiReplies.push(
      JSON.stringify({
        documentType: "driver_license", category: "Identity", label: "Driver License",
        confidence: 0.95, summary: "State driver license.",
        destinations: { profileFacts: true, expense: false, obligation: false, calendarEvent: true, trackerEntries: false, asset: false },
        domainHint: "Government photo ID.",
      }),
      JSON.stringify({
        documentType: "driver_license", label: "Driver License",
        summary: "State driver license.",
        extractedData: { licenseNumber: "S226-116-24-800-0" },
        trackerEntries: [],
      }),
    );
    // Call 1 resolves the link target (so the document IS written); call 2 —
    // the profile-name lookup that runs right after — is where it breaks.
    stubState.getProfileFailsFromCall = 2;

    const result = await processFileUpload("license.jpg", "image/jpeg", FILE_BASE64, undefined, "profile-1");

    // The upload still comes back as saved, not lost.
    expect(result.documentId).toBeTruthy();
    expect(result.reply).toContain("Saved");
    // ONE document for ONE upload, whatever went wrong along the way.
    expect(stubState.created).toHaveLength(1);
    expect(result.documentId).toBe(stubState.created[0].id);
    expect(stubState.created[0].tags).toContain(HASH_TAG);
  });

  it("still stores the file when the failure lands BEFORE anything was written", async () => {
    // Empty reply queue → the classifier and the extractor both throw, so the
    // catch is the only thing that ever writes the document.
    const result = await processFileUpload("license.jpg", "image/jpeg", FILE_BASE64);
    expect(result.documentId).toBeTruthy();
    expect(result.reply).toContain("Saved");
    expect(stubState.created).toHaveLength(1);
    expect(stubState.created[0].tags).toContain(HASH_TAG);
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
