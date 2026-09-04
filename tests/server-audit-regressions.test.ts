import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerRoutes } from "../server/routes";
import { requestStorageContext } from "../server/storage";
import { SupabaseStorage } from "../server/supabase-storage";
import { ProfileLinkFailure } from "../server/profile-link-failure";
import { makeFakeStorage, type FakeDb, type Harness } from "./helpers/route-harness";

interface Booted extends Harness {
  storage: any;
}

let current: Booted | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

async function boot(extend: (storage: any, db: FakeDb) => void): Promise<Booted> {
  const db: FakeDb = {
    profiles: [],
    liabilityPayments: [],
    expenses: [],
    incomes: [],
    obligations: [],
    tasks: [],
    events: [],
    documents: [],
    getDocumentCalls: 0,
    bumpDataVersionCalls: 0,
    domainVersions: {},
    lastBumpedDomains: [],
  };
  const storage: any = makeFakeStorage(db);
  extend(storage, db);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).userId = "server-audit-user";
    requestStorageContext.run(storage, () => next());
  });
  const server: Server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api: Harness["api"] = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Timezone": "America/Los_Angeles" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      data: text ? JSON.parse(text) : null,
      headers: {},
    };
  };
  return current = {
    db,
    storage,
    api,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function bareStorage(over: Record<string, any>): any {
  const storage: any = Object.create(SupabaseStorage.prototype);
  storage.userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  storage._timezone = "America/Los_Angeles";
  storage.memoEnabled = false;
  storage.memoCache = new Map();
  storage.logActivity = () => {};
  Object.assign(storage, over);
  return storage;
}

function chainClient(
  respond: (table: string, operation: string, payload?: any) => any,
) {
  const from = (table: string) => {
    const request = { operation: "select", payload: undefined as any };
    const chain: any = {};
    for (const operation of ["select", "update", "insert", "upsert", "delete"]) {
      chain[operation] = (payload?: any) => {
        if (operation !== "select") {
          request.operation = operation;
          request.payload = payload;
        }
        return chain;
      };
    }
    for (const filter of ["eq", "in"]) {
      chain[filter] = () => chain;
    }
    const result = () => Promise.resolve(respond(table, request.operation, request.payload));
    chain.maybeSingle = () => result().then((value: any) => ({
      ...value,
      data: Array.isArray(value.data) ? (value.data[0] ?? null) : value.data,
    }));
    chain.single = chain.maybeSingle;
    chain.then = (resolve: any, reject?: any) => result().then(resolve, reject);
    return chain;
  };
  return { from };
}

describe("server audit: referenced destination profiles", () => {
  const selfId = "11111111-1111-4111-8111-111111111111";
  const foreignId = "99999999-9999-4999-8999-999999999999";

  it("D289 validates every obligation linkedProfiles id before update", async () => {
    let writes = 0;
    const h = await boot((storage, db) => {
      db.profiles.push({ id: selfId, type: "self", name: "Me" });
      storage.updateObligation = async (id: string, patch: any) => {
        writes++;
        return { id, ...patch };
      };
    });

    const refused = await h.api("PATCH", "/api/obligations/bill-1", {
      linkedProfiles: [selfId, foreignId],
    });
    expect(refused.status).toBe(404);
    expect(refused.data.error).toBe("Linked profile not found");
    expect(writes).toBe(0);

    expect((await h.api("PATCH", "/api/obligations/bill-1", {
      linkedProfiles: [selfId],
    })).status).toBe(200);
    expect(writes).toBe(1);
  });

  it("D290 validates account ownerProfileId before create", async () => {
    let writes = 0;
    const h = await boot((storage, db) => {
      db.profiles.push({ id: selfId, type: "self", name: "Me" });
      storage.createAccount = async (data: any) => {
        writes++;
        return { id: "account-1", ...data };
      };
    });

    expect((await h.api("POST", "/api/accounts", {
      name: "Checking",
      ownerProfileId: { id: selfId },
    })).status).toBe(400);
    const refused = await h.api("POST", "/api/accounts", {
      name: "Checking",
      ownerProfileId: foreignId,
    });
    expect(refused.status).toBe(404);
    expect(refused.data.error).toBe("Owner profile not found");
    expect(writes).toBe(0);

    expect((await h.api("POST", "/api/accounts", {
      name: "Checking",
      ownerProfileId: selfId,
    })).status).toBe(201);
    expect(writes).toBe(1);
  });

  it("D291 validates a liability-asset link's destination before update", async () => {
    let writes = 0;
    const h = await boot((storage, db) => {
      db.profiles.push({ id: selfId, type: "self", name: "Me" });
      storage.updateLiabilityAssetLink = async (id: string, patch: any) => {
        writes++;
        return { id, ...patch };
      };
    });

    expect((await h.api("PATCH", "/api/liability-asset-links/link-1", {
      assetProfileId: { id: selfId },
    })).status).toBe(400);
    expect((await h.api("PATCH", "/api/liability-asset-links/link-1", {
      assetProfileId: foreignId,
    })).status).toBe(404);
    expect(writes).toBe(0);

    expect((await h.api("PATCH", "/api/liability-asset-links/link-1", {
      assetProfileId: selfId,
    })).status).toBe(200);
    expect(writes).toBe(1);
  });
});

describe("server audit: profile-link failures", () => {
  const profileId = "11111111-1111-4111-8111-111111111111";
  const otherProfileId = "22222222-2222-4222-8222-222222222222";
  const entityId = "33333333-3333-4333-8333-333333333333";

  it("D292 throws a typed 409 for an exclusive entity conflict", async () => {
    const client = chainClient((table) => table === "goals"
      ? { data: { linked_profiles: [otherProfileId] }, error: null }
      : { data: [], error: null });
    const storage = bareStorage({
      supabase: client,
      getProfile: async () => ({ id: profileId, documents: [] }),
    });

    await expect(storage.linkProfileTo(profileId, "goal", entityId)).rejects.toMatchObject({
      name: "ProfileLinkFailure",
      code: "PROFILE_EXCLUSIVE_CONFLICT",
      statusCode: 409,
    });
  });

  it("D292 turns link and unlink owner-write errors into typed failures", async () => {
    const clientFor = (owners: string[]) => chainClient((table, operation) =>
      table === "expenses" && operation === "update"
        ? { data: null, error: { message: "write refused" } }
        : table === "expenses"
          ? { data: { linked_profiles: owners }, error: null }
          : { data: [], error: null });
    const storageFor = (owners: string[]) => bareStorage({
      supabase: clientFor(owners),
      getProfile: async () => ({ id: profileId, documents: [] }),
      getSelfProfile: async () => ({ id: profileId }),
    });

    await expect(storageFor([]).linkProfileTo(profileId, "expense", entityId)).rejects.toMatchObject({
      code: "OWNER_WRITE_FAILED",
      statusCode: 500,
    });
    await expect(storageFor([profileId]).unlinkProfileFrom(profileId, "expense", entityId)).rejects.toMatchObject({
      code: "OWNER_WRITE_FAILED",
      statusCode: 500,
    });
  });

  it("D292 maps typed link and unlink failures to non-200 route responses", async () => {
    let failure = new ProfileLinkFailure(
      "PROFILE_EXCLUSIVE_CONFLICT",
      "goal already belongs to another profile",
      409,
    );
    const h = await boot((storage, db) => {
      db.profiles.push({ id: profileId, type: "self", name: "Me" });
      storage.getGoal = async () => ({ id: entityId });
      storage.linkProfileTo = async () => { throw failure; };
      storage.unlinkProfileFrom = async () => { throw failure; };
    });

    const conflict = await h.api("POST", `/api/profiles/${profileId}/link`, {
      entityType: "goal",
      entityId,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.data.code).toBe("PROFILE_EXCLUSIVE_CONFLICT");

    failure = new ProfileLinkFailure("OWNER_WRITE_FAILED", "Failed to link goal", 500);
    const failedLink = await h.api("POST", `/api/profiles/${profileId}/link`, {
      entityType: "goal",
      entityId,
    });
    expect(failedLink.status).toBe(500);
    expect(failedLink.data).toEqual({ error: "Link failed", code: "OWNER_WRITE_FAILED" });

    const failedUnlink = await h.api("POST", `/api/profiles/${profileId}/unlink`, {
      entityType: "goal",
      entityId,
    });
    expect(failedUnlink.status).toBe(500);
    expect(failedUnlink.data).toEqual({ error: "Unlink failed", code: "OWNER_WRITE_FAILED" });
  });
});
