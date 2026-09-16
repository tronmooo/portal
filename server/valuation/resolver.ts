// ─── Asset Data Resolver ────────────────────────────────────────────────────
// Gathers everything the app knows about one asset into an AssetDataBundle:
// the profile row, its linked documents (with extracted data), expenses,
// timeline, child profiles, the stored valuation history, the cached AI
// summary and the cached semantic understanding. Reuses getProfileDetail —
// the same aggregation the profile page already loads — so the freshness
// check on profile open can be fed the detail it already has and costs no
// extra table reads.

import type { IStorage } from "../storage";
import type { ProfileDetail } from "@shared/schema";
import type { AssetDataBundle, AssetUnderstanding } from "@shared/valuation/types";

export interface ResolveOptions {
  /** A detail the caller already fetched (the bootstrap route has one). */
  detail?: ProfileDetail | null;
  /** Load the stored valuation history (needed for trend evidence, not for a freshness check). */
  includeHistory?: boolean;
  /** Load the cached AI profile summary as dossier context. */
  includeSummary?: boolean;
  understanding?: AssetUnderstanding | null;
}

export function bundleFromDetail(detail: ProfileDetail, extras: Pick<AssetDataBundle, "history" | "aiSummary" | "understanding"> = {}): AssetDataBundle {
  const d = detail as any;
  return {
    profile: {
      id: detail.id,
      name: detail.name,
      type: detail.type,
      type_key: d.type_key ?? d.typeKey ?? null,
      tags: detail.tags || [],
      fields: detail.fields || {},
      notes: detail.notes ?? null,
      createdAt: detail.createdAt ?? null,
      updatedAt: detail.updatedAt ?? null,
    },
    documents: (detail.relatedDocuments || []).map(doc => ({
      id: doc.id, name: doc.name, type: doc.type,
      extractedData: (doc as any).extractedData ?? (doc as any).extracted_data ?? null,
      createdAt: doc.createdAt,
    })),
    expenses: (detail.relatedExpenses || []).map(e => ({
      id: e.id, description: e.description, amount: e.amount, category: e.category, date: e.date,
    })),
    timeline: (detail.timeline || []).slice(0, 10).map(t => ({ type: t.type, title: t.title, timestamp: t.timestamp })),
    children: (detail.childProfiles || []).map(c => ({ id: c.id, name: c.name, type: c.type, fields: c.fields })),
    history: extras.history || [],
    aiSummary: extras.aiSummary ?? null,
    understanding: extras.understanding ?? null,
  };
}

export async function resolveAssetBundle(
  storage: IStorage,
  profileId: string,
  opts: ResolveOptions = {},
): Promise<AssetDataBundle | null> {
  const detail = opts.detail ?? (await storage.getProfileDetail(profileId));
  if (!detail) return null;
  const [history, aiSummary] = await Promise.all([
    opts.includeHistory ? storage.getAssetValuationHistory(profileId).catch(() => []) : Promise.resolve([]),
    opts.includeSummary
      ? storage.getPreference(`profile_ai_${profileId}`).then(raw => {
          try { return raw ? (JSON.parse(raw)?.summary as string) || null : null; } catch { return null; }
        }).catch(() => null)
      : Promise.resolve(null),
  ]);
  return bundleFromDetail(detail, { history, aiSummary, understanding: opts.understanding ?? null });
}
