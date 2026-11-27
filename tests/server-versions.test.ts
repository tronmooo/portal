// A tab learns that ANOTHER device wrote from the server's version map, and
// re-reads only the domains that moved (owner, 2026-11-27: "Every device
// receives relevant updates"). Integrity run: a payment recorded elsewhere left
// an open loan's header on the old balance until a reload.
import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import fs from "node:fs";
import { observeServerVersions, resetServerVersions, ALL_DOMAINS, SERVER_VERSION_HEADER } from "../client/src/lib/server-versions";
import { startHarness, type Harness } from "./helpers/route-harness";

beforeEach(() => resetServerVersions());

describe("which domains another device moved", () => {
  it("the first map a session sees is a baseline: nothing is re-read", () => {
    expect(observeServerVersions("epoch:10,tasks:4,liabilities:7")).toEqual([]);
  });

  it("a counter that rose with no write of this tab's is another device's", () => {
    observeServerVersions("epoch:10,tasks:4,liabilities:7");
    expect(observeServerVersions("epoch:11,tasks:4,liabilities:8")).toEqual(["liabilities"]);
    // seen once: the same map again moves nothing
    expect(observeServerVersions("epoch:11,tasks:4,liabilities:8")).toEqual([]);
  });

  it("this tab's own write explains exactly one step of the domains it wrote", () => {
    observeServerVersions("epoch:10,tasks:4,liabilities:7");
    expect(observeServerVersions("epoch:11,tasks:5,liabilities:7", { ownDomains: ["tasks"] })).toEqual([]);
  });

  it("…but not a domain it did not write, nor a second step in its own domain", () => {
    observeServerVersions("epoch:10,tasks:4,liabilities:7");
    // while this tab ticked a task, somebody else paid the loan and added a task
    expect(observeServerVersions("epoch:13,tasks:6,liabilities:8", { ownDomains: ["tasks"] }).sort()).toEqual(["liabilities", "tasks"]);
  });

  it("a domain seen for the first time has been written since the baseline", () => {
    observeServerVersions("epoch:10,tasks:4");
    expect(observeServerVersions("epoch:11,tasks:4,budgets:1")).toEqual(["budgets"]);
  });

  it("the account moved and nothing was named: everything is read again — unless it was this tab", () => {
    observeServerVersions("epoch:10,tasks:4");
    expect(observeServerVersions("epoch:11,tasks:4")).toEqual([ALL_DOMAINS]);
    expect(observeServerVersions("epoch:12,tasks:4", { ownDomains: [] })).toEqual([]);
  });

  it("an older or unreadable map never walks the baseline backwards", () => {
    observeServerVersions("epoch:10,tasks:4");
    expect(observeServerVersions("epoch:9,tasks:3")).toEqual([]);
    expect(observeServerVersions("")).toEqual([]);
    expect(observeServerVersions(null)).toEqual([]);
    expect(observeServerVersions("epoch:11,tasks:5")).toEqual(["tasks"]);
  });
});

describe("the server says where the account is on every read", () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness({ domainVersions: { epoch: 12, tasks: 5 } } as any); });
  afterAll(async () => { await h.close(); });

  it("GET /api/data-version answers with the version map in a header and nothing cacheable", async () => {
    const r = await h.api("GET", "/api/data-version");
    expect(r.status).toBe(200);
    expect(r.headers[SERVER_VERSION_HEADER.toLowerCase()]).toMatch(/epoch:12/);
    expect(r.headers[SERVER_VERSION_HEADER.toLowerCase()]).toMatch(/tasks:5/);
    expect(r.headers["cache-control"]).toMatch(/no-store/);
  });

  it("an ordinary list read carries it too, and a write does not", async () => {
    const list = await h.api("GET", "/api/tasks");
    expect(list.headers[SERVER_VERSION_HEADER.toLowerCase()]).toMatch(/epoch:/);
    const write = await h.api("POST", "/api/tasks", { title: "x" });
    expect(write.headers[SERVER_VERSION_HEADER.toLowerCase()]).toBeUndefined();
  });
});

describe("wiring", () => {
  const read = (rel: string) => fs.readFileSync(`${process.cwd()}/${rel}`, "utf8");
  it("every response the client reads is offered to the observer, and a write names its own domains", () => {
    const qc = read("client/src/lib/queryClient.ts");
    expect(qc.match(/noteServerVersions\(res\.headers\?\.get\?\.\(SERVER_VERSION_HEADER\)\)/g)?.length).toBe(2);
    expect(qc).toMatch(/noteServerVersions\(res\.headers\.get\("X-Data-Version"\), Array\.isArray\(\(manifest as any\)\?\.domains\)/);
    expect(qc).toMatch(/resetServerVersions\(\);/); // sign-out
  });
  it("the app asks on navigation, on return to the tab and on a timer", () => {
    const app = read("client/src/App.tsx");
    expect(app).toMatch(/<VersionWatch \/>/);
    for (const ev of ["hashchange", "visibilitychange", "focus"]) expect(app).toContain(`addEventListener("${ev}"`);
    expect(app).toMatch(/setInterval\(check, VERSION_CHECK_EVERY_MS\)/);
  });
  it("the header can be read cross-origin (the native shell)", () => {
    expect(read("server/routes.ts")).toMatch(/Access-Control-Expose-Headers", "[^"]*X-Server-Data-Version/);
  });
});
