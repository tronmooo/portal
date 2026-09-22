// @vitest-environment jsdom
/**
 * Rule 28 — profile pickers come from the canonical profile collection.
 *
 * A valid person like Morgan must appear in EVERY compatible picker: the
 * calendar "Link person" select (which filtered on a field that never
 * existed and was always empty), the quick-add owner select, the ownership
 * editor and the scope switcher (which collapsed two distinct people who
 * share a name into one).
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "fs";
import path from "path";

const apiRequestMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...actual, apiRequest: apiRequestMock };
});
vi.mock("@/lib/cache-bus", () => ({ invalidateDomains: vi.fn().mockResolvedValue(undefined) }));

import { offerablePeople, isOfferablePerson } from "../shared/entity-classify";
import { PERSON_TYPES, PERSON_LIKE_TYPES, isPersonType, isPersonLikeType } from "../shared/scope";
import { MultiProfileFilter } from "../client/src/components/MultiProfileFilter";
import { setFilterEveryone } from "../client/src/lib/profileFilter";

const REPO = path.resolve(__dirname, "..");
const src = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

const PROFILES = [
  { id: "self-1", type: "self", name: "Me" },
  { id: "avery-1", type: "person", name: "Avery" },
  { id: "morgan-1", type: "person", name: "Morgan" },
  { id: "morgan-2", type: "person", name: "Morgan" }, // a second, distinct Morgan
  { id: "mercedes-1", type: "person", name: "Mercedes" }, // a person whose name looks like a car
  { id: "rex-1", type: "pet", name: "Rex" },
  { id: "tv-1", type: "asset", name: "Samsung TV" },
  { id: "civic-1", type: "vehicle", name: "Honda Civic" },
  { id: "gone-1", type: "person", name: "Gone", fields: { deleted: true } },
  { id: "biz-1", type: "business", name: "Acme LLC" },
];

afterEach(() => {
  cleanup();
  apiRequestMock.mockReset();
  setFilterEveryone();
});

describe("offerablePeople — the one people-picker source", () => {
  it("lists Self, every person (Morgan twice, Mercedes) and pets; never things or deleted rows", () => {
    expect(offerablePeople(PROFILES).map(p => p.id)).toEqual(["self-1", "avery-1", "morgan-1", "morgan-2", "mercedes-1", "rex-1"]);
  });
  it("leaves pets out for a people-only surface and lets a finance surface include businesses", () => {
    expect(offerablePeople(PROFILES, { includePets: false }).map(p => p.id)).not.toContain("rex-1");
    expect(offerablePeople(PROFILES, { includeBusiness: true }).map(p => p.id)).toContain("biz-1");
  });
  it("excludes the record being edited", () => {
    expect(offerablePeople(PROFILES, { exclude: ["avery-1"] }).map(p => p.id)).not.toContain("avery-1");
  });
  it("an explicit person row is never hidden because its name looks like a thing", () => {
    expect(isOfferablePerson({ type: "person", name: "Mercedes" })).toBe(true);
    expect(isOfferablePerson({ type: "person", name: "My Mom" })).toBe(true);
    expect(isOfferablePerson({ type: "asset", name: "Bob" })).toBe(false);
  });
  it("shared/scope.ts owns the person-type vocabulary the client copies used to redefine", () => {
    expect([...PERSON_TYPES].sort()).toEqual(["person", "self"]);
    expect([...PERSON_LIKE_TYPES].sort()).toEqual(["person", "pet", "self"]);
    expect(isPersonType("Person")).toBe(true);
    expect(isPersonLikeType("pet")).toBe(true);
    expect(isPersonType("pet")).toBe(false);
  });
});

describe("the client pickers read the canonical list (source contract)", () => {
  it("CalendarManagerPanel's Link-person select uses offerablePeople and no longer filters on the nonexistent entityType", () => {
    const text = src("client/src/components/CalendarManagerPanel.tsx");
    expect(text).toMatch(/offerablePeople\(profiles\)/);
    expect(text).not.toMatch(/p\.entityType === "person"/);
  });
  it("QuickAddDialog, OwnershipEditor and MultiProfileFilter use offerablePeople; no client file redefines PERSON_TYPES", () => {
    expect(src("client/src/components/dashboard/quick-add/QuickAddDialog.tsx")).toMatch(/offerablePeople\(/);
    expect(src("client/src/components/OwnershipEditor.tsx")).toMatch(/offerablePeople\(/);
    expect(src("client/src/components/MultiProfileFilter.tsx")).toMatch(/offerablePeople\(/);
    for (const rel of [
      "client/src/components/OwnershipEditor.tsx",
      "client/src/components/asset/asset-overview.tsx",
      "client/src/pages/profile-info.tsx",
      "client/src/pages/profile-route-dispatch.tsx",
    ]) {
      expect(src(rel), rel).not.toMatch(/const PERSON_TYPES = new Set\(/);
    }
  });
  it("MultiProfileFilter dedupes by id, not by type::name", () => {
    const text = src("client/src/components/MultiProfileFilter.tsx");
    expect(text).not.toMatch(/\$\{p\.type\}::\$\{p\.name\}/);
    expect(text).toMatch(/deduped\.has\(p\.id\)/);
  });
});

describe("MultiProfileFilter (rendered) keeps two same-named people", () => {
  it("offers both Morgans, Mercedes and Rex, and no asset", async () => {
    apiRequestMock.mockImplementation(async (_m: string, url: string) =>
      new Response(JSON.stringify(url.includes("/api/profiles") ? PROFILES : []), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MultiProfileFilter />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("button-profile-filter"));
    await waitFor(() => expect(screen.queryByTestId("filter-profile-morgan-1")).not.toBeNull());
    expect(screen.queryByTestId("filter-profile-morgan-2")).not.toBeNull();
    expect(screen.queryByTestId("filter-profile-mercedes-1")).not.toBeNull();
    expect(screen.queryByTestId("filter-profile-rex-1")).not.toBeNull();
    expect(screen.queryByTestId("filter-profile-tv-1")).toBeNull();
    expect(screen.queryByTestId("filter-profile-gone-1")).toBeNull();
  });
});
