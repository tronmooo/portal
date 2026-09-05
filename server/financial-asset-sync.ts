/**
 * Connected account → Asset Profile.
 *
 * Every account a connected source (today: Stripe Financial Connections)
 * reports is a real account the user holds, so it gets — or is matched to —
 * a canonical account PROFILE, the same row a hand-entered account is. That is
 * what puts it in the Assets tab, net worth, ownership views, search and the
 * chat's entity resolution, through machinery those surfaces already have.
 *
 * The profile does not care that the data came from Stripe. The sync produces
 * an `AccountObservation` (shared/financial-reconcile), the matcher decides
 * whether it describes an existing profile, and the observation lands as a
 * balance snapshot with `source: "api"` — the same shape a statement, an
 * import or a chat sentence produces.
 *
 * Rules:
 *   · high-confidence match → link silently (`matched_profile_id`), snapshot.
 *   · medium → CREATE a profile anyway (the account is real and must exist)
 *     and record the candidate on it as `possibleDuplicateOf`, so the profile
 *     page can ask "same as X?" and merge through the app's merge machinery.
 *   · a profile the user DELETED is not recreated: `profile_unlinked_at` on
 *     the connected row says so.
 *   · disconnecting keeps the profile and every observation; only the
 *     connection status flips.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getFinanceDb, logFinanceError } from "./stripe-config";
import { createScopedStorage } from "./storage";
import { getAccounts, mapAccount } from "./finance-data";
import type { FinancialAccountRecord } from "@shared/finance-connections";
import { minorPerMajor } from "@shared/money";
import { isAccountProfile } from "@shared/finance-accounts";
import { accountConnection, type AccountConnection } from "@shared/financial-assets";
import {
  findAccountMatch, observationFromConnectedAccount, resolveObservationKind, suggestedAccountName,
} from "@shared/financial-reconcile";

export interface ReconcileResult {
  linked: number;
  created: number;
  snapshots: number;
  skipped: number;
  errors: number;
}

const PROVIDER: AccountConnection["provider"] = "stripe_financial_connections";

function connectionStatusFor(a: FinancialAccountRecord): AccountConnection["status"] {
  if (a.status === "disconnected") return "disconnected";
  if (a.status === "action_required" || a.status === "inactive") return "action_required";
  return "active";
}

/**
 * Make sure every connected account has its Asset Profile and that the
 * profile's balance history carries this sync's observation.
 *
 * Safe to run after every sync: idempotent per (account, day, source).
 */
