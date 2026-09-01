// Extract-only uploads, driven through the REAL Express route.
//
// tests/upload-discard-image.test.ts proves the engine discards the bytes when
// it is told to. This one proves the ROUTE tells it to — that `discardImage`
// survives the trip from the request body into processFileUpload's options.
// Without it, the flag could be dropped in the handler and every engine test
// would still pass while the shipped feature silently stored every photo.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// No API key in CI, and extraction failing is the harsher case anyway: the
// upload lands on the "save the document even though extraction died" path,
// which is exactly where a discarded image is most at risk of being written.
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: async () => { throw new Error("model unavailable"); },
    };
  },
}));

import { startHarness, type Harness } from "./helpers/route-harness";

const SELF = { id: "self-1", type: "self", name: "Test" };
const PHOTO = Buffer.from("passport photo bytes — must not be stored").toString("base64");

let h: Harness;
beforeEach(async () => { h = await startHarness({ profiles: [SELF] }); });
afterEach(async () => { await h.close(); });

describe("POST /api/upload — extract-only", () => {
  it("stores no bytes when the request asks for the photo to be discarded", async () => {
    const r = await h.api("POST", "/api/upload", {
      fileName: "passport.jpg",
      mimeType: "image/jpeg",
      fileData: PHOTO,
      discardImage: true,
    });

    expect(r.status).toBe(200);
    expect(h.db.documents).toHaveLength(1);
    const doc = h.db.documents[0];
    // Empty body ⇒ supabase-storage skips the bucket upload entirely, so this
    // one assertion covers both "no object in Storage" and "no base64 in the row".
    expect(doc.fileData).toBe("");
    expect(doc.tags).toContain("image-discarded");
    // And nothing in the response carries the bytes back either.
    expect(JSON.stringify(r.data)).not.toContain(PHOTO);
  });

  it("stores the file normally when the request does not ask to discard it", async () => {
    const r = await h.api("POST", "/api/upload", {
      fileName: "receipt.jpg",
      mimeType: "image/jpeg",
      fileData: PHOTO,
    });

    expect(r.status).toBe(200);
    expect(h.db.documents).toHaveLength(1);
    expect(h.db.documents[0].fileData).toBe(PHOTO);
    expect(h.db.documents[0].tags).not.toContain("image-discarded");
  });

  it("applies the batch flag to every file in the batch", async () => {
    const r = await h.api("POST", "/api/upload/batch", {
      files: [
        { fileName: "a.jpg", mimeType: "image/jpeg", fileData: Buffer.from("aaa").toString("base64") },
        { fileName: "b.jpg", mimeType: "image/jpeg", fileData: Buffer.from("bbb").toString("base64") },
      ],
      discardImage: true,
    });

    expect(r.status).toBe(200);
    expect(h.db.documents).toHaveLength(2);
    for (const doc of h.db.documents) {
      expect(doc.fileData).toBe("");
      expect(doc.tags).toContain("image-discarded");
    }
  });
});
