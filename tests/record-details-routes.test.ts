// /api/details/* through the REAL Express app (tests/helpers/route-harness):
// define a characteristic on the spot, set structured values, reuse one
// definition across records, report on it, and see rules raise and clear
// flags — on a car, a house, a person and a contract.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startHarness, type Harness } from "./helpers/route-harness";
import { recordDetailsKey, DETAIL_DEFS_PREF } from "../shared/record-details";

let h: Harness;

beforeEach(async () => {
  h = await startHarness({
    profiles: [
      { id: "car", type: "vehicle", name: "Honda Civic", fields: {}, tags: [] },
      { id: "truck", type: "vehicle", name: "F-150", fields: {}, tags: [] },
      { id: "house", type: "property", name: "Maple St house", fields: {}, tags: [] },
      { id: "me", type: "self", name: "Sam", fields: {}, tags: [] },
    ],
    documents: [{ id: "lease", name: "Office lease", type: "contract", fileData: "" }],
  });
});
afterEach(async () => { await h.close(); });

function rowsOf(data: any): Record<string, string> {
  if (!data || !Array.isArray(data.rows)) throw new Error(`no rows in ${JSON.stringify(data)}`);
  return Object.fromEntries(data.rows.map((r: any) => [r.definition.label, r.display]));
}

