// Guard: a screen that prints an owner's name beside a dated item's title
// goes through ownerLabelForDatedItem (shared/birthday-event).
//
// User report 2026-11-11: "🎂 Jordan's birthday / Birthday · Bob Robertson".
// The event was stored under the account holder (Jordan had no profile), and
// the card printed that owner beside the title, which read as Bob's
// birthday. The same raw lookup sat in five other places (Upcoming rows, the
// calendar manager's cards and rows, the detail panel's Source, the
// briefing's upcoming chips). This test fails when a new one appears.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { ownerLabelForDatedItem, personNamedByTitle } from "../shared/birthday-event";

const ROOT = path.resolve(__dirname, "../client/src");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

// An owner name looked up for a calendar series/occurrence, or the briefing's
// owner-name helper.
const OWNER_LOOKUP = [
  /source\.profileId\s*\?\s*[\w.]*profileName\??\.?\(/,
  /profileName\??\.?\(\s*[\w.]*source\.profileId/,
  /profileName\??\.?\(\s*ownerId\s*\)/,
  /owners\.names\(/,
];

describe("every owner shown beside a dated item goes through ownerLabelForDatedItem", () => {
  const files = walk(ROOT).filter((f) => OWNER_LOOKUP.some((re) => re.test(fs.readFileSync(f, "utf8"))));

  it("the scan finds the known surfaces (so it cannot pass by matching nothing)", () => {
    const rel = files.map((f) => path.relative(ROOT, f)).sort();
    for (const known of [
      "components/calendar/CalendarItemDetail.tsx",
      "components/recurring/RecurringDatesManager.tsx",
      "components/recurring/RecurringDatesPage.tsx",
      "components/dashboard/BriefingPopups.tsx",
    ]) expect(rel).toContain(known);
  });

  for (const f of walk(ROOT).filter((f) => OWNER_LOOKUP.some((re) => re.test(fs.readFileSync(f, "utf8"))))) {
    it(path.relative(ROOT, f), () => {
      expect(fs.readFileSync(f, "utf8")).toMatch(/ownerLabelForDatedItem\(/);
    });
  }

  it("RecurringRuleCard's meta line uses it", () => {
    const src = fs.readFileSync(path.join(ROOT, "components/calendar/RecurringRuleCard.tsx"), "utf8");
    expect(src).toMatch(/ownerLabelForDatedItem\(series\.title, ownerName\)/);
  });
});

describe("the rule: a title about someone else never shows the owner", () => {
  const BOB = "Bob Robertson";
  it.each([
    ["🎂 Jordan's birthday", undefined],
    ["Jordan's Anniversary", undefined],
    ["Jordan's dentist appointment", undefined],
    ["Mary Lee's graduation", undefined],
    ["Jordan’s soccer game", undefined],
    ["Bob's Birthday", BOB],
    ["Robertson's anniversary", undefined],
    ["Birthday", BOB],
    ["Mother's Day", BOB],
    ["Valentine's Day", BOB],
    ["St. Patrick's Day", BOB],
    ["Today's plan", BOB],
    ["Calendar Review", BOB],
    ["Demo Music Subscription", BOB],
  ])("%s → %s", (title, expected) => {
    expect(ownerLabelForDatedItem(title, BOB)).toBe(expected);
  });

  it("names it reads", () => {
    expect(personNamedByTitle("🎂 Jordan's birthday")).toBe("jordan");
    expect(personNamedByTitle("Planning Call")).toBeNull();
    expect(ownerLabelForDatedItem("Jordan's birthday", "Jordan Lee")).toBe("Jordan Lee");
    expect(ownerLabelForDatedItem("Jordan's birthday", "")).toBeUndefined();
  });
});
