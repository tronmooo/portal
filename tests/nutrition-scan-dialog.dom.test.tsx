// @vitest-environment jsdom
//
// The "Scan label" dialog (client/src/components/nutrition/NutritionScanDialog.tsx),
// rendered for real with the network replaced. What must hold:
//   · opening and reading write nothing — only "Log it" posts an entry (Rule 3);
//   · what was read is shown BEFORE logging: serving, every printed nutrient,
//     % Daily Values, and the figures for the amount the user types, worked out
//     from the label's own serving;
//   · a nutrient the label does not print is named as not stated, never 0 (N3);
//   · a failure is an error with a retry, never an empty label (Rule 7).
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const calls: Array<{ method: string; url: string; body?: any }> = [];
let respond: (method: string, url: string, body?: any) => any;
vi.mock("@/lib/queryClient", () => ({
  apiRequest: async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    const out = respond(method, url, body);
    if (out instanceof Error) throw out;
    return { ok: true, json: async () => out } as any;
  },
}));

import { NutritionScanDialog } from "../client/src/components/nutrition/NutritionScanDialog";

const LABEL = {
  productName: "Sea Salt Kettle Chips", brand: "Ridgeline", origin: "photo",
  serving: { text: "about 15 chips (28g)", grams: 28, householdAmount: 15, householdUnit: "chips" },
  servingsPerContainer: 3,
  // Sugar was printed "<1g": the reader left it out.
  perServing: { calories: 150, fat: 9, saturatedFat: 1.5, sodium: 170, carbs: 16, fiber: 1, protein: 2 },
  dailyValues: { fat: 12, sodium: 7 },
};
const picture = () => new File([new Uint8Array([1, 2, 3])], "label.png", { type: "image/png" });
const writes = () => calls.filter((c) => c.method !== "GET" && c.url !== "/api/nutrition/scan-label");

beforeEach(() => { calls.length = 0; respond = () => ({ kind: "label", label: LABEL }); });
afterEach(cleanup);

async function scanned() {
  const logged: string[] = [];
  render(<NutritionScanDialog open onClose={() => {}} onLogged={(s) => logged.push(s)} />);
  fireEvent.change(screen.getByTestId("scan-input-library"), { target: { files: [picture()] } });
  await screen.findByTestId("scan-review");
  return logged;
}

describe("scanning a label", () => {
  it("opening the dialog requests nothing", () => {
    render(<NutritionScanDialog open onClose={() => {}} />);
    expect(calls).toHaveLength(0);
    expect(screen.getByTestId("scan-take-photo")).toBeTruthy();
    expect(screen.getByTestId("scan-barcode-input")).toBeTruthy();
  });

  it("shows what was read before anything is logged: serving, printed nutrients, % DV, and what the label does not state", async () => {
    await scanned();
    expect(writes()).toHaveLength(0);
    expect(screen.getByTestId("scan-review").textContent).toContain("about 15 chips (28g)");
    expect(screen.getByTestId("scan-review").textContent).toContain("3 servings per container");
    expect(screen.getByTestId("scan-source").textContent).toContain("the label in your photo");
    expect(screen.getByTestId("scan-row-calories").textContent).toContain("150 kcal");
    expect(screen.getByTestId("scan-row-fat").textContent).toContain("12%");
    // Sugar is not on the reading: no row, and it is named as unknown.
    expect(screen.queryByTestId("scan-row-sugar")).toBeNull();
    expect(screen.getByTestId("scan-not-stated").textContent).toContain("sugar");
    // With no amount typed it is one serving, and says so.
    expect(screen.getByTestId("scan-method").textContent).toMatch(/No amount given/);
  });

  it("the amount typed is read against the label's serving and the figures follow", async () => {
    await scanned();
    const amount = screen.getByTestId("scan-quantity");
    fireEvent.change(amount, { target: { value: "the whole bag" } });
    expect(screen.getByTestId("scan-method").textContent).toContain("3 servings");
    expect(screen.getByTestId("scan-row-calories").textContent).toContain("450 kcal");
    expect(screen.getByTestId("scan-row-sodium").textContent).toContain("510 mg");
    expect(screen.getByTestId("scan-row-fat").textContent).toContain("36%");
    fireEvent.change(amount, { target: { value: "42 g" } });
    expect(screen.getByTestId("scan-row-calories").textContent).toContain("225 kcal");
    fireEvent.change(amount, { target: { value: "30 chips" } });
    expect(screen.getByTestId("scan-row-calories").textContent).toContain("300 kcal");
    expect(writes()).toHaveLength(0);
  });

  it("'Log it' posts the label and the amount once, and reports what was logged", async () => {
    const logged = await scanned();
    fireEvent.change(screen.getByTestId("scan-quantity"), { target: { value: "2 servings" } });
    fireEvent.click(screen.getByTestId("scan-meal-snack"));
    respond = (_m, url) => (url === "/api/nutrition/log-scan" ? { recap: "Ridgeline Sea Salt Kettle Chips (2 servings) — 300 kcal", values: { calories: 300 } } : new Error("unexpected"));
    fireEvent.click(screen.getByTestId("scan-log"));
    await waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toContain("300 kcal");
    const posts = writes();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ method: "POST", url: "/api/nutrition/log-scan", body: { quantity: "2 servings", mealType: "snack" } });
    expect(posts[0].body.label.perServing.calories).toBe(150);
  });

  it("a failed save keeps the label on screen with the reason; nothing is reported as logged", async () => {
    const logged = await scanned();
    respond = () => new Error("400: That amount could not be read against the label's serving.");
    fireEvent.click(screen.getByTestId("scan-log"));
    expect((await screen.findByTestId("scan-log-error")).textContent).toContain("could not be read");
    expect(screen.getByTestId("scan-review")).toBeTruthy();
    expect(logged).toHaveLength(0);
  });
});

