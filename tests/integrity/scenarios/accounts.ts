// Accounts, permissions and load — the systems that could not be tested while
// the only database was production's: creating an account, resetting its
// password, wiping it, exporting and importing a whole account, what an
// unauthenticated or other account can reach, and the server under load.
//
// Every scenario here is `isolatedOnly`: it runs against tests/isolated (a
// throwaway database on this machine) and is SKIPPED against any deployed app.
import { scenario, type Ctx } from "../framework";
import { API_BASE, SB_URL, SB_ANON, SMOKE_USER_ID } from "../../smoke/fixture/account";

type Res = { status: number; ok: boolean; data: any; headers: Headers; ms: number };
const MAIL = process.env.ISOLATED_MAIL_API || "http://127.0.0.1:54325";
const SERVICE = process.env.ISOLATED_SERVICE_KEY || "";
const PASSWORD = "Isolated-Run-1!";

/** One request, as nobody (`token` omitted) or as `token`. `ip` picks the auth limiter's bucket. */
async function raw(method: string, path: string, body?: any, opts: { token?: string; ip?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const t0 = Date.now();
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json", "X-Timezone": "America/Los_Angeles",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.ip ? { "X-Forwarded-For": opts.ip } : {}),
      ...(opts.headers || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, ok: r.ok, data, headers: r.headers, ms: Date.now() - t0 };
}
/** Rows of `table` as seen by `token` (PostgREST: that account's own row-level security). */
async function rowsAs(token: string | null, table: string, query = ""): Promise<{ status: number; rows: any[] }> {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?select=*${query ? `&${query}` : ""}`, { headers: { apikey: SB_ANON, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const body = await r.json().catch(() => null);
  return { status: r.status, rows: Array.isArray(body) ? body : [] };
}
const ipFor = (ctx: Ctx, n = 0) => `10.${ctx.int(1, 250)}.${ctx.int(1, 250)}.${(ctx.int(1, 200) + n) % 250 + 1}`;
const emailFor = (ctx: Ctx, who: string) => `${who}.${ctx.tag.toLowerCase()}@isolated.test`;

async function signUp(ctx: Ctx, who: string, ip: string): Promise<{ id: string; token: string; email: string }> {
  const email = emailFor(ctx, who);
  const r = await raw("POST", "/auth/signup", { email, password: PASSWORD }, { ip });
  if (!r.ok || !r.data?.session?.access_token) throw new Error(`sign-up ${email}: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  ctx.step(`POST /api/auth/signup ${email} → ${r.status}`);
  return { id: String(r.data.user.id), token: String(r.data.session.access_token), email };
}
const signIn = (email: string, password: string, ip: string) => raw("POST", "/auth/signin", { email, password }, { ip });
/** The auth user(s) with this e-mail, read from the auth service itself. */
async function authUsers(email: string): Promise<any[]> {
  const r = await fetch(`${SB_URL}/auth/v1/admin/users?per_page=1000`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  const j: any = await r.json().catch(() => ({}));
  return (j.users || []).filter((u: any) => String(u.email).toLowerCase() === email.toLowerCase());
}

// ── sign-up ──────────────────────────────────────────────────────────────────
scenario({
  id: "accounts.signup-and-first-data",
  title: "Creating an account: the user exists once, starts with its own profile, and sees nothing of anyone else's",
  area: "access", covers: ["access.create.api", "isolation.read", "isolation.database"], requires: ["action", "db"], isolatedOnly: true,
  run: async (ctx) => {
    const ip = ipFor(ctx);
    const a = await signUp(ctx, "new", ip);
    ctx.check("action", /^[0-9a-f-]{36}$/.test(a.id) && a.id !== SMOKE_USER_ID, "sign-up answers a session for a new user id");
    ctx.check("db", (await authUsers(a.email)).length === 1, "the auth service holds exactly one user with that e-mail");

    // The account's own profile (Self) is made on its first request. Eight
    // first requests at once must still make exactly ONE.
    const first = await Promise.all(Array.from({ length: 8 }, () => raw("GET", "/profiles", undefined, { token: a.token })));
    ctx.check("action", first.every((r) => r.ok), "its first eight requests, sent at once, all answer", first.map((r) => r.status).join(","));
    const selfRows = (await rowsAs(a.token, "profiles", "type=eq.self")).rows;
    ctx.check("db", selfRows.length === 1 && selfRows[0].user_id === a.id, "the account has exactly one profile of its own (Self), however many requests arrived first", JSON.stringify(selfRows.map((p) => [p.name, p.type])));
    ctx.check("db", (await rowsAs(a.token, "profiles")).rows.length === 1, "and nothing else: a new account starts empty");
    const me = await raw("GET", "/auth/me", undefined, { token: a.token });
    ctx.check("action", me.ok && String(me.data?.user?.id ?? me.data?.id) === a.id, "the session it was given is that user's", JSON.stringify(me.data).slice(0, 120));

    // what it sees of the OTHER account (the smoke account): nothing
    const mine = await ctx.api("POST", "/tasks", { title: `${ctx.tag} smoke-owned` });
    ctx.cleanup(() => ctx.api("DELETE", `/tasks/${mine.data?.id}`));
    const list = await raw("GET", "/tasks", undefined, { token: a.token });
    ctx.check("isolation", list.ok && Array.isArray(list.data) && !list.data.some((t: any) => t.id === mine.data.id), "its task list does not contain another account's task");
    ctx.check("isolation", (await rowsAs(a.token, "tasks", `id=eq.${mine.data.id}`)).rows.length === 0, "asked for by id in the database, the other account's row is not returned");
    const patch = await raw("PATCH", `/tasks/${mine.data.id}`, { title: "taken" }, { token: a.token });
    const still = await ctx.db.row("tasks", mine.data.id);
    ctx.check("isolation", !patch.ok && still?.title === `${ctx.tag} smoke-owned`, `it cannot change it (${patch.status}); the row is untouched`);

    // refusals leave nothing behind
    const dup = await raw("POST", "/auth/signup", { email: a.email, password: PASSWORD }, { ip });
    ctx.check("action", dup.status === 400, `the same e-mail a second time is refused (${dup.status})`);
    ctx.check("db", (await authUsers(a.email)).length === 1, "and there is still exactly one user");
    const badEmail = `not-an-email-${ctx.tag}`;
    const bad = await raw("POST", "/auth/signup", { email: badEmail, password: PASSWORD }, { ip });
    ctx.check("action", bad.status === 400, `an invalid e-mail is refused (${bad.status})`);
    const weakEmail = emailFor(ctx, "weak");
    const weak = await raw("POST", "/auth/signup", { email: weakEmail, password: "short" }, { ip });
    ctx.check("action", weak.status === 400, `a too-short password is refused (${weak.status})`);
    ctx.check("db", (await authUsers(weakEmail)).length === 0, "and no user was created for it");

    const good = await signIn(a.email, PASSWORD, ip);
    const wrong = await signIn(a.email, `${PASSWORD}x`, ip);
    ctx.check("action", good.ok && !!good.data?.session?.access_token, "it can sign in with its password");
    ctx.check("action", !wrong.ok && !wrong.data?.session, `and not with a wrong one (${wrong.status})`);
  },
});

// ── password change and reset ────────────────────────────────────────────────
scenario({
  id: "accounts.password-change-and-reset",
  title: "Changing and resetting a password: the old one stops working, the new one works, and a bad token changes nothing",
  area: "access", covers: ["access.edit.api"], requires: ["action", "db"], isolatedOnly: true,
  run: async (ctx) => {
    const ip = ipFor(ctx);
    const a = await signUp(ctx, "pw", ip);
    const P2 = "Changed-Once-2!"; const P3 = "Reset-By-Mail-3!";

    const wrongCurrent = await raw("POST", "/auth/change-password", { currentPassword: "nope-nope-1", newPassword: P2 }, { token: a.token, ip });
    ctx.check("action", wrongCurrent.status === 401, `changing it with the wrong current password is refused (${wrongCurrent.status})`);
    ctx.check("db", (await signIn(a.email, PASSWORD, ip)).ok, "and the original password still signs in");
    const anon = await raw("POST", "/auth/change-password", { currentPassword: PASSWORD, newPassword: P2 }, { ip });
    ctx.check("action", anon.status === 401, `nobody can change it without a session (${anon.status})`);

    const changed = await raw("POST", "/auth/change-password", { currentPassword: PASSWORD, newPassword: P2 }, { token: a.token, ip });
    ctx.check("action", changed.ok, `with the right current password it changes (${changed.status})`);
    ctx.check("db", !(await signIn(a.email, PASSWORD, ip)).ok, "the old password no longer signs in");
    ctx.check("db", (await signIn(a.email, P2, ip)).ok, "the new one does");

    // reset by e-mail: the link auth sends, read from the mail catcher
    const ip2 = ipFor(ctx, 7);
    const unknown = await raw("POST", "/auth/forgot-password", { email: emailFor(ctx, "nobody") }, { ip: ip2 });
    const asked = await raw("POST", "/auth/forgot-password", { email: a.email }, { ip: ip2 });
    ctx.check("action", asked.ok, `asking for a reset link is accepted (${asked.status})`);
    ctx.check("action", unknown.status === asked.status && JSON.stringify(unknown.data) === JSON.stringify(asked.data),
      "an address with no account gets the SAME answer (it does not reveal who has an account)", `${unknown.status} ${JSON.stringify(unknown.data).slice(0, 80)} vs ${asked.status}`);
    let link = "";
    for (let i = 0; i < 20 && !link; i++) {
      const box: any = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${a.email}`)}`)).json().catch(() => ({}));
      const msg = (box.messages || [])[0];
      if (msg) {
        const full: any = await (await fetch(`${MAIL}/api/v1/message/${msg.ID}`)).json();
        link = (String(full.HTML || full.Text || "").match(/https?:\/\/[^\s"'<>]+\/verify\?[^\s"'<>]+/) || [""])[0].replace(/&amp;/g, "&");
      }
      if (!link) await new Promise((r) => setTimeout(r, 500));
    }
    ctx.check("action", !!link && /type=recovery/.test(link), "a reset e-mail reached the address, with a recovery link");
    const nobodyMail: any = await (await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${emailFor(ctx, "nobody")}`)}`)).json().catch(() => ({}));
    ctx.check("action", (nobodyMail.messages || []).length === 0, "nothing was sent to the address with no account");
    if (link) {
      const hop = await fetch(link.replace("//localhost:", "//127.0.0.1:"), { redirect: "manual" });
      const frag = String(hop.headers.get("location") || "").split("#")[1] || "";
      const token = new URLSearchParams(frag).get("access_token") || "";
      ctx.check("action", !!token, "following the link yields a one-time session for the reset", `status ${hop.status}`);
      const bad = await raw("POST", "/auth/reset-password", { access_token: "not-a-real-token", password: P3 }, { ip: ip2 });
      ctx.check("action", bad.status === 401, `a made-up token is refused (${bad.status})`);
      ctx.check("db", (await signIn(a.email, P2, ip2)).ok, "and the password is unchanged by it");
      const reset = await raw("POST", "/auth/reset-password", { access_token: token, password: P3 }, { ip: ip2 });
      ctx.check("action", reset.ok, `the real token sets the new password (${reset.status})`);
      ctx.check("db", (await signIn(a.email, P3, ip2)).ok, "the reset password signs in");
      ctx.check("db", !(await signIn(a.email, P2, ip2)).ok, "the previous one no longer does");
    }
  },
});

// ── wiping an account ────────────────────────────────────────────────────────
const WIPED_TABLES = ["tasks", "expenses", "events", "habits", "trackers", "tracker_entries", "journal_entries", "artifacts", "goals", "incomes", "memories", "documents"];
async function fill(ctx: Ctx, token: string): Promise<Record<string, any>> {
  const as = (m: string, p: string, b?: any) => raw(m, p, b, { token });
  const need = async (label: string, r: Promise<Res>) => { const x = await r; if (!x.ok) throw new Error(`${label}: ${x.status} ${JSON.stringify(x.data).slice(0, 160)}`); return x.data; };
  const out: Record<string, any> = {};
  out.asset = await need("asset", as("POST", "/profiles", { type: "asset", name: `${ctx.tag} Bike`, fields: { currentValue: 800, purchasePrice: 1000 } }));
  out.task = await need("task", as("POST", "/tasks", { title: `${ctx.tag} task`, dueDate: ctx.today }));
  out.expenseA = await need("expense", as("POST", "/expenses", { amount: 12.5, description: `${ctx.tag} lunch`, category: "food", date: ctx.today }));
  out.expenseB = await need("expense", as("POST", "/expenses", { amount: 12.5, description: `${ctx.tag} lunch`, category: "food", date: ctx.today }));
  out.event = await need("event", as("POST", "/events", { title: `${ctx.tag} event`, date: ctx.today }));
  out.habit = await need("habit", as("POST", "/habits", { name: `${ctx.tag} habit`, frequency: "daily" }));
  out.tracker = await need("tracker", as("POST", "/trackers", { name: `${ctx.tag} reps`, category: "fitness", fields: [{ name: "reps", type: "number" }] }));
  out.entry = await need("entry", as("POST", `/trackers/${out.tracker.id}/entries`, { values: { reps: 9 }, allowDuplicate: true }));
  out.journal = await need("journal", as("POST", "/journal", { content: `${ctx.tag} a day worth writing down`, mood: "good", date: ctx.today }));
  out.note = await need("note", as("POST", "/notes", { title: `${ctx.tag} note`, content: "remember the milk" }));
  out.goal = await need("goal", as("POST", "/goals", { title: `${ctx.tag} goal`, type: "savings", target: 500, unit: "$" }));
  out.income = await need("income", as("POST", "/incomes", { amount: 900, description: `${ctx.tag} gig`, category: "freelance", frequency: "once", date: ctx.today }));
  out.memory = await need("memory", as("POST", "/memories", { key: `${ctx.tag.toLowerCase()}_fact`, value: "the gate code is 4411", category: "general" }));
  return out;
}
async function counts(token: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of [...WIPED_TABLES, "profiles"]) out[t] = (await rowsAs(token, t, t === "profiles" ? "" : "")).rows.filter((r) => !r.deleted_at).length;
  return out;
}

scenario({
  id: "accounts.delete-all-data",
  title: "Wiping an account: without the typed confirmation nothing goes; with it every row of THAT account goes and nobody else's does",
  area: "access", covers: ["access.delete.api", "access.cancel.api", "isolation.write"], requires: ["action", "db"], isolatedOnly: true,
  run: async (ctx) => {
    const a = await signUp(ctx, "wipe", ipFor(ctx));
    const made = await fill(ctx, a.token);
    const before = await counts(a.token);
    ctx.check("db", ["tasks", "expenses", "events", "habits", "trackers", "tracker_entries", "journal_entries", "goals", "incomes", "memories"].every((t) => before[t] >= 1) && before.expenses === 2,
      "the account holds a record of every kind (two identical expenses among them)", JSON.stringify(before));

    const smoke = await ctx.api("POST", "/tasks", { title: `${ctx.tag} not mine to wipe` });
    ctx.cleanup(() => ctx.api("DELETE", `/tasks/${smoke.data?.id}`));
    const smokeTasksBefore = await ctx.db.count("tasks", "deleted_at=is.null");

    const noConfirm = await raw("DELETE", "/data/all", {}, { token: a.token });
    const wrongWord = await raw("DELETE", "/data/all", { confirmation: "delete" }, { token: a.token });
    ctx.check("action", noConfirm.status === 400 && wrongWord.status === 400, `without the exact confirmation it is refused (${noConfirm.status}, ${wrongWord.status})`);
    ctx.same("db", await counts(a.token), before, "and every row is still there");
    const anon = await raw("DELETE", "/data/all", { confirmation: "DELETE" });
    ctx.check("action", anon.status === 401, `nobody can wipe without a session (${anon.status})`);

    const wiped = await raw("DELETE", "/data/all", { confirmation: "DELETE" }, { token: a.token });
    ctx.check("action", wiped.ok, `with the confirmation it runs (${wiped.status})`, JSON.stringify(wiped.data).slice(0, 200));
    const after = await counts(a.token);
    ctx.check("db", WIPED_TABLES.every((t) => after[t] === 0), "every record table is empty for that account", JSON.stringify(after));
    const profilesAfter = (await rowsAs(a.token, "profiles")).rows.filter((p) => !p.deleted_at);
    ctx.check("db", profilesAfter.length === 1 && profilesAfter[0].type === "self", "one profile remains — a fresh Self, so the next record has an owner", JSON.stringify(profilesAfter.map((p) => [p.name, p.type])));
    ctx.check("db", !profilesAfter.some((p) => p.id === made.asset.id), "the asset is gone with the rest");
    const prefs = (await rowsAs(a.token, "preferences")).rows;
    ctx.check("db", !prefs.some((p) => /^(details:|versions:|budget:)/.test(String(p.key))), "no per-record preference rows are left behind", prefs.map((p) => p.key).join(", ").slice(0, 200));

    ctx.same("db", await ctx.db.count("tasks", "deleted_at=is.null"), smokeTasksBefore, "the OTHER account has exactly the rows it had");
    ctx.check("db", !!(await ctx.db.row("tasks", smoke.data.id)), "its task is untouched");

    const list = await raw("GET", "/tasks", undefined, { token: a.token });
    const fresh = await raw("POST", "/tasks", { title: `${ctx.tag} after the wipe` }, { token: a.token });
    ctx.check("action", list.ok && Array.isArray(list.data) && list.data.length === 0 && fresh.ok, "the account still works afterwards: an empty list, and a new task saves");
    ctx.check("db", Array.isArray(fresh.data?.linkedProfiles) && fresh.data.linkedProfiles[0] === profilesAfter[0]?.id, "and that task belongs to the new Self");
    ctx.finding({ severity: "gap", title: "There is no way to delete the ACCOUNT itself", detail: "DELETE /api/data/all removes every record and leaves the sign-in (auth user) in place; no route or screen removes the user. A person who asks for their account to be deleted keeps an empty one." });
  },
});

// ── export and import ────────────────────────────────────────────────────────
scenario({
  id: "accounts.export-import",
  title: "Export and import: a whole account comes out, goes into another, totals agree, and the same file twice adds nothing",
  area: "access", covers: ["access.duplicate.api", "access.transfer.api"], requires: ["action", "db", "derived"], isolatedOnly: true,
  run: async (ctx) => {
    const src = await signUp(ctx, "exp", ipFor(ctx));
    const dst = await signUp(ctx, "imp", ipFor(ctx, 11));
    await fill(ctx, src.token);
    const srcBefore = await counts(src.token);

    const exported = await raw("GET", "/export", undefined, { token: src.token });
    ctx.check("action", exported.ok && !!exported.data?.version, `the export answers a versioned file (${exported.status})`);
    const file = exported.data || {};
    const names = (k: string, f: string) => (Array.isArray(file[k]) ? file[k] : []).map((x: any) => String(x[f] ?? ""));
    ctx.check("action", names("tasks", "title").includes(`${ctx.tag} task`) && names("expenses", "description").filter((d) => d === `${ctx.tag} lunch`).length === 2
      && names("events", "title").includes(`${ctx.tag} event`) && names("habits", "name").includes(`${ctx.tag} habit`)
      && names("profiles", "name").includes(`${ctx.tag} Bike`), "it contains the task, BOTH identical expenses, the event, the habit and the asset");
    ctx.check("action", !JSON.stringify(file).includes(src.token.slice(0, 40)) && !/password|access_token|refresh_token/i.test(JSON.stringify(Object.keys(file))), "it carries no session or password");
    const anon = await raw("GET", "/export");
    ctx.check("action", anon.status === 401, `nobody can export without a session (${anon.status})`);
    const other = await raw("GET", "/export", undefined, { token: dst.token });
    ctx.check("isolation", other.ok && !JSON.stringify(other.data).includes(ctx.tag + " lunch"), "another account's export contains none of it");

    const noVersion = await raw("POST", "/import", { tasks: [{ title: "x" }] }, { token: dst.token });
    ctx.check("action", noVersion.status === 400, `a file with no version is refused (${noVersion.status})`);
    const dstEmpty = await counts(dst.token);
    ctx.check("db", dstEmpty.tasks === 0 && dstEmpty.expenses === 0, "and wrote nothing");

    const imported = await raw("POST", "/import", file, { token: dst.token });
    ctx.check("action", imported.ok, `the import runs (${imported.status})`, JSON.stringify(imported.data).slice(0, 300));
    const dstAfter = await counts(dst.token);
    for (const t of ["tasks", "expenses", "events", "habits", "goals", "incomes"]) ctx.same("db", dstAfter[t], srcBefore[t], `${t}: the target holds as many as the source`);
    const sum = async (token: string) => (await rowsAs(token, "expenses")).rows.filter((r) => !r.deleted_at).reduce((s, r) => s + Number(r.amount), 0);
    ctx.near("derived", await sum(dst.token), 25, "the imported expenses total what the source's did (2 × 12.50)");
    ctx.near("derived", await sum(src.token), 25, "the source's total is unchanged");
    const bike = (await rowsAs(dst.token, "profiles")).rows.find((p) => p.name === `${ctx.tag} Bike`);
    ctx.check("db", !!bike && Number(bike.fields?.currentValue) === 800 && bike.user_id === dst.id, "the asset arrived with its value, owned by the target account", JSON.stringify(bike?.fields));
    const dstTasks = (await rowsAs(dst.token, "tasks")).rows;
    ctx.check("db", dstTasks.every((t) => t.user_id === dst.id), "every imported row belongs to the target account");
    ctx.same("db", await counts(src.token), srcBefore, "the source account is exactly as it was");

    const again = await raw("POST", "/import", file, { token: dst.token });
    ctx.check("action", again.status === 409, `the same file a second time is refused (${again.status})`);
    ctx.same("db", await counts(dst.token), dstAfter, "and nothing was added twice");
  },
});

// ── permissions ──────────────────────────────────────────────────────────────
const USER_TABLES = ["profiles", "tasks", "expenses", "events", "habits", "habit_checkins", "trackers", "tracker_entries", "journal_entries", "artifacts", "goals", "incomes", "memories", "documents", "preferences", "liability_payments"];
const PRIVATE_ROUTES: Array<[string, string, any?]> = [
  ["GET", "/tasks"], ["GET", "/expenses"], ["GET", "/profiles"], ["GET", "/events"], ["GET", "/habits"], ["GET", "/trackers"], ["GET", "/journal"],
  ["GET", "/artifacts"], ["GET", "/goals"], ["GET", "/incomes"], ["GET", "/memories"], ["GET", "/documents"], ["GET", "/dashboard-enhanced"], ["GET", "/export"],
  ["GET", "/preferences/exec_card_prefs"], ["GET", "/data-version"], ["GET", "/diagnostics/schema"],
  ["POST", "/tasks", { title: "x" }], ["POST", "/expenses", { amount: 1, description: "x", category: "food" }], ["POST", "/chat", { message: "hi", history: [] }],
  ["PATCH", "/tasks/00000000-0000-4000-8000-000000000000", { title: "x" }], ["DELETE", "/tasks/00000000-0000-4000-8000-000000000000"],
  ["DELETE", "/data/all", { confirmation: "DELETE" }], ["POST", "/import", { version: 1 }],
];

scenario({
  id: "security.permissions",
  title: "Permissions: nothing private answers without a session, the database refuses the public key, and the sign-in limiter holds",
  area: "access", covers: ["isolation.read", "isolation.write", "isolation.database"], requires: ["action", "db"], isolatedOnly: true,
  run: async (ctx) => {
    const seeded = await ctx.api("POST", "/tasks", { title: `${ctx.tag} private` });
    ctx.cleanup(() => ctx.api("DELETE", `/tasks/${seeded.data?.id}`));

    const open: string[] = []; const leaked: string[] = [];
    for (const [m, p, b] of PRIVATE_ROUTES) {
      for (const [label, token] of [["no session", undefined], ["a made-up token", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.nope"]] as const) {
        const r = await raw(m, p, b, { token });
        if (r.status !== 401 && r.status !== 403) open.push(`${m} ${p} with ${label} → ${r.status}`);
        if (JSON.stringify(r.data).includes(ctx.tag)) leaked.push(`${m} ${p}`);
      }
    }
    ctx.check("action", open.length === 0, `${PRIVATE_ROUTES.length} private routes refuse a request with no session and with a made-up token`, open.slice(0, 6).join("; "));
    ctx.check("isolation", leaked.length === 0, "and none of the refusals carries the account's data", leaked.join("; "));
    ctx.check("db", !!(await ctx.db.row("tasks", seeded.data.id)) && (await ctx.db.count("tasks", "title=eq.x")) === 0, "none of those requests wrote or removed a row");

    // the database itself, with only the public (anon) key: row-level security
    const visible: string[] = [];
    for (const t of USER_TABLES) { const r = await rowsAs(null, t, "limit=5"); if (r.rows.length) visible.push(`${t} (${r.rows.length})`); }
    ctx.check("db", visible.length === 0, `the public key alone reads no row of ${USER_TABLES.length} tables`, visible.join(", "));
    const write = await fetch(`${SB_URL}/rest/v1/tasks`, { method: "POST", headers: { apikey: SB_ANON, "Content-Type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ title: `${ctx.tag} injected`, user_id: SMOKE_USER_ID }) });
    ctx.check("db", !write.ok && (await ctx.db.count("tasks", `title=eq.${encodeURIComponent(`${ctx.tag} injected`)}`)) === 0, `and cannot insert a row into another account (${write.status})`);

    // a signed-in account cannot insert a row that claims to be someone else's
    const b = await signUp(ctx, "perm", ipFor(ctx));
    const forged = await fetch(`${SB_URL}/rest/v1/tasks`, { method: "POST", headers: { apikey: SB_ANON, Authorization: `Bearer ${b.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ title: `${ctx.tag} forged`, user_id: SMOKE_USER_ID }) });
    ctx.check("db", !forged.ok && (await ctx.db.count("tasks", `title=eq.${encodeURIComponent(`${ctx.tag} forged`)}`)) === 0, `a signed-in account cannot write a row under another user's id (${forged.status})`);
    const stolen = await fetch(`${SB_URL}/rest/v1/tasks?id=eq.${seeded.data.id}`, { method: "DELETE", headers: { apikey: SB_ANON, Authorization: `Bearer ${b.token}`, Prefer: "return=representation" } });
    const gone = await stolen.json().catch(() => []);
    ctx.check("db", Array.isArray(gone) && gone.length === 0 && !!(await ctx.db.row("tasks", seeded.data.id)), "nor delete another account's row straight in the database");

    // the sign-in limiter: ten attempts a minute from one address
    const attacker = ipFor(ctx, 31);
    const tries: number[] = [];
    for (let i = 0; i < 13; i++) tries.push((await signIn(b.email, `wrong-${i}-xxxxxxxx`, attacker)).status);
    ctx.check("action", tries.slice(0, 10).every((s) => s !== 429 && s >= 400) && tries.slice(10).every((s) => s === 429), "ten wrong passwords from one address are refused one by one; from the eleventh the address is turned away", tries.join(","));
    // …and the count is in the SHARED table, so every server instance sees it
    // (it used to be refused there and fall back to one instance's memory).
    const shared = await fetch(`${SB_URL}/rest/v1/auth_rate_limits?select=*`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
    const sharedRows: any[] = await shared.json().catch(() => []);
    ctx.check("db", Array.isArray(sharedRows) && sharedRows.length > 0, "the attempts are counted in the shared limiter table", `status ${shared.status}, ${Array.isArray(sharedRows) ? sharedRows.length : 0} row(s)`);
    ctx.check("db", (await rowsAs(b.token, "auth_rate_limits")).rows.length === 0, "which no signed-in account can read");
    const lockedOut = await signIn(b.email, PASSWORD, attacker);
    const elsewhere = await signIn(b.email, PASSWORD, ipFor(ctx, 47));
    ctx.check("action", lockedOut.status === 429 && elsewhere.ok, "even the right password is turned away from that address for the minute, and works from another");
  },
});

// ── load ─────────────────────────────────────────────────────────────────────
async function pool<T>(n: number, jobs: Array<() => Promise<T>>): Promise<T[]> {
  const out: T[] = new Array(jobs.length); let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); } }));
  return out;
}
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0; };

scenario({
  id: "perf.load",
  title: "Under load: hundreds of reads and writes at once — no failure, no lost or doubled row, and every list is complete straight after",
  area: "access", covers: ["task.create.api", "task.delete.api", "expense.create.api"], requires: ["action", "db", "derived"], isolatedOnly: true,
  run: async (ctx) => {
    const READS = ["/tasks", "/expenses", "/events", "/habits", "/profiles", "/dashboard-enhanced"];
    const reads = await pool(25, Array.from({ length: 300 }, (_, i) => () => ctx.api("GET", READS[i % READS.length])));
    const badReads = reads.filter((r) => r.status !== 200);
    ctx.check("action", badReads.length === 0, "300 reads, 25 at a time: every one answers 200", badReads.slice(0, 5).map((r) => r.status).join(","));
    const rms = reads.map((r) => r.ms);
    ctx.step(`reads: median ${pct(rms, 50)} ms, p95 ${pct(rms, 95)} ms, slowest ${Math.max(...rms)} ms`);
    ctx.check("perf", pct(rms, 95) < 3000, `95% of reads under 3 s while 25 run at once (p95 ${pct(rms, 95)} ms)`);

    const N = 80;
    const writes = await pool(20, Array.from({ length: N }, (_, i) => () => ctx.api("POST", "/tasks", { title: `${ctx.tag} load ${String(i).padStart(3, "0")}` })));
    ctx.cleanup(async () => { for (const r of await ctx.db.rows("tasks", `title=like.${encodeURIComponent(`${ctx.tag} load %`)}&deleted_at=is.null`)) await ctx.api("DELETE", `/tasks/${r.id}`); });
    const badWrites = writes.filter((r) => r.status !== 201);
    ctx.check("action", badWrites.length === 0, `${N} task creates, 20 at a time: every one answers 201`, badWrites.slice(0, 5).map((r) => `${r.status} ${JSON.stringify(r.data).slice(0, 60)}`).join("; "));
    const wms = writes.map((r) => r.ms);
    ctx.step(`writes: median ${pct(wms, 50)} ms, p95 ${pct(wms, 95)} ms`);
    const stored = await ctx.db.rows("tasks", `title=like.${encodeURIComponent(`${ctx.tag} load %`)}&deleted_at=is.null`);
    ctx.same("db", stored.length, N, "exactly as many rows are stored as were accepted");
    ctx.same("db", new Set(stored.map((r: any) => r.title)).size, N, "each once — none lost, none doubled");
    ctx.same("db", new Set(writes.map((r) => r.data?.id)).size, N, "and every answer named a different row");
    const list = await ctx.api("GET", "/tasks");
    const listed = (Array.isArray(list.data) ? list.data : []).filter((t: any) => String(t.title).startsWith(`${ctx.tag} load `)).length;
    ctx.same("derived", listed, N, "the task list, read straight after, shows all of them");

    // identical expenses under load: allowed, and counted exactly
    const M = 40;
    const same = await pool(20, Array.from({ length: M }, () => () => ctx.api("POST", "/expenses", { amount: 3.25, description: `${ctx.tag} same coffee`, category: "food", date: ctx.today })));
    ctx.cleanup(async () => { for (const r of await ctx.db.rows("expenses", `description=eq.${encodeURIComponent(`${ctx.tag} same coffee`)}&deleted_at=is.null`)) await ctx.api("DELETE", `/expenses/${r.id}`); });
    ctx.check("action", same.every((r) => r.status === 201), `${M} identical expenses at once are all accepted`, [...new Set(same.map((r) => r.status))].join(","));
    const rows = await ctx.db.rows("expenses", `description=eq.${encodeURIComponent(`${ctx.tag} same coffee`)}&deleted_at=is.null`);
    ctx.same("db", rows.length, M, "and all are stored");
    ctx.near("derived", rows.reduce((s: number, r: any) => s + Number(r.amount), 0), M * 3.25, "their total is the sum of all of them");

    // the same REQUEST repeated at once is one row
    const key = `sub-${ctx.tag.toLowerCase()}-load`;
    const { fetchWithRateLimitRetry, getSmokeToken } = await import("../../smoke/fixture/api");
    const keyed = await pool(10, Array.from({ length: 10 }, () => async () => (await fetchWithRateLimitRetry(`${API_BASE}/expenses`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getSmokeToken()}`, "Idempotency-Key": key },
      body: JSON.stringify({ amount: 7.5, description: `${ctx.tag} keyed`, category: "food", date: ctx.today }),
    })).response.status));
    ctx.cleanup(async () => { for (const r of await ctx.db.rows("expenses", `description=eq.${encodeURIComponent(`${ctx.tag} keyed`)}&deleted_at=is.null`)) await ctx.api("DELETE", `/expenses/${r.id}`); });
    ctx.check("action", keyed.every((s) => s === 200 || s === 201), "ten copies of one keyed request at once are all answered", keyed.join(","));
    ctx.same("db", (await ctx.db.rows("expenses", `description=eq.${encodeURIComponent(`${ctx.tag} keyed`)}&deleted_at=is.null`)).length, 1, "and exactly one row exists");

    const cleanup = await pool(20, stored.map((r: any) => () => ctx.api("DELETE", `/tasks/${r.id}`)));
    ctx.check("action", cleanup.every((r) => r.ok), "all of them delete again, 20 at a time");
    ctx.same("db", (await ctx.db.rows("tasks", `title=like.${encodeURIComponent(`${ctx.tag} load %`)}&deleted_at=is.null`)).length, 0, "and none is left");
  },
});
