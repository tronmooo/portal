// Four chat tools confirmed a change they had not stored (chat-tools
// scenarios on the preview, 2026-11-27, each 7 runs of 7; rule I16 / L5):
//  - update_liability_payment wrote the amount alone: the split, the
//    balance-after and the debt's balance still described the old amount;
//  - mark_loan_payment flipped the schedule's flag with no payment behind it;
//  - complete_event wrote a `status` the events table does not have;
//  - split_ownership dropped the account holder's own share ("me").
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const src = fs.readFileSync(`${process.cwd()}/server/ai-engine.ts`, "utf8");
const tool = (name: string, endMarker: string) => {
  const at = src.lastIndexOf(`case "${name}":`);
  expect(at, name).toBeGreaterThan(0);
  return src.slice(at, src.indexOf(endMarker, at));
};

describe("chat tools store what they confirm", () => {
  it("a payment's amount or date is edited through the pay pipeline, never as a bare row update", () => {
    const body = tool("update_liability_payment", 'case "mark_loan_payment": {');
    expect(body).toContain("unpayBillOccurrence(storage, liability.id, { paymentId: target.id");
    expect(body).toContain("payBillOccurrence(storage, liability.id,");
    expect(body).toContain("repriceBillPayment(storage, target.id");
    expect(body).not.toMatch(/const updated = await storage\.updateLiabilityPayment\(target\.id, patch\);/);
    // a failed re-record puts the original payment back
    expect(body).toContain("the original payment was kept");
  });

  it("marking a scheduled payment paid records the payment first", () => {
    const body = tool("mark_loan_payment", 'case "update_habit": {');
    const pay = body.indexOf("payBillOccurrence(storage, target.loan_id");
    const flag = body.indexOf("storage.markLoanPayment(target.id)");
    expect(pay).toBeGreaterThan(0);
    expect(flag).toBeGreaterThan(pay);
    expect(body).toContain("nothing was marked paid");
  });

  it("completing an event marks the occurrence on the stored row", () => {
    const body = tool("complete_event", 'case "delete_tracker_entry": {');
    expect(body).not.toContain('{ status: "completed" }');
    expect(body).toContain('markRecurringOccurrence(existing?.tags ?? [], doneDay, "done")');
    expect(body).toContain("writeFromStoredRow");
  });

  it("a split keeps the account holder's share, and a share that was not stored is reported", () => {
    const body = tool("split_ownership", 'case "get_relationships": {');
    expect(body).toContain('saidSelf ? profiles.find((p: any) => p.type === "self")');
    expect(body).toContain("if (created.length < splits.length)");
    expect(body).toContain("do not say the split is done");
  });
});

// "Switch the dashboard to show only X": chat asked first, the person said
// "Yes, go ahead", and the scope tool judged that last message alone — it
// skipped, and the reply still said the dashboard was now filtered (7 of 7).
describe("the dashboard scope tool", () => {
  const body = src.slice(src.lastIndexOf('case "set_dashboard_scope":'), src.lastIndexOf('case "create_goal": {'));
  it("counts a yes to the assistant's own question about switching", () => {
    expect(body).toContain("__lastAssistantMessage");
    expect(body).toContain("confirmsQuestion");
    expect(src).toContain('toolUse.name === "set_dashboard_scope" ? { __lastAssistantMessage: lastAssistantReply }');
  });
  it("a refused switch is an error the reply cannot present as done", () => {
    expect(body).toContain("The dashboard view was NOT changed");
    expect(body).not.toContain("message: \"Not changing the active profile");
  });
});

// The cause behind the scope tool: its pattern held two literal backspace
// characters (0x08) where `\b` word boundaries were meant, so it never matched.
describe("no source file hides a control character in a pattern", () => {
  it("server, shared and client sources contain no literal backspace", () => {
    const fsx = require("node:fs"); const pathx = require("node:path");
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of fsx.readdirSync(dir, { withFileTypes: true })) {
        const f = pathx.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules") walk(f); continue; }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        if (fsx.readFileSync(f, "utf8").includes(String.fromCharCode(8))) bad.push(pathx.relative(process.cwd(), f));
      }
    };
    for (const d of ["server", "shared", "client/src"]) walk(pathx.join(process.cwd(), d));
    expect(bad).toEqual([]);
  });
});
