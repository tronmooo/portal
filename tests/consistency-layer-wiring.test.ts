// Consistency layer — the shared logic is WIRED, not just present.
//
// Each guard reads the consuming file and asserts it routes through the
// domain module, so a page cannot quietly grow its own copy of a rule again.
// Plus the reply polish the chat route applies (req. tests 19, 23-filler).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { polishAssistantReply, stripFillerPreamble } from "../shared/domain";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

describe("wiring: one rule, one place", () => {
  it("browser titles come from the route metadata map, and /linked never titles itself 'Linked' for a tab", () => {
    const app = read("client/src/App.tsx");
    expect(app).toMatch(/pageTitleFor\(location\)/);
    expect(app).not.toMatch(/"\/linked": "Linked — Portol"/);
    const trackers = read("client/src/pages/trackers.tsx");
    expect(trackers).toMatch(/pageTitleFor\(/);
    expect(trackers).not.toMatch(/"Linked — Portol"/);
  });
  it("Fixed vs Variable on the Liabilities page reads getPaymentClassification, not the loan family", () => {
    const trackers = read("client/src/pages/trackers.tsx");
    expect(trackers).toMatch(/getPaymentClassification\(l\)\.classification === 'fixed'/);
    expect(trackers).not.toMatch(/liabilityFamily\(l\.type_key\) === 'amortizing'\)\.sort/);
  });
  it("search groups profiles by canonical entity type with the type's icon", () => {
    const search = read("client/src/components/CommandSearch.tsx");
    expect(search).toMatch(/searchGroupFor\("profile", p\)/);
    expect(search).toMatch(/iconNameFor\("profile", p\)/);
    expect(search).not.toMatch(/<CommandGroup heading="Profiles">/);
  });
  it("chat sends the UI scope and the engine resolves the requested scope and polishes the reply", () => {
    const chat = read("client/src/pages/chat.tsx");
    expect(chat).toMatch(/profileFilterIds: scopedProfileIds/);
    const engine = read("server/ai-engine.ts");
    expect(engine).toMatch(/resolveRequestedScope\(\{ message: userMessage/);
    expect(engine).toMatch(/finalReply = polishAssistantReply\(finalReply\)/);
    expect(engine).toMatch(/inferredType = resolveProfileTypeForCreate\(candidateName, inferredType\)/);
  });
  it("no create door falls back to a person, and the REST door resolves the type canonically", () => {
    const storage = read("server/supabase-storage.ts");
    expect(storage).not.toMatch(/data\.type = "person"/);
    expect(storage).toMatch(/resolveProfileTypeForCreate\(data\.name, data\.type\)/);
    const routes = read("server/routes.ts");
    expect(routes).toMatch(/req\.body\.type = resolveProfileTypeForCreate\(req\.body\.name, req\.body\.type\)/);
  });
  it("expenses, events and tasks run duplicate detection before insert", () => {
    const routes = read("server/routes.ts");
    expect(routes).toMatch(/findDuplicate\(dedupRecordFromExpense\(parsed\.data\)/);
    expect(routes).toMatch(/findDuplicate\(dedupRecordFromEvent\(parsed\.data\)/);
    expect(routes).toMatch(/findDuplicate\(dedupRecordFromTask\(parsed\.data\)/);
  });
  it("stats and the dashboard snapshot exclude test rows and future-dated spend", () => {
    const storage = read("server/supabase-storage.ts");
    expect(storage).toMatch(/forEnvironment\(expenseSource\.filter/);
    expect(storage).toMatch(/slice\(0, 10\) <= userTodayStats/);
    expect(storage).toMatch(/slice\(0, 10\) <= userTodayEnh/);
    const mem = read("server/storage.ts");
    expect(mem).toMatch(/forEnvironment\(allExpenses\.filter/);
  });
  it("a person's Info fields cannot receive a ticket's due date by the manual door", () => {
    const routes = read("server/routes.ts");
    expect(routes).toMatch(/if \(isObligationFieldKey\(key\)\) keptOffProfile\.push\(key\)/);
  });
  it("Documents and Artifacts are split by purpose; the calendar opens on Agenda on a phone; the hub does not repeat KPIs", () => {
    expect(read("client/src/pages/artifacts.tsx")).toMatch(/libraryPurposeOf\(a as any\)/);
    expect(read("client/src/components/CalendarView.tsx")).toMatch(/matchMedia\("\(max-width: 640px\)"\)\.matches \? "agenda" : "month"/);
    const exec = read("client/src/components/dashboard/ExecutiveBriefing.tsx");
    expect(exec).toMatch(/const hubEmbedded = useHubChrome\(\)/);
    expect(exec).toMatch(/\{!hubEmbedded && <OverviewCell/);
  });
  it("chat suggestions never say 'Mark X done'", () => {
    expect(read("shared/chat-suggestions.ts")).not.toMatch(/`Mark \$\{h\.name\} done`/);
  });
});

describe("23. Filler is removed from AI responses", () => {
  it("drops 'Let me look that up simultaneously.' and keeps the answer", () => {
    expect(stripFillerPreamble("Let me look that up simultaneously. You have 3 open tasks.")).toBe("You have 3 open tasks.");
    expect(stripFillerPreamble("Sure, I'll check your bills now. Netflix is due Friday.")).toBe("Netflix is due Friday.");
    expect(stripFillerPreamble("One moment while I pull that up… Your balance is $48,000.")).toBe("Your balance is $48,000.");
    expect(stripFillerPreamble("You have 3 open tasks.")).toBe("You have 3 open tasks.");
    expect(polishAssistantReply("Let me look that up. Your Auto Loan (id:9c8249b8) is $48,000.")).toBe("Your Auto Loan is $48,000.");
  });
});
