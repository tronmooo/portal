import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerRoutes } from "../server/routes";
import { requestStorageContext } from "../server/storage";
import { SupabaseStorage } from "../server/supabase-storage";
import { makeFakeStorage, type FakeDb, type Harness } from "./helpers/route-harness";

function bareStorage(over: Record<string, any>): any {
  const storage: any = Object.create(SupabaseStorage.prototype);
  storage.userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  storage._timezone = "UTC";
  storage.memoEnabled = false;
  storage.memoCache = new Map();
  storage.logActivity = () => {};
  storage.clearRequestMemo = () => {};
  Object.assign(storage, over);
  return storage;
}

function ownerRow(kind: "asset" | "liability", id: string, partyProfileId: string, pct: number, role = "owner") {
  return {
    id,
    ...(kind === "asset" ? { assetProfileId: "subject-1" } : { liabilityProfileId: "subject-1" }),
    partyProfileId,
    ownershipPercentage: pct,
    role,
    notes: null,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

describe("D293 owner-set replacement compensation", () => {
  for (const kind of ["asset", "liability"] as const) {
    for (const failurePhase of ["delete", "update", "create"] as const) {
    it(`${kind}: restores the previous owner set after a ${failurePhase}-phase failure`, async () => {
      let rows: any[] = [
        ownerRow(kind, "owner-a", "party-a", 50),
        ownerRow(kind, "owner-b", "party-b", 50),
        ownerRow(kind, "observer", "party-observer", 0, kind === "asset" ? "beneficiary" : "guarantor"),
      ];
      let injectFailure = true;
      const load = async () => structuredClone(rows);
      const remove = async (id: string) => {
        const removed = rows.find((row) => row.id === id);
        rows = rows.filter((row) => row.id !== id);
        // Match the real delete hook: survivors can be redistributed.
        if (removed?.role === "owner") {
          const owners = rows.filter((row) => row.role === "owner");
          if (owners.length === 1) owners[0].ownershipPercentage = 100;
        }
        if (failurePhase === "delete" && injectFailure) {
          injectFailure = false;
          throw new Error("injected delete failure");
        }
        return true;
      };
      const update = async (id: string, patch: any) => {
        const row = rows.find((candidate) => candidate.id === id);
        if (!row) return undefined;
        Object.assign(row, patch);
        if (failurePhase === "update" && injectFailure) {
          injectFailure = false;
          throw new Error("injected update failure");
        }
        return structuredClone(row);
      };
      const create = async (data: any) => {
        if (failurePhase === "create" && data.partyProfileId === "party-c" && injectFailure) {
          injectFailure = false;
          throw new Error("injected create failure");
        }
        const row = ownerRow(kind, `restored-${data.partyProfileId}`, data.partyProfileId, data.ownershipPercentage, data.role);
        rows.push(row);
        return structuredClone(row);
      };
      const storage = bareStorage(kind === "asset" ? {
        getAssetPartyLinks: load,
        deleteAssetPartyLink: remove,
        updateAssetPartyLink: update,
        createAssetPartyLink: create,
      } : {
        getLiabilityProfileLinks: load,
        deleteLiabilityProfileLink: remove,
        updateLiabilityProfileLink: update,
        createLiabilityProfileLink: create,
      });

      const replace = kind === "asset"
        ? storage.setAssetOwners.bind(storage)
        : storage.setLiabilityOwners.bind(storage);
      await expect(replace("subject-1", [
        { partyProfileId: "party-a", ownershipPercentage: 30 },
        { partyProfileId: "party-c", ownershipPercentage: 70 },
      ])).rejects.toThrow(`injected ${failurePhase} failure`);

      expect(rows.filter((row) => row.role === "owner")
        .map((row) => [row.partyProfileId, row.ownershipPercentage]).sort())
        .toEqual([["party-a", 50], ["party-b", 50]]);
      expect(rows.find((row) => row.id === "observer")?.partyProfileId).toBe("party-observer");
    });
    }
  }
});

describe("D294 obligation owner reassignment compensation", () => {
  it("restores both the previous parent and previous owner set when owner synchronization fails", async () => {
    const profile: any = {
      id: "bill-1", type: "liability", type_key: "utility", name: "Water",
      parentProfileId: "self-1", fields: { monthlyAmount: 20 },
    };
    let owners = [{ partyProfileId: "self-1", ownershipPercentage: 100 }];
    let ownerCalls = 0;
    const storage = bareStorage({
      getProfile: async () => profile,
      getLiabilityProfileLinks: async () => owners.map((row, index) => ({
        id: `link-${index}`, liabilityProfileId: profile.id, role: "owner", ...row,
      })),
      updateProfile: async (_id: string, patch: any) => {
        Object.assign(profile, patch);
        return profile;
      },
      setLiabilityOwners: async (_id: string, desired: any[]) => {
        ownerCalls++;
        owners = structuredClone(desired);
        if (ownerCalls === 1) throw new Error("injected owner synchronization failure");
        return [];
      },
      getObligation: async () => ({ id: profile.id, linkedProfiles: owners.map((row) => row.partyProfileId) }),
    });

    await expect(storage.updateObligation("bill-1", {
      linkedProfiles: ["person-2"],
    })).rejects.toThrow("injected owner synchronization failure");
    expect(profile.parentProfileId).toBe("self-1");
    expect(owners).toEqual([{ partyProfileId: "self-1", ownershipPercentage: 100 }]);
    expect(ownerCalls).toBe(2);
  });
});

interface Booted extends Harness {
  storage: any;
}

let current: Booted | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function bootPaymentFailure(): Promise<Booted> {
  const db: FakeDb = {
    profiles: [{
      id: "loan-1", type: "loan", type_key: "personal_loan", name: "Loan",
      fields: { currentBalance: 900, remainingBalance: 900, loanBalance: 900, interestRate: 0 },
      tags: [], documents: [],
    }],
    liabilityPayments: [{
      id: "payment-old", liabilityProfileId: "loan-1", amount: 100,
      principalPortion: 100, interestPortion: 0, fees: 0,
      remainingBalanceAfter: 900, paymentType: "standard",
      paymentDate: "2026-09-03", sourceAccount: null, notes: "original",
      documentId: "document-1", createdAt: "2026-09-03T12:00:00.000Z",
      updatedAt: "2026-09-03T12:00:00.000Z",
    }],
    expenses: [], incomes: [], obligations: [], tasks: [], events: [], documents: [],
    getDocumentCalls: 0, bumpDataVersionCalls: 0, domainVersions: {}, lastBumpedDomains: [],
  };
  const storage: any = makeFakeStorage(db);
  let failReplacement = true;
  let nextPayment = 1;
  storage.getLiabilityPayment = async (id: string) => db.liabilityPayments.find((row: any) => row.id === id);
  storage.deleteLiabilityPayment = async (id: string) => {
    const before = db.liabilityPayments.length;
    db.liabilityPayments = db.liabilityPayments.filter((row: any) => row.id !== id);
    return db.liabilityPayments.length < before;
  };
  storage.createLiabilityPayment = async (data: any) => {
    if (failReplacement) {
      failReplacement = false;
      throw new Error("injected replacement insert failure");
    }
    const row = {
      id: `payment-restored-${nextPayment++}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...data,
    };
    db.liabilityPayments.push(row);
    return row;
  };
  storage.updateLiabilityPayment = async (id: string, patch: any) => {
    const row = db.liabilityPayments.find((candidate: any) => candidate.id === id);
    if (!row) return undefined;
    Object.assign(row, patch);
    return row;
  };
  storage.unmarkLoanPayment = async () => 0;
  storage.updateOccurrenceOverride = async () => undefined;
  storage.claimBillOccurrence = undefined;
  storage.getAccountBalanceHistory = async () => [];
  storage.getLiabilityProfileLinks = async () => [];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).userId = "server-compensation-user";
    requestStorageContext.run(storage, () => next());
  });
  const server: Server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return current = {
    db,
    storage,
    api: async (method, path, body) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "Content-Type": "application/json", "X-Timezone": "UTC" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, ok: response.ok, data: text ? JSON.parse(text) : null, headers: {} };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("D295 non-recurring payment edit compensation", () => {
  it("replays the original payment when the replacement ledger insert fails", async () => {
    const h = await bootPaymentFailure();
    const response = await h.api("PATCH", "/api/liability-payments/payment-old", { amount: 120 });

    expect(response.status).toBe(500);
    expect(response.data).toMatchObject({ reason: "payment_failed", restored: true });
    expect(h.db.liabilityPayments).toHaveLength(1);
    expect(h.db.liabilityPayments[0]).toMatchObject({
      liabilityProfileId: "loan-1",
      amount: 100,
      principalPortion: 100,
      interestPortion: 0,
      notes: "original",
      documentId: "document-1",
    });
    expect(h.db.profiles[0].fields).toMatchObject({
      currentBalance: 900,
      remainingBalance: 900,
      loanBalance: 900,
    });
  });
});