describe("failures and barcodes", () => {
  it("a picture that is not a label is an error with a retry, never an empty label", async () => {
    respond = () => ({ kind: "none", reason: "a cat on a sofa" });
    render(<NutritionScanDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("scan-input-library"), { target: { files: [picture()] } });
    expect((await screen.findByTestId("scan-error")).textContent).toContain("a cat on a sofa");
    expect(screen.queryByTestId("scan-review")).toBeNull();
    // Try again sends the same picture; this time it reads.
    respond = () => ({ kind: "label", label: LABEL });
    fireEvent.click(screen.getByTestId("scan-retry"));
    await screen.findByTestId("scan-review");
  });

  it("a failed request is an error, not 'no label'", async () => {
    respond = () => new Error("500: The picture could not be read. Nothing was logged.");
    render(<NutritionScanDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("scan-input-library"), { target: { files: [picture()] } });
    expect((await screen.findByTestId("scan-error")).textContent).toContain("could not be read");
  });

  it("a typed barcode is looked up and shown as a database product, per its own serving", async () => {
    respond = (_m, url) => url.startsWith("/api/nutrition/barcode/3017620422003")
      ? { kind: "barcode", barcode: "3017620422003", label: { productName: "Nutella", brand: "Ferrero", origin: "barcode", barcode: "3017620422003", sourceName: "Open Food Facts product 3017620422003", serving: { text: "100 g", grams: 100 }, perServing: { calories: 539, protein: 6.3, carbs: 57.5, fat: 30.9 } } }
      : new Error("unexpected");
    render(<NutritionScanDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("scan-barcode-input"), { target: { value: "3 017620 422003" } });
    fireEvent.click(screen.getByTestId("scan-barcode-lookup"));
    await screen.findByTestId("scan-review");
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/nutrition/barcode/3017620422003" });
    expect(screen.getByTestId("scan-source").textContent).toContain("Open Food Facts product 3017620422003");
    fireEvent.change(screen.getByTestId("scan-quantity"), { target: { value: "30 g" } });
    expect(screen.getByTestId("scan-row-calories").textContent).toContain("161.7 kcal");
  });

  it("an unknown barcode says so and offers the label photo instead", async () => {
    respond = () => new Error('404: {"error":"No product database has that barcode. Scan the nutrition label instead."}');
    render(<NutritionScanDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("scan-barcode-input"), { target: { value: "012345678905" } });
    fireEvent.click(screen.getByTestId("scan-barcode-lookup"));
    expect((await screen.findByTestId("scan-error")).textContent).toContain("No product database has that barcode");
  });
});