describe("record details routes", () => {
  it("defines Condition on the spot on a car and stores a structured value", async () => {
    const r = await h.api("POST", "/api/details/profile/car", {
      definition: { label: "Condition", kind: "condition" }, value: "good",
    });
    expect(r.status).toBe(201);
    expect(r.data.createdDefinition).toBe(true);
    expect(rowsOf(r.data)).toEqual({ Condition: "Good" });
    // Scoped to the record's type by default, not to everything.
    expect(r.data.definition.appliesTo).toEqual(["vehicle"]);
    const stored = JSON.parse(h.db.preferences![recordDetailsKey("profile", "car")]);
    expect(stored.values.condition.value).toBe("Good");
    // The write is reported under the "details" domain so the client refreshes it.
    expect(h.db.lastBumpedDomains).toContain("details");
  });

  it("the same name reuses one definition and widens its scope to the new record", async () => {
    await h.api("POST", "/api/details/profile/car", { definition: { label: "Condition", kind: "condition" }, value: "Good" });
    const house = await h.api("POST", "/api/details/profile/house", { definition: { label: "condition" }, value: "fair" });
    expect(house.status).toBe(200);
    expect(house.data.createdDefinition).toBe(false);
    expect(rowsOf(house.data)).toEqual({ Condition: "Fair" });
    const defs = JSON.parse(h.db.preferences![DETAIL_DEFS_PREF]);
    expect(defs).toHaveLength(1);
    expect(defs[0].appliesTo.sort()).toEqual(["property", "vehicle"]);
  });

  it("naming an existing characteristic with a different type is refused, not duplicated", async () => {
    await h.api("POST", "/api/details/profile/car", { definition: { label: "Condition", kind: "condition" }, value: "Good" });
    const r = await h.api("POST", "/api/details/profile/house", { definition: { label: "Condition", kind: "text" }, value: "ok-ish" });
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/already exists/);
  });

  it("a value the type can't hold is a 400 with the reason, and nothing is written", async () => {
    await h.api("POST", "/api/details/profile/car", { definition: { label: "Condition", kind: "condition" }, value: "Good" });
    const r = await h.api("PUT", "/api/details/profile/car/condition", { value: "sparkly" });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/one of: Excellent, Good, Fair, Poor/);
    const stored = JSON.parse(h.db.preferences![recordDetailsKey("profile", "car")]);
    expect(stored.values.condition.value).toBe("Good");
  });

  it("updates keep history; clearing removes the value", async () => {
    await h.api("POST", "/api/details/profile/car", { definition: { label: "Condition", kind: "condition" }, value: "Excellent" });
    const put = await h.api("PUT", "/api/details/profile/car/condition", { value: "Fair" });
    expect(put.status).toBe(200);
    const row = put.data.rows.find((r: any) => r.definition.id === "condition");
    expect(row.display).toBe("Fair");
    expect(row.history.map((x: any) => x.value)).toEqual(["Excellent"]);
    const del = await h.api("DELETE", "/api/details/profile/car/condition");
    expect(del.status).toBe(200);
    expect(del.data.rows).toEqual([]);
    expect(del.data.available.map((d: any) => d.id)).toEqual(["condition"]);
    expect(h.db.preferences![recordDetailsKey("profile", "car")]).toBeUndefined();
  });

  it("works on a document (contract) and a person, not only profiles of one kind", async () => {
    const signed = await h.api("POST", "/api/details/document/lease", { definition: { label: "Signed", kind: "boolean" }, value: "no" });
    expect(signed.status).toBe(201);
    expect(signed.data.definition.appliesTo).toEqual(["contract"]);
    expect(rowsOf(signed.data)).toEqual({ Signed: "No" });
    const blood = await h.api("POST", "/api/details/profile/me", {
      definition: { label: "Blood type", kind: "select", options: ["A+", "O+", "O-"] }, value: "o+",
    });
    expect(blood.status).toBe(201);
    expect(blood.data.definition.appliesTo).toEqual(["person"]);
    expect(rowsOf(blood.data)).toEqual({ "Blood type": "O+" });
  });

  it("refuses unknown record types and records that don't exist", async () => {
    expect((await h.api("GET", "/api/details/spaceship/x")).status).toBe(400);
    expect((await h.api("GET", "/api/details/profile/nope")).status).toBe(404);
    expect((await h.api("POST", "/api/details/profile/nope", { definition: { label: "X", kind: "text" }, value: "y" })).status).toBe(404);
  });

  it("rules raise flags from the value and stop when the value changes", async () => {
    const created = await h.api("POST", "/api/details/definitions", {
      label: "Condition", kind: "condition", appliesTo: ["vehicle"],
      rules: [{ op: "at_or_worse", value: "Fair", severity: "warning" }],
    });
    expect(created.status).toBe(201);
    const poor = await h.api("PUT", "/api/details/profile/car/condition", { value: "Poor" });
    expect(poor.data.flags.map((f: any) => f.message)).toEqual(["Condition is at or worse than Fair"]);
    const flags = await h.api("GET", "/api/details/flags");
    expect(flags.data.flags.map((f: any) => [f.name, f.flag.severity])).toEqual([["Honda Civic", "warning"]]);
    const good = await h.api("PUT", "/api/details/profile/car/condition", { value: "Good" });
    expect(good.data.flags).toEqual([]);
    expect((await h.api("GET", "/api/details/flags")).data.flags).toEqual([]);
  });

  it("a required characteristic flags every record it applies to that lacks it", async () => {
    await h.api("POST", "/api/details/definitions", { label: "VIN", kind: "text", appliesTo: ["vehicle"], required: true });
    await h.api("PUT", "/api/details/profile/car/vin", { value: "1HGBH41JXMN109186" });
    const flags = await h.api("GET", "/api/details/flags");
    expect(flags.data.flags.map((f: any) => f.name)).toEqual(["F-150"]);
  });

  it("reports every record by characteristic, filtered and ordered by the scale", async () => {
    await h.api("POST", "/api/details/definitions", { label: "Condition", kind: "condition", appliesTo: ["asset"] });
    await h.api("PUT", "/api/details/profile/car/condition", { value: "Good" });
    await h.api("PUT", "/api/details/profile/house/condition", { value: "Poor" });
    const all = await h.api("GET", "/api/details/report?definition=Condition");
    expect(all.status).toBe(200);
    // The truck has no condition yet: it is listed as missing, not left out.
    expect(all.data.rows.map((r: any) => [r.name, r.display])).toEqual([
      ["Honda Civic", "Good"], ["Maple St house", "Poor"], ["F-150", "—"],
    ]);
    expect(all.data.distribution).toEqual([{ value: "Good", count: 1 }, { value: "Poor", count: 1 }, { value: "—", count: 1 }]);
    const worn = await h.api("GET", "/api/details/report?definition=condition&op=at_or_worse&value=fair");
    expect(worn.data.rows.map((r: any) => r.name)).toEqual(["Maple St house"]);
    expect(worn.data.total).toBe(3);
    const missing = await h.api("GET", "/api/details/report?definition=condition&op=empty");
    expect(missing.data.rows.map((r: any) => r.name)).toEqual(["F-150"]);
    expect((await h.api("GET", "/api/details/report?definition=condition&op=within_days&value=3")).status).toBe(400);
  });

  it("renaming an option rewrites the records that hold it", async () => {
    await h.api("POST", "/api/details/definitions", { label: "Fuel", kind: "select", options: ["Gas", "EV"], appliesTo: ["vehicle"] });
    await h.api("PUT", "/api/details/profile/car/fuel", { value: "EV" });
    const patch = await h.api("PATCH", "/api/details/definitions/fuel", { options: ["Gas", "Electric"], renameOptions: { EV: "Electric" } });
    expect(patch.status).toBe(200);
    const car = await h.api("GET", "/api/details/profile/car");
    expect(rowsOf(car.data)).toEqual({ Fuel: "Electric" });
    expect(car.data.rows[0].stale).toBe(false);
  });

  it("refuses a type change that existing values wouldn't fit", async () => {
    await h.api("POST", "/api/details/definitions", { label: "Mileage", kind: "text", appliesTo: ["vehicle"] });
    await h.api("PUT", "/api/details/profile/car/mileage", { value: "about 80k" });
    const r = await h.api("PATCH", "/api/details/definitions/mileage", { kind: "number" });
    expect(r.status).toBe(409);
    expect(r.data.error).toMatch(/1 record has a value/);
  });

  it("deleting a characteristic removes its values everywhere", async () => {
    await h.api("POST", "/api/details/definitions", { label: "Color", kind: "text", appliesTo: ["vehicle"] });
    await h.api("PUT", "/api/details/profile/car/color", { value: "Blue" });
    await h.api("PUT", "/api/details/profile/truck/color", { value: "Red" });
    const usage = await h.api("GET", "/api/details/definitions");
    expect(usage.data.usage).toEqual({ color: 2 });
    const del = await h.api("DELETE", "/api/details/definitions/color");
    expect(del.data).toMatchObject({ success: true, removedValues: 2 });
    expect(Object.keys(h.db.preferences!).filter((k) => k.startsWith("details:"))).toEqual([]);
  });

  it("concurrent sets of different characteristics on one record both land", async () => {
    await h.api("POST", "/api/details/definitions", { label: "Color", kind: "text", appliesTo: ["vehicle"] });
    await h.api("POST", "/api/details/definitions", { label: "Condition", kind: "condition", appliesTo: ["vehicle"] });
    await Promise.all([
      h.api("PUT", "/api/details/profile/car/color", { value: "Blue" }),
      h.api("PUT", "/api/details/profile/car/condition", { value: "Good" }),
    ]);
    const car = await h.api("GET", "/api/details/profile/car");
    expect(rowsOf(car.data)).toEqual({ Color: "Blue", Condition: "Good" });
  });

  it("the generic preferences door can't write detail rows around the validation", async () => {
    const r = await h.api("PUT", `/api/preferences/${encodeURIComponent(recordDetailsKey("profile", "car"))}`, { value: "{}" });
    expect(r.status).toBe(400);
    const d = await h.api("PUT", `/api/preferences/${DETAIL_DEFS_PREF}`, { value: "[]" });
    expect(d.status).toBe(400);
  });
});

describe("global search finds records by their characteristic values", () => {
  it("'poor' finds the house whose Condition is Poor, saying why", async () => {
    const h2 = await startHarness({
      profiles: [{ id: "house", type: "property", name: "Maple St house", fields: {}, tags: [] }],
    });
    try {
      await h2.api("POST", "/api/details/profile/house", { definition: { label: "Condition", kind: "condition" }, value: "Poor" });
      const r = await h2.api("GET", "/api/search?q=poor");
      expect(r.status).toBe(200);
      const hit = r.data.find((x: any) => x.id === "house");
      expect(hit).toMatchObject({ _type: "profile", name: "Maple St house", _matchedDetail: "Condition: Poor", href: "/profiles/house" });
    } finally {
      await h2.close();
    }
  });
});
