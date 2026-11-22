// ── Task groups ──────────────────────────────────────────────────────────────
// Pure, no I/O. ONE answer to "what is this task about?": the user themself
// (or another person), something they own, or something they owe. The Tasks
// page groups by it and the New Task picker offers the same three kinds, so a
// task filed under the Honda in the dialog is listed under the Honda.
//
// The link is the task's own `linkedProfiles` (a "Bill due: X" reminder is
// linked to bill X; a chat task "for the Tesla" to the car). Which side a
// profile is on is the Assets / Liabilities tab rule (shared/asset-value), so
// a credit card is a liability here because it is one there.

import { isAssetTabProfile, isLiabilityTabProfile } from "./asset-value";
import { liabilityTypeKeyOf } from "./liability-types";
import { accountKindMeta, accountKindOf } from "./finance-accounts";

export type TaskGroupKind = "mine" | "asset" | "liability";

export interface TaskGroupProfile {
  id: string;
  type?: string | null;
  name?: string | null;
  fields?: Record<string, any> | null;
  type_key?: string | null;
}

export interface TaskGroup {
  kind: TaskGroupKind;
  /** The asset or liability the task is tied to; null for a personal task. */
  profileId: string | null;
}

/**
 * A task tied to a bill or debt is about that debt, even when it is also
 * linked to a person or to the thing the debt pays for ("Insurance payment"
 * linked to the policy and the car is the policy's task). Otherwise the first
 * asset it is linked to; otherwise it is personal. A link to a profile that
 * no longer exists is ignored: the task stays listed, under My Tasks.
 */
export function taskGroupOf<P extends TaskGroupProfile>(
  task: { linkedProfiles?: readonly string[] | null },
  profilesById: ReadonlyMap<string, P>,
): TaskGroup {
  const linked = (task.linkedProfiles || []).map(id => profilesById.get(id)).filter((p): p is P => !!p);
  const debt = linked.find(p => isLiabilityTabProfile(p));
  if (debt) return { kind: "liability", profileId: debt.id };
  const asset = linked.find(p => isAssetTabProfile(p));
  if (asset) return { kind: "asset", profileId: asset.id };
  return { kind: "mine", profileId: null };
}

const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

/** The short kind printed beside an item's name: "Vehicle", "Subscription", "Auto Loan". */
export function taskGroupItemKind(p: TaskGroupProfile | null | undefined): string {
  if (!p) return "";
  const type = String(p.type || "");
  if (type === "account") return accountKindMeta(accountKindOf(p as any)).label;
  if (isLiabilityTabProfile(p)) {
    const key = liabilityTypeKeyOf(p as any);
    if (key) return titleCase(key);
    return type === "subscription" ? "Subscription" : type === "loan" ? "Loan" : "Liability";
  }
  return titleCase(type);
}
