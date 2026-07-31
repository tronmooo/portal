// The asset and liability profile pages.
//
// Five screenshots, one complaint: "there's too much going on here." Three
// causes, and these are the guards for each so they don't come back.
//
//   1. A full-bleed saturated gradient band behind the title — the only one in
//      the app. Both pages hand-rolled their own.
//   2. The same facts rendered three times on a recurring bill (hero KPI strip,
//      Schedule & Calendar's 13-tile grid, Details' Bill details list), with two
//      of the copies disagreeing about the date.
//   3. 12px body type, with values the same size and weight as their labels.
//
// Source greps rather than renders: profile-detail.tsx is ~13.9k lines behind a
// lazy route with a dozen queries, and the thing being asserted here is which
// treatment the file reaches for — which is exactly what a grep can see.

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const root = (p: string) => path.resolve(__dirname, "..", p);
const read = (p: string) => fs.readFileSync(root(p), "utf8");

/** Strip comments — the removed patterns are QUOTED in the notes explaining
 *  why they went, and a guard that fires on its own documentation gets deleted.
 *  Note the optional `{`: a JSX comment opens with `{/*`. */
const code = (p: string) =>
  read(p).split("\n").filter((l) => !/^\s*(\{?\/\*|\/\/|\*)/.test(l)).join("\n");

const ASSET = "client/src/pages/profile-detail.tsx";
const LIABILITY = "client/src/pages/liability-detail.tsx";
const SCHEDULE = "client/src/components/liability/BillScheduleSection.tsx";
const HERO = "client/src/components/profile/DetailHero.tsx";

describe("one hero, shared by both profile pages", () => {
  it("neither page paints its own gradient band", () => {
    // profile-detail had an eleven-entry `getProfileBanner` map; liability-detail
    // had its rose-to-orange gradient inline on the header div.
    //
    // Scoped to a HEADER BAND, not to gradients generally: a 40px avatar-initials
    // circle two thousand lines down is a legitimate use, and a guard that fires
    // on it is a guard that gets switched off.
    for (const f of [ASSET, LIABILITY]) {
      expect(code(f), `${f} still declares a banner gradient`)
        .not.toContain("getProfileBanner");
      expect(code(f), `${f} still draws a gradient behind the page header`)
        .not.toMatch(/pt-4 pb-6"\s+style=\{\{\s*background:/);
      expect(code(f)).not.toMatch(/linear-gradient\(135deg,\s*hsl\(0 72% 28%\)/);
    }
  });

  it("both render DetailHero, so they cannot drift apart again", () => {
    // The user's ask was explicit: the asset and the liability have to keep
    // looking like each other. Sharing the component makes that structural
    // instead of something two files re-earn on every edit.
    for (const f of [ASSET, LIABILITY]) {
      expect(code(f), `${f} does not use DetailHero`).toMatch(/<DetailHero/);
    }
  });

  it("drops a stat tile whose count is zero", () => {
    // The asset hero spent a quarter of a phone screen on "0 DOCS / 0 TASKS".
    expect(code(HERO)).toMatch(/countTo == null \|\| s\.countTo > 0/);
  });

  it("builds the hero out of the shared primitives, not new ones", () => {
    const src = code(HERO);
    expect(src).toMatch(/className="bubble/);      // the app's card surface
    expect(src).toMatch(/<MetricCard/);            // the app's one stat tile
    expect(src).toMatch(/Medallion|medallion/);    // the app's icon treatment
  });

  it("takes its colour from the same map the Linked grid paints cards with", () => {
    for (const f of [ASSET, LIABILITY]) {
      expect(code(f)).toMatch(/profileVisual\(/);
    }
  });

  it("no longer prints the profile's own name inside its own breadcrumb", () => {
    // Title said "iPhone 17 Pro Max"; the trail one line below ended in
    // "… › iPhone 17 Pro Max".
    expect(code(ASSET)).toMatch(/omitCurrent/);
  });
});

describe("one home per fact", () => {
  const schedule = code(SCHEDULE);

  it("the schedule card stops repeating what the hero already says", () => {
    // Next due / amount due / frequency / remaining live in the hero now, in
    // much bigger type, directly above this card.
    for (const gone of ["Next due", "Amount due", "Frequency", "Autopay"]) {
      expect(schedule, `Schedule still has a "${gone}" tile`)
        .not.toMatch(new RegExp(`label="${gone}"`));
    }
  });

  it("renders no tile whose value is an em-dash", () => {
    // Six of the thirteen tiles read "—". A tile costs a tile of screen
    // whether or not it says anything.
    expect(schedule).not.toMatch(/label="[^"]+"\s+value=\{[^}]*:\s*"—"\}/);
    expect(schedule).toMatch(/\.filter\(/);
  });

  it("the Details tab states the term once, not three times", () => {
    // "Total term: Ongoing (no end date)", "Remaining: Ongoing" and
    // "Ends: No end date" were three rows of the same sentence in one card.
    const src = code(LIABILITY);
    expect(src).not.toContain('label="Total term"');
    expect(src).not.toContain('label="Ends"');
    expect(src).toContain('label="Term"');
  });

  it("nothing nested reads as an outcome, not as missing content", () => {
    expect(code(LIABILITY)).not.toContain("No nested liabilities yet.");
    expect(code(LIABILITY)).toMatch(/<EmptyState[\s\S]{0,400}nested-liabilities-empty/);
  });
});

describe("one date parse", () => {
  it("neither surface hand-rolls its own date parse any more", () => {
    // The whole bug: two local parses of the same field, one of which forgot
    // the time suffix and so read the day as UTC midnight.
    for (const f of [LIABILITY, SCHEDULE]) {
      expect(code(f), `${f} still constructs a Date from a raw ISO day`)
        .not.toMatch(/new Date\(\s*iso\b/);
    }
  });

  it("both route through formatFullDate", () => {
    for (const f of [LIABILITY, SCHEDULE]) {
      expect(code(f)).toMatch(/formatFullDate/);
    }
  });
});

describe("the type floor on these pages", () => {
  it("KpiTile is gone as a fourth card recipe", () => {
    // Its className carried `-card-`, which matches no rule in index.css.
    expect(code(LIABILITY)).not.toContain("-card-");
    expect(code(LIABILITY)).toMatch(/function KpiTile[\s\S]{0,600}<MetricCard/);
  });

  it("detail rows put the value a size and a weight above its label", () => {
    // A label/value list is read by scanning the right-hand column. At a
    // uniform 12px there was nothing to scan for.
    expect(code(LIABILITY)).toMatch(/function Row\([\s\S]{0,400}text-\[14px\] font-semibold/);
  });

  it("the schedule's fact tiles use the shared metric treatment", () => {
    expect(code(SCHEDULE)).toMatch(/metric-value text-\[17px\]/);
  });

  it("the field-delete button stays reachable on a phone", () => {
    // Hiding this behind `sm:group-hover` once made a field both unreadable and
    // undeletable. It is muted now, but it is never hidden.
    const src = code(ASSET);
    const del = src.match(/aria-label=\{`Delete \$\{label\}`\}[\s\S]{0,300}/)?.[0] ?? "";
    expect(del, "delete button not found").not.toBe("");
    expect(del).not.toMatch(/sm:opacity-0/);
  });
});
