// shared/domain/payment-classification.ts — fixed or variable, decided once.
//
// The billing model lives in shared/liability-billing (resolveBillingModel),
// but three surfaces re-derived "is this variable?" with three different
// sets (perOccurrenceAmount, PER_OCCURRENCE_MONEY, `variableModel`), and the
// Liabilities page grouped "Fixed" by amortizing FAMILY — so a $15.49 Netflix
// bill (fixed billing, recurring family) sat under "Variable" there and
// "Fixed" on its own card.
//
// `getPaymentClassification` is the one answer the liability page, finance
// page, dashboard, chat and notifications all read.
//
// Pure. Pinned by tests/consistency-layer-payments.test.ts.

import { resolveBillingModel, billingModelMeta, type BillingModel } from "../liability-billing";

export type PaymentClassification = "fixed" | "variable";

export interface PaymentClassificationResult {
  classification: PaymentClassification;
  label: "Fixed" | "Variable";
  billingModel: BillingModel;
  /** True when each period carries its own amount. */
  perOccurrenceAmount: boolean;
  reason: string;
}

export interface ClassifiableRecord {
  fields?: Record<string, any> | null;
  type_key?: string | null;
  typeKey?: string | null;
  /** An Obligation row carries the model at the top level. */
  billingModel?: string | null;
  amountIsEstimate?: boolean | null;
  /** An expense/transaction row: `isRecurring` alone says nothing about amount stability. */
  isRecurring?: boolean | null;
}

/**
 * One classification for a bill, subscription, loan or obligation row.
 *
 *   fixed / installment / one_time → Fixed   (the amount is known)
 *   variable / usage_based         → Variable (each period posts its own)
 */
export function getPaymentClassification(record: ClassifiableRecord | null | undefined): PaymentClassificationResult {
  const fields = record?.fields ?? {};
  const merged = record?.billingModel && !fields.billingModel
    ? { ...record, fields: { ...fields, billingModel: record.billingModel } }
    : record;
  const model = resolveBillingModel(merged as any);
  const meta = billingModelMeta(model);
  const variable = model === "variable" || model === "usage_based";
  return {
    classification: variable ? "variable" : "fixed",
    label: variable ? "Variable" : "Fixed",
    billingModel: model,
    perOccurrenceAmount: meta.perOccurrenceAmount,
    reason: variable ? `${meta.label} billing posts a different amount each period` : `${meta.label} billing has a known amount`,
  };
}

export function isVariablePayment(record: ClassifiableRecord | null | undefined): boolean {
  return getPaymentClassification(record).classification === "variable";
}

export function isFixedPayment(record: ClassifiableRecord | null | undefined): boolean {
  return !isVariablePayment(record);
}