export async function reconcileConnectedAccountProfiles(
  userId: string,
  opts: { db?: SupabaseClient; runId?: string | null; accountIds?: string[] } = {},
): Promise<ReconcileResult> {
  const result: ReconcileResult = { linked: 0, created: 0, snapshots: 0, skipped: 0, errors: 0 };
  const db = opts.db ?? getFinanceDb();
  const storage = createScopedStorage(userId);

  const { data: rows, error } = await db
    .from("financial_accounts")
    .select("*")
    .eq("user_id", userId);
  if (error) throw error;
  const accounts = (rows ?? [])
    .map((r: any) => ({ record: mapAccount(r), unlinkedAt: r.profile_unlinked_at ?? null }))
    .filter((a) => !opts.accountIds || opts.accountIds.includes(a.record.id));

  let profiles: any[] = await storage.getProfiles();
  // Profiles already claimed by another connected row are off the table.
  const claimed = new Set<string>(
    (rows ?? []).map((r: any) => r.matched_profile_id).filter((id: any): id is string => typeof id === "string" && id.length > 0),
  );

  for (const { record, unlinkedAt } of accounts) {
    try {
      let profile: any = record.matchedProfileId
        ? profiles.find((p) => p.id === record.matchedProfileId) ?? await storage.getProfile(record.matchedProfileId)
        : null;

      if (!profile) {
        if (unlinkedAt && !record.matchedProfileId) { result.skipped++; continue; }
        if (record.status === "disconnected" && !record.matchedProfileId) { result.skipped++; continue; }

        const obs = observationFromConnectedAccount(record, minorPerMajor(record.currency));
        const match = findAccountMatch(obs, profiles, claimed);
        if (match.decision === "link" && match.best) {
          profile = profiles.find((p) => p.id === match.best!.profileId);
          result.linked++;
        } else {
          const resolved = resolveObservationKind(obs);
          const created = await (storage as any).createAccount({
            name: suggestedAccountName(obs),
            accountKind: resolved.kind,
            institution: record.institutionName ?? undefined,
            balance: obs.balance ?? 0,
            availableBalance: obs.availableBalance ?? undefined,
            accountNumberLast4: record.lastFour ?? undefined,
            balanceAsOf: record.balanceAsOf ? String(record.balanceAsOf).slice(0, 10) : undefined,
            currency: record.currency,
          });
          profile = created;
          result.created++;
          if (match.decision === "confirm" && match.best) {
            // Same account as an existing profile? Ask on the profile page
            // rather than guessing; the merge keeps both histories.
            await storage.mutateProfileFields?.(created.id, () => ({
              fields: { possibleDuplicateOf: { profileId: match.best!.profileId, name: match.best!.profileName, score: match.best!.score, reasons: match.best!.reasons } },
            } as any));
          }
          profiles = [...profiles, created];
        }
        if (!profile) { result.errors++; continue; }
        claimed.add(profile.id);
        await db.from("financial_accounts")
          .update({ matched_profile_id: profile.id, profile_unlinked_at: null })
          .eq("id", record.id).eq("user_id", userId);
      }

      // The connection metadata the profile page renders ("Connected via
      // Chase · synced 2 min ago").
      const prev = accountConnection(profile);
      const status = connectionStatusFor(record);
      await storage.linkAccountConnection(profile.id, {
        provider: PROVIDER,
        financialAccountId: record.id,
        connectionId: record.financialConnectionId ?? undefined,
        status,
        linkedAt: prev?.linkedAt,
        ...(status === "active" ? { lastSyncAt: new Date().toISOString() } : {}),
        ...(status === "disconnected" ? { disconnectedAt: prev?.disconnectedAt ?? new Date().toISOString() } : {}),
      });

      // The observation. The API owns the live balance while the connection
      // is active; a disconnected account's last balance stays as it was.
      if (record.currentBalance != null && status === "active") {
        const balance = Math.abs(record.currentBalance) / minorPerMajor(record.currency);
        await storage.recordAccountSnapshot(profile.id, {
          balance,
          at: record.balanceAsOf ?? undefined,
          date: record.balanceAsOf ? String(record.balanceAsOf).slice(0, 10) : undefined,
          source: "api",
          sourceRef: opts.runId ?? record.id,
          note: record.institutionName ? `Synced from ${record.institutionName}` : "Synced",
        });
        result.snapshots++;
      }
    } catch (e) {
      result.errors++;
      logFinanceError("reconcileConnectedAccount", e, { userId: userId.slice(0, 8), accountId: record.id });
    }
  }
  return result;
}

/** After a disconnect: the profiles stay, with their connection marked as ended. */
export async function markConnectionProfilesDisconnected(userId: string, connectionId: string): Promise<number> {
  const db = getFinanceDb();
  const accounts = (await getAccounts(userId, { includeHidden: true, db })).filter((a) => a.financialConnectionId === connectionId && a.matchedProfileId);
  if (accounts.length === 0) return 0;
  const storage = createScopedStorage(userId);
  let n = 0;
  for (const a of accounts) {
    try {
      const profile = await storage.getProfile(a.matchedProfileId!);
      if (!profile || !isAccountProfile(profile)) continue;
      const prev = accountConnection(profile);
      await storage.linkAccountConnection(profile.id, {
        provider: PROVIDER, financialAccountId: a.id, connectionId,
        status: "disconnected", linkedAt: prev?.linkedAt, lastSyncAt: prev?.lastSyncAt,
        disconnectedAt: new Date().toISOString(),
      });
      n++;
    } catch (e) {
      logFinanceError("markConnectionProfilesDisconnected", e, { userId: userId.slice(0, 8), accountId: a.id });
    }
  }
  return n;
}

/**
 * The user deleted (or unlinked) a profile a connected account was matched
 * to. Remember it on the connected row so the next sync does not quietly
 * bring the profile back. The FK clears matched_profile_id on delete; this
 * is the part the FK cannot say.
 */
export async function markConnectedAccountProfileUnlinked(profile: any): Promise<void> {
  const conn = accountConnection(profile);
  if (!conn?.financialAccountId) return;
  let db: SupabaseClient;
  try { db = getFinanceDb(); } catch { return; }
  await db.from("financial_accounts")
    .update({ profile_unlinked_at: new Date().toISOString(), matched_profile_id: null })
    .eq("id", conn.financialAccountId);
}
