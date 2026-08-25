import { describe, it, expect } from "vitest";
import {
  encodeWriteManifest,
  decodeWriteManifest,
  MANIFEST_MAX_BYTES,
  type WriteManifest,
} from "@shared/write-manifest";

describe("write manifest encoding", () => {
  it("round-trips a manifest through the header", () => {
    const manifest: WriteManifest = {
      domains: ["liabilities", "profiles"],
      changes: [
        { op: "create", endpoint: "/api/liabilities/l1/payments", id: "p1", row: { id: "p1", amount: 200 } },
        { op: "update", endpoint: "/api/profiles", id: "l1", row: { id: "l1", fields: { currentBalance: 800 } } },
      ],
    };
    const decoded = decodeWriteManifest(encodeWriteManifest(manifest));
    expect(decoded).toEqual(manifest);
  });

  it("survives row content that is not ASCII", () => {
    // A header value must be ASCII, and user data is not — a note with an
    // accent or an emoji must not make the manifest unsendable.
    const encoded = encodeWriteManifest({
      domains: ["expenses"],
      changes: [{ op: "create", endpoint: "/api/expenses", id: "e1", row: { id: "e1", description: "Café ☕ crème" } }],
    });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeWriteManifest(encoded)?.changes[0].row?.description).toBe("Café ☕ crème");
  });

  it("never throws on a header it cannot read", () => {
    expect(decodeWriteManifest(null)).toBeNull();
    expect(decodeWriteManifest("")).toBeNull();
    expect(decodeWriteManifest("not-base64-!!!")).toBeNull();
    expect(decodeWriteManifest(Buffer.from("[1,2,3]").toString("base64url"))).toBeNull();
    expect(decodeWriteManifest(Buffer.from('{"domains":[]}').toString("base64url"))).toBeNull();
  });

  it("drops the rows before it drops the domains", () => {
    // The degradation ladder is what makes the worst case "no worse than
    // before" rather than "wrong": domains always survive, because they are
    // what drives correctness. Rows are only an optimization.
    const fat = "x".repeat(4000);
    const encoded = encodeWriteManifest({
      domains: ["trackers"],
      changes: Array.from({ length: 4 }, (_, i) => ({
        op: "create" as const, endpoint: "/api/trackers", id: `t${i}`, row: { id: `t${i}`, notes: fat },
      })),
    });
    expect(encoded.length).toBeLessThanOrEqual(MANIFEST_MAX_BYTES);
    const decoded = decodeWriteManifest(encoded)!;
    expect(decoded.domains).toEqual(["trackers"]);
    expect(decoded.truncated).toBe(true);
    expect(decoded.changes).toHaveLength(4);
    expect(decoded.changes[0].row).toBeUndefined();
  });

  it("falls back to domains only when even the change list will not fit", () => {
    const decoded = decodeWriteManifest(encodeWriteManifest({
      domains: ["profiles"],
      changes: Array.from({ length: 500 }, (_, i) => ({
        op: "update" as const, endpoint: "/api/profiles", id: `id-${"y".repeat(40)}-${i}`,
      })),
    }))!;
    expect(decoded.domains).toEqual(["profiles"]);
    expect(decoded.changes).toEqual([]);
    expect(decoded.truncated).toBe(true);
  });

  it("sends nothing when there are no domains to report", () => {
    expect(encodeWriteManifest({ domains: [], changes: [] })).toBe("");
  });

  it("discards changes that carry no usable identity", () => {
    const raw = Buffer.from(JSON.stringify({
      domains: ["tasks"],
      changes: [{ op: "create", id: "" }, { op: "nope", id: "x" }, { op: "delete", id: "t1", endpoint: "/api/tasks" }],
    })).toString("base64url");
    expect(decodeWriteManifest(raw)!.changes).toEqual([{ op: "delete", endpoint: "/api/tasks", id: "t1" }]);
  });
});
