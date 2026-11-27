// A claim that something was saved is a claim in any language (chat-variations
// check, production, 2026-11-27: "gasté 15 dólares en tacos" was answered
// "Gasto de $15 en tacos guardado. 🌮" with no expense stored — the duplicate
// question had blocked the save, and the claim detector knew only English).
import { describe, it, expect } from "vitest";
import { checkClaims, extractSuccessClaims, shouldRetryUnbackedWriteClaim } from "../shared/ai-claim-check";

const claims = (s: string) => extractSuccessClaims(s).length > 0;

describe("a write claimed in another language is still a claim", () => {
  it.each([
    "Gasto de $15 en tacos guardado. 🌮",
    "Listo: tarea añadida para el viernes.",
    "Evento registrado para mañana a las 10.",
    "Despesa de R$20 adicionada.",
    "Dépense de 15 € enregistrée.",
    "La tâche a été ajoutée.",
    "Ausgabe von 15 € gespeichert.",
    "Aufgabe hinzugefügt.",
    "Spesa di 15 € salvata.",
    "Promemoria aggiunto.",
  ])("%s", (reply) => {
    expect(claims(reply)).toBe(true);
    // nothing was written this turn: the retry fires, and the final gate calls it unsupported
    expect(shouldRetryUnbackedWriteClaim({ reply, toolCallsSoFar: 0, readOnlyTurn: false })).toBe(true);
    expect(checkClaims({ reply, operations: [] } as any).unsupportedSuccess).toBe(true);
  });

  it.each([
    "No se ha guardado el gasto.",
    "No pude guardarlo, ¿lo intento de nuevo?",
    "Je vais enregistrer la dépense.",
    "La dépense n'a pas été enregistrée.",
    "Die Ausgabe wurde nicht gespeichert.",
    "Non è stato salvato.",
    "¿Quieres que lo guarde?",
    "Voy a guardar el gasto.",
  ])("not a claim: %s", (reply) => {
    expect(claims(reply)).toBe(false);
  });

  it("a word that merely contains one is not a claim, and English is unchanged", () => {
    expect(claims("Tu salvoconducto vence en mayo.")).toBe(false);   // "salvo" inside a word
    expect(claims("Added expense: Tacos — $15")).toBe(true);
    expect(claims("Want me to add it?")).toBe(false);
  });

  it("when the write DID happen, the claim is supported", () => {
    const r = checkClaims({ reply: "Gasto de $15 en tacos guardado.", operations: [{ tool: "create_expense", operation: "create", status: "ok", entityType: "expense", entityName: "Tacos" }] } as any);
    expect(r.unsupportedSuccess).toBe(false);
  });
});
