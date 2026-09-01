// Extract-only uploads ("don't keep my photo").
//
// A user who ticks "Don't keep the photo — extract only" is making a promise-
// shaped request: the bytes may be read to pull fields out of them, and then
// they must not exist anywhere. This test pins the part of that promise the
// server owns — that NOTHING reaches persistence. `fileData: ""` is what makes
// it true end to end: the storage layer skips the Supabase Storage upload
// entirely when the body is empty (supabase-storage.createDocument), so an
// empty body here means no object in the bucket AND no base64 in the row.
//
// The failure case is covered deliberately: extraction throwing is not
// permission to keep the image the user asked us to discard.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { stubState, stubStorage } = vi.hoisted(() => {
  const state = {
    documents: [] as any[],
    created: [] as any[],
    profiles: [] as any[],
  };
  const impl: any = {
    async getDocuments() { return state.documents; },
    async createDocument(data: any) {
      const row = { id: `doc-${state.created.length + 1}`, createdAt: new Date().toISOString(), ...data };
      state.created.push(row);
      state.documents.push(row);
      return row;
    },
    async getProfiles() { return state.profiles; },
    async getProfile(id: string) { return state.profiles.find((p: any) => p.id === id); },
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

// Extraction fails, so the upload lands on the "save the document anyway" path.
// That is exactly where a discarded image is most at risk of being written.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: async () => { throw new Error("model unavailable"); },
    };
  },
}));

import { processFileUpload } from "../server/ai-engine";

const bytesFor = (s: string) => Buffer.from(s).toString("base64");

describe("processFileUpload — extract-only (discardImage)", () => {
  beforeEach(() => {
    stubState.documents.length = 0;
    stubState.created.length = 0;
    stubState.profiles.length = 0;
  });

  it("persists no image bytes and tags the document when discardImage is set", async () => {
    const result = await processFileUpload(
      "passport.jpg",
      "image/jpeg",
      bytesFor("passport photo bytes — must not be stored"),
      undefined,
      undefined,
      { discardImage: true },
    );

    expect(stubState.created).toHaveLength(1);
    const doc = stubState.created[0];
    // No base64 in the row, and an empty body means no Storage upload either.
    expect(doc.fileData).toBe("");
    expect(doc.tags).toContain("image-discarded");
    // Nothing that travels back to the client carries the bytes.
    expect(result.documentPreview?.data || "").toBe("");
    expect(JSON.stringify(result)).not.toContain(bytesFor("passport photo bytes — must not be stored"));
  });

  it("stores the file normally when discardImage is not set", async () => {
    const data = bytesFor("receipt bytes the user wants kept");
    await processFileUpload("receipt.jpg", "image/jpeg", data);

    expect(stubState.created).toHaveLength(1);
    const doc = stubState.created[0];
    expect(doc.fileData).toBe(data);
    expect(doc.tags).not.toContain("image-discarded");
  });
});
