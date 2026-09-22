// Consistency layer — canonical entity types, search grouping, NL creation guard (req. tests 4, 5).
import { describe, expect, it } from "vitest";
import {
  canonicalEntityType, canonicalTypeOfProfile, searchGroupFor, iconNameFor, classifyEntityDescription,
  resolveProfileTypeForCreate, CANONICAL_ENTITY_TYPES, ENTITY_TYPE_META, isPersonEntity, isObligationFieldKey,
} from "../shared/domain";

describe("canonical entity types", () => {
  it("names every required type", () => {
    for (const t of ["person", "pet", "asset", "liability", "account", "subscription", "expense", "income", "payment", "event", "task", "reminder", "habit", "tracker", "document", "artifact", "note", "journal_entry", "health_record", "contact_info", "recurring_rule"]) {
      expect(CANONICAL_ENTITY_TYPES).toContain(t);
      expect(ENTITY_TYPE_META[t as keyof typeof ENTITY_TYPE_META].label).toBeTruthy();
    }
  });
  it("maps storage profile types to product meaning", () => {
    expect(canonicalTypeOfProfile({ type: "self" })).toBe("person");
    expect(canonicalTypeOfProfile({ type: "vehicle" })).toBe("asset");
    expect(canonicalTypeOfProfile({ type: "loan" })).toBe("liability");
    expect(canonicalTypeOfProfile({ type: "liability", type_key: "streaming" })).toBe("subscription");
    expect(canonicalTypeOfProfile({ type: "account", fields: { accountKind: "credit_card" } })).toBe("liability");
    expect(canonicalTypeOfProfile({ type: "account", fields: { accountKind: "checking" } })).toBe("account");
    expect(canonicalEntityType("artifact", { type: "note" })).toBe("note");
    expect(canonicalEntityType("obligation", { kind: "subscription" })).toBe("subscription");
  });
});

describe("12. Custom fields are not garbage storage", () => {
  it("a parking-ticket due date is an obligation field; a passport expiration is the person's own", () => {
    expect(isObligationFieldKey("dueDate")).toBe(true);
    expect(isObligationFieldKey("DUE DATE")).toBe(false);
    expect(isObligationFieldKey("due_date")).toBe(true);
    expect(isObligationFieldKey("citationNumber")).toBe(true);
    expect(isObligationFieldKey("amountDue")).toBe(true);
    expect(isObligationFieldKey("passportExpiration")).toBe(false);
    expect(isObligationFieldKey("dateOfBirth")).toBe(false);
  });
});

describe("4. Search respects entity types", () => {
  it("vehicles, loans and subscriptions never land under People, and carry their own icon", () => {
    expect(searchGroupFor("profile", { type: "vehicle", name: "Dodge Ram" })).toBe("Assets");
    expect(searchGroupFor("profile", { type: "loan", name: "Auto Loan" })).toBe("Liabilities");
    expect(searchGroupFor("profile", { type: "subscription", name: "Netflix" })).toBe("Subscriptions");
    expect(searchGroupFor("profile", { type: "person", name: "Jane" })).toBe("People");
    expect(iconNameFor("profile", { type: "vehicle" })).toBe("Car");
    expect(iconNameFor("profile", { type: "person" })).toBe("User");
    expect(iconNameFor("profile", { type: "loan" })).not.toBe("User");
    expect(isPersonEntity(canonicalEntityType("profile", { type: "subscription" }))).toBe(false);
  });
});

describe("5. Natural language cannot accidentally create a person from an asset description", () => {
  it("'tires for my Dodge Ram' resolves to a component of a vehicle, never a person", () => {
    const c = classifyEntityDescription("tires for my Dodge Ram");
    expect(c.type).toBe("asset");
    expect(c.isComponent).toBe(true);
    expect(c.associatedEntityName).toBe("Dodge Ram");
    expect(c.name).toBe("Tires");
    expect(c.type).not.toBe("person");
  });
  it("the create-door type resolver never falls back to person", () => {
    expect(resolveProfileTypeForCreate("tires for my Dodge ram", "person")).not.toBe("person");
    expect(resolveProfileTypeForCreate("tires for my Dodge ram", undefined)).not.toBe("person");
    expect(resolveProfileTypeForCreate("tires for my Dodge ram", "car_part")).not.toBe("person");
    expect(resolveProfileTypeForCreate("my MacBook Pro M4 Financing", "person")).toBe("liability");
    expect(resolveProfileTypeForCreate("Dana", "person")).toBe("person");
    expect(resolveProfileTypeForCreate("Rex", "pet")).toBe("pet");
    expect(resolveProfileTypeForCreate("Honda Civic", "vehicle")).toBe("vehicle");
  });
  it("payments, loans and subscriptions classify as their own kinds", () => {
    expect(classifyEntityDescription("auto loan payment $912.40").type).toBe("payment");
    expect(classifyEntityDescription("Netflix subscription").type).toBe("subscription");
    expect(classifyEntityDescription("mortgage on my house").type).toBe("liability");
  });
});
