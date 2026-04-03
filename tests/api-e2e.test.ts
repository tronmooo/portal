import { describe, it, expect, beforeAll } from 'vitest';

const BASE = "https://portol.me/api";
let TOKEN = "";

async function api(method: string, path: string, body?: any) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(TOKEN ? { "Authorization": `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, ok: r.ok, data: await r.json().catch(() => null) };
}

describe('API E2E Tests', () => {
  beforeAll(async () => {
    const res = await api("POST", "/auth/signin", { email: "tron@aol.com", password: "password" });
    expect(res.ok).toBe(true);
    TOKEN = res.data?.session?.access_token;
    expect(TOKEN).toBeTruthy();
  });

  // Auth
  it('GET /profiles returns 200', async () => {
    const r = await api("GET", "/profiles");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data)).toBe(true);
  });

  it('GET /tasks returns 200', async () => {
    const r = await api("GET", "/tasks");
    expect(r.status).toBe(200);
  });

  it('GET /habits returns 200', async () => {
    const r = await api("GET", "/habits");
    expect(r.status).toBe(200);
  });

  it('GET /trackers returns 200', async () => {
    const r = await api("GET", "/trackers");
    expect(r.status).toBe(200);
  });

  it('GET /expenses returns 200', async () => {
    const r = await api("GET", "/expenses");
    expect(r.status).toBe(200);
  });

  it('GET /events returns 200', async () => {
    const r = await api("GET", "/events");
    expect(r.status).toBe(200);
  });

  it('GET /obligations returns 200', async () => {
    const r = await api("GET", "/obligations");
    expect(r.status).toBe(200);
  });

  it('GET /goals returns 200', async () => {
    const r = await api("GET", "/goals");
    expect(r.status).toBe(200);
  });

  it('GET /incomes returns 200', async () => {
    const r = await api("GET", "/incomes");
    expect(r.status).toBe(200);
  });

  it('GET /stats returns valid dashboard stats', async () => {
    const r = await api("GET", "/stats");
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty('activeTasks');
    expect(r.data).toHaveProperty('monthlySpend');
  });

  it('GET /calendar/timeline returns array', async () => {
    const r = await api("GET", "/calendar/timeline");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data)).toBe(true);
  });

  it('GET /audit-log returns 200', async () => {
    const r = await api("GET", "/audit-log");
    expect(r.status).toBe(200);
  });

  // CRUD: Create + Delete cycle
  it('creates and deletes a task', async () => {
    const create = await api("POST", "/tasks", { title: "E2E_TEST_TASK" });
    expect(create.status).toBe(201);
    expect(create.data.id).toBeTruthy();
    
    const del = await api("DELETE", `/tasks/${create.data.id}`);
    expect(del.ok).toBe(true);
  });

  it('creates and deletes an expense', async () => {
    const create = await api("POST", "/expenses", { amount: 1.01, description: "E2E_TEST", category: "general" });
    expect(create.status).toBe(201);
    
    const del = await api("DELETE", `/expenses/${create.data.id}`);
    expect(del.ok).toBe(true);
  });

  // Profile filter
  it('filters tasks by profileId', async () => {
    const profiles = await api("GET", "/profiles");
    if (profiles.data.length > 0) {
      const pid = profiles.data[0].id;
      const r = await api("GET", `/tasks?profileId=${pid}`);
      expect(r.status).toBe(200);
    }
  });

  // Chat
  it('POST /chat returns reply', async () => {
    const r = await api("POST", "/chat", { message: "hello" });
    expect(r.status).toBe(200);
    expect(r.data).toHaveProperty('reply');
  }, 30000);
});
