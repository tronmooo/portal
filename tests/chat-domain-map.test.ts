/**
 * Every AI write tool must declare which cached data it invalidates.
 *
 * A chat turn commits its writes seconds before the model stops talking. The
 * client refreshes the affected screens from each `tool_result` frame's
 * `domains` field (@shared/cache-domains). A write tool with no mapping falls
 * back to "everything" at runtime — safe, but it means one `create_task`
 * refetches the entire app, which is the request storm this mechanism exists to
 * remove.
 *
 * The real risk this guards is worse than a storm: if someone ever "tidies" the
 * fallback into an empty array, an unmapped tool would refresh NOTHING and the
 * user would be back to reloading the whole app to see their own writes — the
 * 2026-08-02 report. So the map has to stay complete by construction.
 */
import { describe, it, expect } from "vitest";
import { TOOL_ACTION_MAP, READ_ONLY_TOOLS, streamDomainsForTool } from "../server/ai-engine";
import { TOOL_DOMAIN_MAP, domainsForTool, type Domain } from "@shared/cache-domains";
import { DOMAIN_KEYS_FOR_TEST } from "../client/src/lib/cache-bus";

describe("tool → cache domain map", () => {
  it("maps every tool that has a ParsedAction type", () => {
    const unmapped = Object.keys(TOOL_ACTION_MAP).filter((t) => domainsForTool(t) === null);
    expect(
      unmapped,
      `These tools have no entry in TOOL_DOMAIN_MAP (@shared/cache-domains). Add one — ` +
        `use ["everything"] if the tool can touch anything:\n  ${unmapped.join("\n  ")}`,
    ).toEqual([]);
  });

  it("gives every mapped write tool at least one domain", () => {
    const silent = Object.entries(TOOL_DOMAIN_MAP)
      .filter(([tool, domains]) => domains.length === 0 && !READ_ONLY_TOOLS.has(tool))
      // The handful of no-op entries are tools that carry a ParsedAction but
      // write nothing the UI caches (memory, bulk-action previews).
      .filter(([tool]) => !["recall_memory", "preview_bulk_action", "save_memory", "update_memory", "delete_memory"].includes(tool))
      .map(([tool]) => tool);
    expect(
      silent,
      `These write tools declare no domains, so a chat write using them would refresh nothing:\n  ${silent.join("\n  ")}`,
    ).toEqual([]);
  });

  it("only names domains the cache bus can actually expand", () => {
    const known = new Set(Object.keys(DOMAIN_KEYS_FOR_TEST) as Domain[]);
    const bogus: string[] = [];
    for (const [tool, domains] of Object.entries(TOOL_DOMAIN_MAP)) {
      for (const d of domains) if (!known.has(d)) bogus.push(`${tool} → ${d}`);
    }
    expect(
      bogus,
      `These map to domains the cache bus has no keys for, so they would invalidate nothing:\n  ${bogus.join("\n  ")}`,
    ).toEqual([]);
  });

  it("never returns an empty domain list for an unmapped write tool", () => {
    // The load-bearing fallback: an unknown WRITE tool must over-refresh.
    expect(streamDomainsForTool("some_tool_invented_next_month")).toEqual(["everything"]);
  });

  it("returns no domains for read-only tools", () => {
    for (const tool of ["search", "get_summary", "query_expenses", "open_document"]) {
      expect(streamDomainsForTool(tool), `${tool} is read-only and must not invalidate`).toEqual([]);
    }
  });

  it("routes the reported case — a tracker created in chat — to the trackers domain", () => {
    expect(streamDomainsForTool("create_tracker")).toContain("trackers");
    expect(streamDomainsForTool("log_tracker_entry")).toContain("trackers");
  });
});
