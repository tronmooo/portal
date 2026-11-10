// @vitest-environment jsdom
//
// Rule 4 guard — a profile scope can never make a list look empty.
//
// 2026-11-09 tutorial report: chat added two tasks, both stored, yet the
// Tasks page said "Nothing on your list · 0 active · 0 completed". A profile
// selection left over from an earlier screen hid them, and nothing on the
// page said a filter was on. The page is fixed (tests/sync-tasks-scope-
// notice.dom.test.tsx); this file makes the CLASS of bug fail the build:
//
//   1. Every shared <EmptyState> in a file that reads the app-wide profile
//      scope must declare scope="global" (the empty state then names the
//      active scope and offers "Show everyone") or scope="none" (the list
//      does not depend on it). A new scoped page cannot ship a bare
//      "No X yet" without someone deciding.
//   2. scope="global" really does disclose an active scope, and its
//      "Show everyone" really clears it.
//   3. The filter chip's label rule never calls a selection "Everyone".
import React from "react";
import fs from "fs";
import path from "path";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { EmptyState } from "../client/src/components/ui/empty-state";
import { setFilterEveryone, setFilterSelected, getProfileFilter, scopeLabel } from "../client/src/lib/profileFilter";

const ROOT = path.resolve(__dirname, "../client/src");
// How a file reads the app-wide scope: the hook, the store, the chip, or the
// scope handed down as props / a ?profileIds= query.
const READS_SCOPE = /useProfileScope\(|getProfileFilter(?:Snapshot)?\(|<MultiProfileFilter|\bfilterIds\b|\bfilterMode\b|profileIds=/;
const IMPORTS_SHARED_EMPTY_STATE = /from\s+["']@\/components\/ui\/empty-state["']/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("Rule 4 guard: every scoped EmptyState declares its scope", () => {
  const files = walk(ROOT).filter((f) => {
    const src = fs.readFileSync(f, "utf8");
    return IMPORTS_SHARED_EMPTY_STATE.test(src) && READS_SCOPE.test(src);
  });

  it("finds the scoped pages (the scan itself works)", () => {
    const rel = files.map((f) => path.relative(ROOT, f));
    // If these stop matching, the detection broke — not the rule.
    expect(rel).toContain("pages/tasks.tsx");
    expect(rel).toContain("pages/habits.tsx");
    expect(rel).toContain("pages/journal.tsx");
    expect(rel).toContain("components/dashboard/TaskHabitPopups.tsx");
  });

  it("no <EmptyState> in a scope-reading file leaves scope undeclared", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      const re = /<EmptyState\b([\s\S]*?)\/>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        if (!/\bscope=\{?["'](global|none)["']\}?/.test(m[1])) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${path.relative(ROOT, f)}:${line}`);
        }
      }
    }
    expect(offenders, `EmptyState without scope="global" | scope="none" in a scoped file:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the Tasks page's own list empty states disclose the scope", () => {
    const src = fs.readFileSync(path.join(ROOT, "pages/tasks.tsx"), "utf8");
    expect(src).toMatch(/<EmptyState scope="global"[\s\S]*?label="No active tasks"/);
    expect(src).toMatch(/<EmptyState scope="global"[\s\S]*?label="No completed tasks"/);
    // "Nothing on your list" is reached only when the scope hides nothing.
    expect(src).toMatch(/visibleTasks\.length === 0 && hiddenByScope > 0 \?[\s\S]*?<FilteredEmptyState/);
  });
});

describe("EmptyState scope=\"global\" says when a profile filter is on", () => {
  afterEach(() => { cleanup(); setFilterEveryone(); });

  it("names the scope, says hidden-not-deleted, and Show everyone clears it", async () => {
    setFilterSelected(["max-id"], ["Max"]);
    render(<EmptyState scope="global" label="No streaks going yet" />);
    const note = screen.getByTestId("empty-state-scope");
    expect(note.textContent).toContain("Max");
    expect(note.textContent).toMatch(/hidden, not deleted/);
    await act(async () => { fireEvent.click(screen.getByTestId("empty-state-scope-clear")); });
    expect(getProfileFilter().mode).toBe("everyone");
    expect(screen.queryByTestId("empty-state-scope")).toBeNull();
  });

  it("says nothing extra under Everyone", () => {
    setFilterEveryone();
    render(<EmptyState scope="global" label="No journal entries yet" />);
    expect(screen.getByTestId("empty-state-title").textContent).toBe("No journal entries yet");
    expect(screen.queryByTestId("empty-state-scope")).toBeNull();
  });

  it("scope=\"none\" never mentions the scope", () => {
    setFilterSelected(["max-id"], ["Max"]);
    render(<EmptyState scope="none" label="No documents" />);
    expect(screen.getByTestId("empty-state-title")).toBeTruthy();
    expect(screen.queryByTestId("empty-state-scope")).toBeNull();
  });
});

describe("the chip's label never calls a selection \"Everyone\"", () => {
  it("scopeLabel", () => {
    expect(scopeLabel([], "everyone", 0)).toBe("Everyone");
    expect(scopeLabel(["Max"], "selected", 1)).toBe("Max");
    expect(scopeLabel([""], "selected", 1)).toBe("1 profile");
    expect(scopeLabel([], "selected", 2)).toBe("2 profiles");
    expect(scopeLabel(["Me", "Dana"], "selected", 2)).toBe("Me & Dana");
    expect(scopeLabel(["Me", "Dana", "Max"], "selected", 3)).toBe("Me +2");
    for (const n of [1, 2, 3]) expect(scopeLabel([], "selected", n)).not.toBe("Everyone");
  });

  it("MultiProfileFilter labels with scopeLabel from the live scope snapshot", () => {
    const src = fs.readFileSync(path.join(ROOT, "components/MultiProfileFilter.tsx"), "utf8");
    expect(src).toMatch(/const liveScope = useProfileScope\(\)/);
    expect(src).toMatch(/controlled \? value : liveScope/);
    expect(src).toMatch(/scopeLabel\(/);
    expect(src).not.toMatch(/return "Everyone";\s*\}, \[filter\]\)/);
  });
});
