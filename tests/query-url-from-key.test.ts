/**
 * A query key is the whole address of its data.
 *
 * Keys follow [endpoint, mode, ...selectedIds, ...extra] (shared/query-keys).
 * The dashboard seeds one slot per profile scope with no query function of
 * its own, so any refetch of such a slot goes through the default query
 * function. That function used to fetch key[0] verbatim — the bare endpoint,
 * i.e. the whole household — and stored the result under the OTHER profile's
 * key: after one tracker log, Bob's trackers slot held Alex's ten trackers and
 * stayed "fresh" for three minutes (probe p08, 2026-09-02).
 */
import { describe, it, expect } from "vitest";
import { urlForQueryKey, queryClient } from "../client/src/lib/queryClient";

const A = "06ae8f15-b152-4431-8d88-43fe97785383";
const B = "6047d1d3-db76-42dd-819d-366c772bafcf";

describe("urlForQueryKey", () => {
  it("bare and 'everyone' keys are the endpoint itself", () => {
    expect(urlForQueryKey(["/api/trackers"])).toBe("/api/trackers");
    expect(urlForQueryKey(["/api/trackers", "everyone"])).toBe("/api/trackers");
    expect(urlForQueryKey(["/api/trackers", "everyone", "trends"])).toBe("/api/trackers");
  });

  it("a 'selected' key asks for exactly its ids", () => {
    expect(urlForQueryKey(["/api/trackers", "selected", A])).toBe(`/api/trackers?profileIds=${A}`);
    expect(urlForQueryKey(["/api/tasks", "selected", A, B])).toBe(`/api/tasks?profileIds=${A},${B}`);
  });

  it("trailing discriminators are not ids", () => {
    expect(urlForQueryKey(["/api/trackers", "selected", A, "trends"])).toBe(`/api/trackers?profileIds=${A}`);
    expect(urlForQueryKey(["/api/incomes", "selected", A, "hero"])).toBe(`/api/incomes?profileIds=${A}`);
    expect(urlForQueryKey(["/api/budgets/summary", "selected", A, "2026-09", "hero"])).toBe(`/api/budgets/summary?profileIds=${A}`);
  });

  it("recognises non-UUID ids once the profile list is cached", () => {
    queryClient.setQueryData(["/api/profiles"], [{ id: "prof-1", type: "self" }, { id: "prof-2", type: "person" }]);
    try {
      expect(urlForQueryKey(["/api/tasks", "selected", "prof-2"])).toBe("/api/tasks?profileIds=prof-2");
      expect(urlForQueryKey(["/api/tasks", "selected", "prof-2", "hero"])).toBe("/api/tasks?profileIds=prof-2");
    } finally {
      queryClient.removeQueries({ queryKey: ["/api/profiles"], exact: true });
    }
  });

  it("leaves keys that already carry a query string, and non-scope shapes, alone", () => {
    expect(urlForQueryKey([`/api/trackers?profileIds=${A}`, "selected", A])).toBe(`/api/trackers?profileIds=${A}`);
    expect(urlForQueryKey(["/api/calendar/timeline", "2026-08-25", "2026-10-17", "selected", A])).toBe("/api/calendar/timeline");
    expect(urlForQueryKey(["/api/profiles", A, "detail"])).toBe("/api/profiles");
  });
});
