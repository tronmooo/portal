// In-memory backend for the browser acceptance rig.
//
// The runtime backend is SupabaseStorage (server/storage.ts) and there is no
// local alternative — MemStorage is marked dev-only and THROWS on liability
// links, liability payments and asset-party links. This wraps MemStorage and
// fills exactly those gaps, plus the two cache-coherence hooks the acceptance
// test is actually about:
//
//   · bumpDataVersion / getDataVersion — the per-user counter that stamps every
//     response-cache key. The staleness bug lived here.
//   · get/setResponseCache — the SHARED (cross-instance) response cache. One
//     instance of this object is shared by every server instance the rig boots,
//     which is what makes the cross-instance race reproducible locally.
//
// Everything above this layer — routes, caching, the AI tool loop, the envelope,
// the change manifest — is the real production code.
import { MemStorage } from "../../server/storage";

export interface BackendStats {
  /** How many times a version bump was requested. */
  bumps: number;
  /** Shared response-cache reads that HIT, by key. Proves cross-instance serving. */
  sharedHits: string[];
  /** Every write, in order, for ordering assertions. */
  writeLog: Array<{ op: string; id?: string; at: number }>;
}

export function createBackend() {
  const base = new MemStorage() as any;
  const stats: BackendStats = { bumps: 0, sharedHits: [], writeLog: [] };

  let dataVersion = 0;
  const shared = new Map<string, { data: any; expiresAt: number }>();

  // ── Liability + ownership link tables MemStorage never implemented ────────
  const liabilityAssetLinks: any[] = [];
  const liabilityProfileLinks: any[] = [];
  const assetPartyLinks: any[] = [];
  const liabilityPayments: any[] = [];
  let seq = 0;
  const newId = (p: string) => `${p}-${++seq}`;
  const now = () => new Date().toISOString();

  const extensions: Record<string, any> = {
    getDataVersion: async () => dataVersion,
    bumpDataVersion: async () => {
      stats.bumps++;
      return ++dataVersion;
    },

    getResponseCache: async (key: string) => {
      const hit = shared.get(key);
      if (!hit) return null;
      if (Date.now() >= hit.expiresAt) { shared.delete(key); return null; }
      stats.sharedHits.push(key);
      return hit.data;
    },
    setResponseCache: async (key: string, data: any, ttlMs: number) => {
      shared.set(key, { data, expiresAt: Date.now() + ttlMs });
    },

    createLiabilityAssetLink: async (data: any) => {
      const row = { id: newId("lal"), createdAt: now(), ...data };
      liabilityAssetLinks.push(row);
      stats.writeLog.push({ op: "createLiabilityAssetLink", id: row.id, at: Date.now() });
      return row;
    },
    getLiabilityAssetLinks: async () => liabilityAssetLinks,
    deleteLiabilityAssetLink: async (id: string) => {
      const i = liabilityAssetLinks.findIndex((r) => r.id === id);
      if (i >= 0) liabilityAssetLinks.splice(i, 1);
      return i >= 0;
    },

    createLiabilityProfileLink: async (data: any) => {
      const row = { id: newId("lpl"), createdAt: now(), ...data };
      liabilityProfileLinks.push(row);
      stats.writeLog.push({ op: "createLiabilityProfileLink", id: row.id, at: Date.now() });
      return row;
    },
    getLiabilityProfileLinks: async () => liabilityProfileLinks,
    deleteLiabilityProfileLink: async (id: string) => {
      const i = liabilityProfileLinks.findIndex((r) => r.id === id);
      if (i >= 0) liabilityProfileLinks.splice(i, 1);
      return i >= 0;
    },
    ensureLiabilityOwnerLink: async () => { /* links are explicit here */ },

    createAssetPartyLink: async (data: any) => {
      const row = { id: newId("apl"), createdAt: now(), ...data };
      assetPartyLinks.push(row);
      stats.writeLog.push({ op: "createAssetPartyLink", id: row.id, at: Date.now() });
      return row;
    },
    getAssetPartyLinks: async () => assetPartyLinks,
    updateAssetPartyLink: async (id: string, patch: any) => {
      const row = assetPartyLinks.find((r) => r.id === id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    },
    deleteAssetPartyLink: async (id: string) => {
      const i = assetPartyLinks.findIndex((r) => r.id === id);
      if (i >= 0) assetPartyLinks.splice(i, 1);
      return i >= 0;
    },

    // MemStorage.createTask spreads the insert and THEN hardcodes
    // `linkedProfiles: []` (server/storage.ts), so a task the engine resolved
    // to a person arrives unlinked and every profile-scoped view drops it.
    // Profile isolation cannot be tested at all through that, and the
    // production storage persists the field, so honour it here.
    createTask: async (data: any) => {
      const row = await base.createTask(data);
      const linked = Array.isArray(data?.linkedProfiles) ? data.linkedProfiles : [];
      if (linked.length > 0) {
        const patched = { ...row, linkedProfiles: linked };
        await base.updateTask(row.id, { linkedProfiles: linked } as any);
        return patched;
      }
      return row;
    },

    // Accounts are a first-class finance surface (/dashboard/finance gates its
    // whole panel on this read) but MemStorage never implemented them. Accounts
    // ARE profiles of type "account" — the same relationship the production
    // storage encodes — so derive them rather than keeping a parallel table.
    getAccounts: async () => {
      const profiles = await base.getProfiles();
      return profiles
        .filter((p: any) => p.type === "account")
        .map((p: any) => ({
          id: p.id,
          name: p.name,
          kind: p.data?.kind || "checking",
          balance: Number(p.data?.balance ?? 0),
          currency: "USD",
          linkedProfiles: p.linkedProfiles || [],
        }));
    },

    createLiabilityPayment: async (data: any) => {
      const row = { id: newId("lpay"), createdAt: now(), ...data };
      liabilityPayments.push(row);
      stats.writeLog.push({ op: "createLiabilityPayment", id: row.id, at: Date.now() });
      return row;
    },
    getLiabilityPayments: async () => liabilityPayments,
    deleteLiabilityPayment: async (id: string) => {
      const i = liabilityPayments.findIndex((r) => r.id === id);
      if (i >= 0) liabilityPayments.splice(i, 1);
      return i >= 0;
    },
  };

  // Proxy so the extensions win and everything else falls through to MemStorage.
  //
  // It deliberately does NOT fabricate a stub for anything MemStorage lacks.
  // An earlier version returned `[]` for any unimplemented get*/list* method,
  // which silently shadowed the OPTIONAL IStorage members — `getProfilesLite()`
  // is declared optional precisely so callers can fall back with
  // `?? storage.getProfiles()`, and a stub returning [] defeats that fallback.
  // The visible effect was routes.ts's filterByProfileScope resolving an EMPTY
  // profile list, which drops every orphan row from every scoped endpoint — a
  // rig-manufactured "staleness" that looks exactly like the real bug. A rig
  // that invents failures is worse than no rig, so unimplemented means absent.
  const storage = new Proxy(base, {
    get(target, prop: string) {
      if (prop in extensions) return extensions[prop];
      const value = target[prop];
      if (typeof value === "function") return value.bind(target);
      return value;
    },
    has(target, prop) {
      return prop in extensions || prop in target;
    },
  });

  return { storage, stats, raw: base, sharedCache: shared };
}

/** Seed the profiles the acceptance matrix needs: a self profile plus 3 people. */
export async function seedProfiles(storage: any) {
  const self = await storage.createProfile({
    name: "Me", type: "self", data: {}, linkedProfiles: [],
  });
  const bob = await storage.createProfile({
    name: "Bob", type: "person", data: {}, linkedProfiles: [],
  });
  const jim = await storage.createProfile({
    name: "Jim", type: "person", data: {}, linkedProfiles: [],
  });
  const joe = await storage.createProfile({
    name: "Joe", type: "person", data: {}, linkedProfiles: [],
  });
  return { self, bob, jim, joe };
}
