// Cross-cutting: hostile and unusual input, simultaneous edits, repeated
// requests, interrupted requests, failed writes, account isolation, dates at
// the edges of months. The question for every case is the same: what is in
// the database afterwards?
import { scenario, listOf, must, getOtherToken, type Ctx } from "../framework";
import { fetchWithRateLimitRetry, getSmokeToken } from "../../smoke/fixture/api";
import { API_BASE, SB_URL, SB_ANON, SMOKE_USER_ID } from "../../smoke/fixture/account";
import * as O from "../oracle";

const gone = (row: any) => row === null || row.deleted_at != null;

interface Door { name: string; path: string; table: string; nameCol: string; valid: (tag: string, today: string) => any; textField: string; /** cases this door accepts by design */ allows?: string[] }
const DOORS: Door[] = [
  { name: "expense", path: "/expenses", table: "expenses", nameCol: "description", textField: "description", valid: (t, d) => ({ description: `${t} x`, amount: 5, category: "food", date: d }) },
  { name: "income", path: "/incomes", table: "incomes", nameCol: "description", textField: "description", valid: (t, d) => ({ description: `${t} x`, amount: 5, category: "salary", date: d }) },
  { name: "task", path: "/tasks", table: "tasks", nameCol: "title", textField: "title", valid: (t) => ({ title: `${t} x` }) },
  { name: "event", path: "/events", table: "events", nameCol: "title", textField: "title", valid: (t, d) => ({ title: `${t} x`, date: d }) },
  { name: "habit", path: "/habits", table: "habits", nameCol: "name", textField: "name", valid: (t) => ({ name: `${t} x`, frequency: "daily" }) },
  { name: "goal", path: "/goals", table: "goals", nameCol: "title", textField: "title", valid: (t) => ({ title: `${t} x`, type: "custom", target: 5, unit: "x" }) },
  { name: "profile", path: "/profiles", table: "profiles", nameCol: "name", textField: "name", valid: (t) => ({ type: "asset", name: `${t} x`, fields: { currentValue: 1 } }) },
  { name: "note", path: "/notes", table: "artifacts", nameCol: "title", textField: "title", valid: (t) => ({ title: `${t} x`, content: `${t} body` }),
    // J8: a note's title never costs a save — a blank one is written from the text, a number is its own text.
    // An object is not a title either: it is ignored and the title is written from the text.
    allows: ["a blank name", "a name that is a number", "a name that is an object"] },
];

scenario({
  id: "hardening.refused-input-writes-nothing",
  title: "Invalid values are refused with a reason, never a server error, and write nothing",
  area: "Input validation",
  covers: ["expense.create.api", "income.create.api", "task.create.api", "event.create.api", "habit.create.api", "goal.create.api", "asset.create.api", "note.create.api"],
  requires: ["action", "db"],
  run: async (ctx) => {
    const bads: Array<[string, (v: any) => any]> = [
      ["no body", () => undefined],
      ["an array", () => []],
      ["a blank name", (v) => v],
    ];
    for (const door of DOORS) {
      const before = 0;
      const valid = door.valid(ctx.tag, ctx.today);
      const cases: Array<[string, any]> = [
        ["an empty object", {}],
        ["a blank name", { ...valid, [door.textField]: "   " }],
        ["a name that is a number", { ...valid, [door.textField]: 12345 }],
        ["a name that is an object", { ...valid, [door.textField]: { $ne: null } }],
      ];
      if ("amount" in valid) cases.push(
        ["amount \"abc\"", { ...valid, amount: "abc" }], ["a negative amount", { ...valid, amount: -5 }],
        ["amount null", { ...valid, amount: null }], ["amount 1e308", { ...valid, amount: 1e308 }], ["amount as a list", { ...valid, amount: [5] }],
      );
      if ("date" in valid) cases.push(
        ["Feb 30", { ...valid, date: "2026-02-30" }], ["month 13", { ...valid, date: "2026-13-01" }],
        ["a date in words", { ...valid, date: "next tuesday" }], ["day zero", { ...valid, date: "2026-11-00" }],
      );
      if ("target" in valid) cases.push(["target \"lots\"", { ...valid, target: "lots" }]);
      const statuses: string[] = [];
      let worst = 0;
      for (const [what, body] of cases) {
        const r = await ctx.api("POST", door.path, body);
        statuses.push(`${what}:${r.status}`);
        if (r.status >= 500) worst = r.status;
        if (r.ok && door.allows?.includes(what)) {
          const id = r.data?.id ?? r.data?.note?.id;
          if (id) await ctx.api("DELETE", `${door.path}/${id}`);
        } else if (r.ok) {
          // accepted: undo it, and say so
          const id = r.data?.id ?? r.data?.note?.id;
          if (id) await ctx.api("DELETE", `${door.path}/${id}`);
          ctx.check("action", false, `${door.name}: ${what} is refused`, `accepted with ${r.status}: ${JSON.stringify(r.data).slice(0, 160)}`);
          ctx.finding({ severity: "bug", title: `${door.name}: ${what} is accepted`, detail: `POST /api${door.path} ${JSON.stringify(body).slice(0, 160)} → ${r.status}` });
        } else if (r.status >= 400 && r.status < 500 && !(typeof r.data?.error === "string" && r.data.error.length > 0)) {
          ctx.check("action", false, `${door.name}: ${what} is refused with a reason`, `${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
        }
      }
      ctx.check("action", worst === 0, `${door.name}: ${cases.length} invalid bodies, no server error`, statuses.join(" "));
      const after = await ctx.db.count(door.table, `${door.nameCol}=like.${ctx.tag}*&deleted_at=is.null`).catch(() => ctx.db.count(door.table, `${door.nameCol}=like.${ctx.tag}*`));
      ctx.check("db", after === before, `${door.name}: the refused requests stored nothing`, `${after - before} row(s) appeared`);
    }
    void bads;
  },
});

scenario({
  id: "hardening.unusual-text-round-trips",
  title: "Unusual text (emoji, right-to-left, markup, quotes, very long) is stored exactly or refused — never mangled, never run",
  area: "Input validation",
  covers: ["task.create.api", "expense.create.api", "note.create.api", "journal.create.api"],
  requires: ["action", "db"],
  run: async (ctx) => {
    const texts: Array<[string, string]> = [
      ["emoji and accents", `${ctx.tag} café ☕️ naïve 😀 日本語`],
      ["right-to-left", `${ctx.tag} שלום عالم`],
      ["quotes and backslashes", `${ctx.tag} "quoted" 'single' \\ back \`tick\``],
      ["sql-shaped", `${ctx.tag} '); DROP TABLE tasks;--`],
      ["template-shaped", `${ctx.tag} \${7*7} {{7*7}} %s`],
      ["leading and trailing spaces", `  ${ctx.tag} padded  `],
    ];
    for (const [what, text] of texts) {
      const r = await ctx.api("POST", "/tasks", { title: text });
      if (!r.ok) { ctx.check("action", r.status < 500, `task titled with ${what}: refused cleanly`, `${r.status}`); continue; }
      ctx.cleanup(() => ctx.api("DELETE", `/tasks/${r.data.id}`));
      const row = await ctx.db.row("tasks", r.data.id);
      ctx.check("db", row?.title === text || row?.title === text.trim(), `task titled with ${what}: stored as typed`, JSON.stringify(row?.title));
      ctx.check("action", r.data.title === row?.title, `task titled with ${what}: the answer equals the stored row`);
    }
    // markup must never come back as live markup
    const xss = `${ctx.tag} <img src=x onerror=alert(1)><script>alert(2)</script>`;
    for (const [door, body, table, col] of [
      ["/tasks", { title: xss }, "tasks", "title"],
      ["/expenses", { description: xss, amount: 1, category: "food", date: ctx.today }, "expenses", "description"],
      ["/notes", { title: `${ctx.tag} markup note`, content: xss }, "artifacts", "content"],
    ] as const) {
      const r = await ctx.api("POST", door, body);
      if (!r.ok) { ctx.check("action", r.status < 500, `${door} with script markup: refused cleanly`, `${r.status}`); continue; }
      const id = r.data.id ?? r.data.note?.id;
      ctx.cleanup(() => ctx.api("DELETE", `${door}/${id}`));
      const row = await ctx.db.row(table, id);
      const stored = String(row?.[col] ?? "");
      ctx.check("db", !/<script/i.test(stored) || stored === xss, `${door}: script markup is stored inert (stripped) or verbatim as text`, stored.slice(0, 120));
      ctx.step(`${door} stored: ${stored.slice(0, 100)}`);
    }
    // a title that is not text is never saved as the text of an object
    const odd = await ctx.api("POST", "/notes", { title: { $ne: null }, content: `${ctx.tag} body of an untitled note` });
    if (odd.ok) {
      const id = odd.data.id ?? odd.data.note?.id;
      ctx.cleanup(() => ctx.api("DELETE", `/notes/${id}`));
      const row = await ctx.db.row("artifacts", id);
      const ok = ctx.check("db", !!row?.title && !/\[object Object\]/.test(row.title), "a note sent with an object for a title is titled from its text", JSON.stringify(row?.title));
      if (!ok) ctx.finding({ severity: "bug", title: "A note's title can be saved as \"[object Object]\"", detail: `POST /api/notes {title: {…}} stored the title ${JSON.stringify(row?.title)}` });
    } else ctx.check("action", odd.status < 500, "a note with an object for a title: refused cleanly", `${odd.status}`);

    // a very long body is kept whole (W11: no silent cut)
    const long = `${ctx.tag} ` + "long entry. ".repeat(2500); // ~30,000 chars
    const j = await ctx.api("POST", "/journal", { date: ctx.today, content: long });
    if (j.ok) {
      const id = j.data.id ?? j.data.entry?.id;
      ctx.cleanup(() => ctx.api("DELETE", `/journal/${id}`));
      const row = await ctx.db.row("journal_entries", id);
      const ok = ctx.check("db", row?.content?.length === long.trim().length || row?.content?.length === long.length, `a ${long.length}-character journal entry is stored whole`, `stored ${row?.content?.length}`);
      if (!ok) ctx.finding({ severity: "bug", title: "A long journal entry is cut on save", detail: `sent ${long.length} characters, stored ${row?.content?.length}` });
    } else ctx.check("action", j.status < 500, "a 30,000-character journal entry: refused cleanly", `${j.status}`);
    const huge = await ctx.api("POST", "/tasks", { title: `${ctx.tag} ` + "x".repeat(200_000) });
    ctx.check("action", huge.status < 500, "a 200,000-character task title is stored or refused, not a server error", `${huge.status}`);
    if (huge.ok) ctx.cleanup(() => ctx.api("DELETE", `/tasks/${huge.data.id}`));
  },
});

scenario({
  id: "hardening.failed-edit-is-atomic",
  title: "An edit with one bad field changes nothing; an edit of a missing record creates nothing",
  area: "Failed and cancelled actions",
  covers: ["expense.edit.api", "task.edit.api", "event.edit.api", "asset.edit.api"],
  requires: ["action", "db"],
  run: async (ctx) => {
    const exp = must(await ctx.api("POST", "/expenses", { description: `${ctx.tag} lunch`, amount: 12.5, category: "food", date: ctx.today, tags: ["work"] }), "expense");
    ctx.cleanup(() => ctx.api("DELETE", `/expenses/${exp.id}`));
    const task = must(await ctx.api("POST", "/tasks", { title: `${ctx.tag} call`, dueDate: ctx.today, tags: ["a"] }), "task");
    ctx.cleanup(() => ctx.api("DELETE", `/tasks/${task.id}`));
    const ev = must(await ctx.api("POST", "/events", { title: `${ctx.tag} meet`, date: ctx.today, time: "09:00", location: "HQ" }), "event");
    ctx.cleanup(() => ctx.api("DELETE", `/events/${ev.id}`));
    const asset = must(await ctx.api("POST", "/profiles", { type: "asset", name: `${ctx.tag} Lens`, fields: { currentValue: 900, serial: "A1" } }), "asset");
    ctx.cleanup(() => ctx.api("DELETE", `/profiles/${asset.id}`));

    const strip = (r: any) => { const { updated_at, ...rest } = r; void updated_at; return JSON.stringify(rest); };
    const cases: Array<[string, string, string, any]> = [
      ["expense", "expenses", `/expenses/${exp.id}`, { description: `${ctx.tag} CHANGED`, amount: "abc" }],
      ["expense", "expenses", `/expenses/${exp.id}`, { description: `${ctx.tag} CHANGED`, date: "2026-02-31" }],
      ["task", "tasks", `/tasks/${task.id}`, { title: `${ctx.tag} CHANGED`, dueDate: "0002-11-2" }],
      ["task", "tasks", `/tasks/${task.id}`, { title: `${ctx.tag} CHANGED`, status: "finished-ish" }],
      ["event", "events", `/events/${ev.id}`, { title: `${ctx.tag} CHANGED`, date: "not-a-date" }],
      ["event", "events", `/events/${ev.id}`, { title: `${ctx.tag} CHANGED`, time: "25:61" }],
      ["asset", "profiles", `/profiles/${asset.id}`, { name: "", fields: { currentValue: 1 } }],
    ];
    const ids: Record<string, string> = { expenses: exp.id, tasks: task.id, events: ev.id, profiles: asset.id };
    for (const [what, table, path, body] of cases) {
      const before = strip(await ctx.db.row(table, ids[table]));
      const r = await ctx.api("PATCH", path, body);
      const after = strip(await ctx.db.row(table, ids[table]));
      ctx.check("action", r.status >= 400 && r.status < 500, `${what}: an edit carrying ${JSON.stringify(body).slice(0, 70)} is refused`, `${r.status}`);
      const ok = ctx.check("db", before === after, `${what}: the refused edit changed nothing in the row`, `before ${before.slice(0, 200)} / after ${after.slice(0, 200)}`);
      if (!ok) ctx.finding({ severity: "bug", title: `A refused ${what} edit partly applied`, detail: `PATCH /api${path} ${JSON.stringify(body)} → ${r.status}, yet the row changed` });
    }
    // unknown fields are ignored, not stored and not fatal
    const odd = await ctx.api("PATCH", `/tasks/${task.id}`, { priority: "low", user_id: "00000000-0000-4000-8000-000000000000", id: "00000000-0000-4000-8000-000000000001", deleted_at: "2020-01-01", __proto__: { admin: true } });
    const row = await ctx.db.row("tasks", task.id);
    ctx.check("db", row?.id === task.id && row.user_id === SMOKE_USER_ID && row.deleted_at == null, `an edit that also sends id / user_id / deleted_at (answer ${odd.status}) cannot move, re-own or delete the row`, JSON.stringify({ id: row?.id, u: row?.user_id, d: row?.deleted_at }));

    const NO = "00000000-0000-4000-8000-000000000000";
    for (const [path, table] of [[`/expenses/${NO}`, "expenses"], [`/tasks/${NO}`, "tasks"], [`/events/${NO}`, "events"], [`/profiles/${NO}`, "profiles"], [`/habits/${NO}`, "habits"], [`/goals/${NO}`, "goals"]] as const) {
      const r = await ctx.api("PATCH", path, { title: "ghost", name: "ghost", description: "ghost" });
      ctx.check("action", r.status === 404, `PATCH ${path.replace(NO, ":missing")} is a 404`, `${r.status}`);
      ctx.check("db", (await ctx.db.row(table, NO)) === null, `…and creates no ${table} row`);
    }
  },
});

scenario({
  id: "hardening.simultaneous-edits",
  title: "Two edits at the same moment to different fields of one record both land",
  area: "Concurrency",
  covers: ["asset.edit.api", "expense.edit.api", "task.edit.api", "note.edit.api"],
  requires: ["action", "db"],
  run: async (ctx) => {
    // columns of one row
    const exp = must(await ctx.api("POST", "/expenses", { description: `${ctx.tag} dinner`, amount: 40, category: "food", date: ctx.today }), "expense");
    ctx.cleanup(() => ctx.api("DELETE", `/expenses/${exp.id}`));
    const [a, b] = await Promise.all([ctx.api("PATCH", `/expenses/${exp.id}`, { amount: 41.5 }), ctx.api("PATCH", `/expenses/${exp.id}`, { description: `${ctx.tag} dinner with Sam` })]);
    ctx.check("action", a.ok && b.ok, "both expense edits are accepted", `${a.status}/${b.status}`);
    const eRow = await ctx.db.row("expenses", exp.id);
    ctx.check("db", Number(eRow.amount) === 41.5 && eRow.description === `${ctx.tag} dinner with Sam`, "the expense row holds both the new amount and the new description", JSON.stringify({ a: eRow.amount, d: eRow.description }));

    // keys of one JSON column: the classic lost update
    const asset = must(await ctx.api("POST", "/profiles", { type: "vehicle", name: `${ctx.tag} Van`, fields: { currentValue: 20000 } }), "asset");
    ctx.cleanup(() => ctx.api("DELETE", `/profiles/${asset.id}`));
    // four facts no alias joins (a key the app renames, like plate → licensePlate, would only test the renaming)
    const keys = ["color", "trimLevel", "tireSize", "garageSpot"];
    const vals: Record<string, any> = { color: "blue-7Q", trimLevel: "EX-L-7Q", tireSize: "235/60R18-7Q", garageSpot: "B14-7Q" };
    let lost = 0;
    for (let round = 0; round < 3; round++) {
      must(await ctx.api("PATCH", `/profiles/${asset.id}`, { fields: Object.fromEntries(keys.map((k) => [k, null])) }), "clear");
      const rs = await Promise.all(keys.map((k) => ctx.api("PATCH", `/profiles/${asset.id}`, { fields: { [k]: vals[k] } })));
      if (!rs.every((r) => r.ok)) ctx.check("action", false, "four simultaneous field edits are all accepted", rs.map((r) => r.status).join(","));
      const row = await ctx.db.row("profiles", asset.id);
      const flat = JSON.stringify(row.fields);
      const missing = keys.filter((k) => !flat.includes(JSON.stringify(vals[k])));
      if (missing.length) { lost++; ctx.step(`round ${round + 1}: every edit answered 200, but the row lacks ${missing.join(", ")}`); }
    }
    const okFields = ctx.check("db", lost === 0, "four simultaneous edits to four different fields of an asset: every field is stored (3 rounds)", `${lost} of 3 rounds lost at least one accepted edit`);
    if (!okFields) ctx.finding({ severity: "sync", title: "Simultaneous edits to different fields of one profile lose accepted writes", detail: `each PATCH answered 200, but in ${lost} of 3 rounds a field another request had just written was overwritten (read-modify-write of profiles.fields without a lock)` });
    const vRow = await ctx.db.row("profiles", asset.id);
    ctx.check("db", vRow.fields?.currentValue === 20000, "the value field nobody edited is intact", JSON.stringify(vRow.fields));

    // tags: two different additions
    const task = must(await ctx.api("POST", "/tasks", { title: `${ctx.tag} plan`, dueDate: O.addDays(ctx.today, 5) }), "task");
    ctx.cleanup(() => ctx.api("DELETE", `/tasks/${task.id}`));
    await ctx.api("POST", `/tasks/${task.id}/schedule`, { freq: "weekly" });
    const d1 = O.addDays(ctx.today, 12), d2 = O.addDays(ctx.today, 19);
    const [s1, s2] = await Promise.all([ctx.api("POST", `/tasks/${task.id}/occurrence`, { action: "skip", date: d1 }), ctx.api("POST", `/tasks/${task.id}/occurrence`, { action: "skip", date: d2 })]);
    const tRow = await ctx.db.row("tasks", task.id);
    const both = (tRow.tags || []).includes(`rskip:${d1}`) && (tRow.tags || []).includes(`rskip:${d2}`);
    const okTags = ctx.check("db", both, `two dates skipped at the same moment (answers ${s1.status}/${s2.status}) are both marked`, JSON.stringify(tRow.tags));
    if (!okTags) ctx.finding({ severity: "sync", title: "Two occurrence marks written at the same moment: one is lost", detail: `tags after both requests answered 2xx: ${JSON.stringify(tRow.tags)}` });
  },
});

scenario({
  id: "hardening.repeated-requests",
  title: "The same request sent many times at once makes one record where one is meant",
  area: "Concurrency",
  covers: ["habit.checkin.api", "bill.pay.api", "expense.delete.api", "bill.autopay.api", "artifact.share.api"],
  requires: ["action", "db"],
  run: async (ctx) => {
    const burst = (n: number, fn: () => Promise<any>) => Promise.all(Array.from({ length: n }, fn));
    // habit check-in ×5
    const habit = must(await ctx.api("POST", "/habits", { name: `${ctx.tag} water`, frequency: "daily" }), "habit");
    ctx.cleanup(() => ctx.api("DELETE", `/habits/${habit.id}`));
    const cs = await burst(5, () => ctx.api("POST", `/habits/${habit.id}/checkin`, {}));
    ctx.check("action", cs.every((r) => r.status < 500), "five simultaneous check-ins: no server error", cs.map((r) => r.status).join(","));
    const nCheck = await ctx.db.count("habit_checkins", `habit_id=eq.${habit.id}`);
    const okC = ctx.check("db", nCheck === 1, "one check-in row for today", `${nCheck} rows`);
    if (!okC) ctx.finding({ severity: "bug", title: "Simultaneous habit check-ins store more than one check-in for a day", detail: `${nCheck} rows after 5 simultaneous requests` });
    const h = listOf(must(await ctx.api("GET", "/habits"), "habits")).find((x: any) => x.id === habit.id);
    ctx.same("db", h?.currentStreak, 1, "and the streak reads 1");

    // pay one occurrence ×4
    const bill = must(await ctx.api("POST", "/profiles", { type: "liability", type_key: "utility", name: `${ctx.tag} Gas`, fields: { amount: 42, frequency: "monthly", dueDate: ctx.today } }), "bill");
    ctx.cleanup(() => ctx.api("DELETE", `/profiles/${bill.id}`));
    const ps = await burst(4, () => ctx.api("POST", `/liabilities/${bill.id}/occurrences/${ctx.today}/pay`, {}));
    ctx.check("action", ps.every((r) => r.status < 500), "four simultaneous payments of one occurrence: no server error", ps.map((r) => r.status).join(","));
    const nPay = await ctx.db.count("liability_payments", `liability_profile_id=eq.${bill.id}`);
    const okP = ctx.check("db", nPay === 1, "one payment row", `${nPay} rows`);
    if (!okP) ctx.finding({ severity: "bug", title: "Paying one bill occurrence from several requests at once records it more than once", detail: `${nPay} payment rows after 4 simultaneous requests` });
    const nExp = (await ctx.db.rows("expenses", `description=ilike.*${ctx.tag}*Gas*&deleted_at=is.null`)).length;
    const okE = ctx.check("db", nExp <= 1, "and at most one expense for it", `${nExp} expenses`);
    if (!okE) ctx.finding({ severity: "bug", title: "One bill payment logged as several expenses", detail: `${nExp} live expense rows` });

    // delete ×3
    const exp = must(await ctx.api("POST", "/expenses", { description: `${ctx.tag} once`, amount: 3, category: "food", date: ctx.today }), "expense");
    const ds = await burst(3, () => ctx.api("DELETE", `/expenses/${exp.id}`));
    ctx.check("action", ds.every((r) => r.status < 500) && ds.some((r) => r.ok), "three simultaneous deletes: no server error, at least one succeeds", ds.map((r) => r.status).join(","));
    ctx.check("db", gone(await ctx.db.row("expenses", exp.id)), "the expense is deleted");

    // share ×3 → one link
    const art = must(await ctx.api("POST", "/artifacts", { type: "checklist", title: `${ctx.tag} list`, items: [{ text: "a" }] }), "artifact");
    ctx.cleanup(() => ctx.api("DELETE", `/artifacts/${art.id}`));
    const ss = await burst(3, () => ctx.api("POST", `/artifacts/${art.id}/share`));
    const tokens = new Set(ss.filter((r) => r.ok).map((r) => r.data.token ?? r.data.url));
    ctx.check("action", ss.every((r) => r.status < 500), "three simultaneous share requests: no server error", ss.map((r) => r.status).join(","));
    const final = must(await ctx.api("POST", `/artifacts/${art.id}/share`), "share again");
    ctx.check("db", tokens.has(final.token ?? final.url), "asking again afterwards answers a link one of them was given (one live link)", `${tokens.size} distinct links handed out`);
  },
});

scenario({
  id: "hardening.interrupted-request",
  title: "A request cut off mid-flight leaves the record whole: fully applied or not at all, and a retry does not double it",
  area: "Network interruption",
  covers: ["expense.create.api", "liabilityPayment.create.api", "asset.edit.api"],
  requires: ["action", "db"],
  run: async (ctx) => {
    const token = await getSmokeToken();
    // The one place a request is made outside fetchWithRateLimitRetry: it has to be aborted.
    const cut = async (method: string, path: string, body: any, afterMs: number) => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), afterMs);
      try {
        const r = await globalThis.fetch(`${API_BASE}${path}`, { method, signal: ac.signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
        await r.text();
        ctx.step(`${method} /api${path} (cut after ${afterMs} ms) finished first → ${r.status}`);
        return "finished";
      } catch { ctx.step(`${method} /api${path} cut off after ${afterMs} ms`); return "cut"; } finally { clearTimeout(timer); }
    };
    const settle = () => new Promise((r) => setTimeout(r, 2500));

    // create: 0 or 1 rows, then the retry makes it exactly one
    for (const ms of [15, 60, 140, 300]) {
      const desc = `${ctx.tag} cut ${ms}`;
      await cut("POST", "/expenses", { description: desc, amount: 9.99, category: "food", date: ctx.today }, ms);
      await settle();
      const rows = await ctx.db.rows("expenses", `description=eq.${encodeURIComponent(desc)}`);
      for (const r of rows) ctx.cleanup(() => ctx.api("DELETE", `/expenses/${r.id}`));
      ctx.check("db", rows.length <= 1 && rows.every((r: any) => Number(r.amount) === 9.99 && r.category === "food" && r.date === ctx.today), `create cut at ${ms} ms: no row or one whole row`, `${rows.length} rows ${JSON.stringify(rows.map((r: any) => r.amount))}`);
    }

    // a loan payment: the ledger row and the balance move together or not at all
    const loan = must(await ctx.api("POST", "/profiles", { type: "liability", type_key: "personal_loan", name: `${ctx.tag} Cut Loan`, fields: { balance: 5000, monthlyPayment: 200, dueDay: 5, interestRate: 12, _interestRateUnit: "percent" } }), "loan");
    ctx.cleanup(() => ctx.api("DELETE", `/profiles/${loan.id}`));
    for (const ms of [40, 120, 260, 450]) {
      const before = (await ctx.db.row("profiles", loan.id)).fields.balance;
      const nBefore = await ctx.db.count("liability_payments", `liability_profile_id=eq.${loan.id}`);
      const amount = 100 + ms / 10; // distinct amounts, so nothing is folded as a double submit
      await cut("POST", `/liabilities/${loan.id}/payments`, { amount, paymentDate: ctx.today }, ms);
      await settle();
      const after = (await ctx.db.row("profiles", loan.id)).fields.balance;
      const rows = await ctx.db.rows("liability_payments", `liability_profile_id=eq.${loan.id}&order=created_at.asc`);
      const added = rows.length - nBefore;
      const moved = O.cents(before - after);
      const principal = added === 1 ? Number(rows[rows.length - 1].principal_portion) : 0;
      const ok = ctx.check("db", (added === 0 && moved === 0) || (added === 1 && Math.abs(moved - principal) < 0.005),
        `payment cut at ${ms} ms: ledger and balance agree (${added} row, balance moved ${moved})`, `rows +${added}, principal ${principal}, balance ${before} → ${after}`);
      if (!ok) ctx.finding({ severity: "bug", title: "An interrupted loan payment leaves the ledger and the balance disagreeing", detail: `cut at ${ms} ms: +${added} ledger row(s) with principal ${principal}, balance moved ${moved}` });
    }
    // afterwards the loan still takes a normal payment
    const fine = await ctx.api("POST", `/liabilities/${loan.id}/payments`, { amount: 33.33, paymentDate: ctx.today });
    ctx.check("action", fine.ok, "after the interruptions the loan accepts a normal payment", `${fine.status}`);
    // the books still add up at the end
    const rows = await ctx.db.rows("liability_payments", `liability_profile_id=eq.${loan.id}`);
    const paidPrincipal = O.cents(rows.reduce((s: number, r: any) => s + Number(r.principal_portion), 0));
    ctx.near("db", (await ctx.db.row("profiles", loan.id)).fields.balance, O.cents(5000 - paidPrincipal), "opening balance − every ledger row's principal = the stored balance");
  },
});

scenario({
  id: "hardening.account-isolation",
  title: "Another account cannot read, change or delete this account's records — through the app or the database",
  area: "Account isolation",
  covers: ["isolation.read", "isolation.write", "isolation.database"],
  requires: ["action", "db"],
  run: async (ctx) => {
    const made: Array<[string, string, string, any]> = [];
    const mk = async (name: string, path: string, table: string, body: any) => {
      const r = must(await ctx.api("POST", path, body), `create ${name}`);
      const id = r.id ?? r.note?.id ?? r.entry?.id;
      ctx.cleanup(() => ctx.api("DELETE", `${path}/${id}`));
      made.push([name, `${path}/${id}`, table, id]);
      return id;
    };
    await mk("expense", "/expenses", "expenses", { description: `${ctx.tag} private`, amount: 77, category: "food", date: ctx.today });
    await mk("task", "/tasks", "tasks", { title: `${ctx.tag} private` });
    await mk("event", "/events", "events", { title: `${ctx.tag} private`, date: ctx.today });
    await mk("habit", "/habits", "habits", { name: `${ctx.tag} private`, frequency: "daily" });
    await mk("goal", "/goals", "goals", { title: `${ctx.tag} private`, type: "custom", target: 5, unit: "x" });
    const assetId = await mk("asset", "/profiles", "profiles", { type: "asset", name: `${ctx.tag} private`, fields: { currentValue: 123 } });
    const loanId = await mk("loan", "/profiles", "profiles", { type: "liability", type_key: "personal_loan", name: `${ctx.tag} private loan`, fields: { balance: 900, monthlyPayment: 50, dueDay: 3 } });
    await mk("journal entry", "/journal", "journal_entries", { date: ctx.today, content: `${ctx.tag} private thoughts` });
    await mk("note", "/notes", "artifacts", { title: `${ctx.tag} private`, content: "secret" });
    const trackerId = await mk("tracker", "/trackers", "trackers", { name: `${ctx.tag} private`, category: "health", fields: [{ name: "value", type: "number" }] });
    await mk("document", "/documents", "documents", { name: `${ctx.tag} private`, type: "other", mimeType: "image/png", fileData: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" });

    ctx.check("action", made.length === 11, "eleven private records of eleven kinds exist to be reached for");
    const strip = (r: any) => { const { updated_at, ...rest } = r ?? {}; void updated_at; return JSON.stringify(rest); };
    for (const [name, path, table, id] of made) {
      const before = strip(await ctx.db.row(table, id));
      const get = await ctx.apiAsOther("GET", path);
      const leaked = get.ok && JSON.stringify(get.data).includes(ctx.tag);
      const patch = await ctx.apiAsOther("PATCH", path, { title: "TAKEN", name: "TAKEN", description: "TAKEN", content: "TAKEN", amount: 1 });
      const del = await ctx.apiAsOther("DELETE", path);
      const after = strip(await ctx.db.row(table, id));
      const ok = ctx.check("isolation", !leaked && !patch.ok && !del.ok, `${name}: the other account's GET / PATCH / DELETE are refused`, `${get.status}/${patch.status}/${del.status}`);
      const same = ctx.check("db", before === after, `${name}: the row is unchanged afterwards`);
      if (!ok || !same) ctx.finding({ severity: "bug", title: `Account isolation: another account reached a ${name}`, detail: `GET ${get.status} PATCH ${patch.status} DELETE ${del.status}; row changed: ${!same}` });
    }
    // nested doors: pay someone else's loan, log to their tracker, link to their asset
    const pay = await ctx.apiAsOther("POST", `/liabilities/${loanId}/payments`, { amount: 10, paymentDate: ctx.today });
    const log = await ctx.apiAsOther("POST", `/trackers/${trackerId}/entries`, { values: { value: 1 } });
    const detail = await ctx.apiAsOther("GET", `/profiles/${assetId}/detail`);
    const life = await ctx.apiAsOther("GET", "/assets/lifecycle");
    ctx.check("isolation", !pay.ok && !log.ok && !detail.ok, "the other account cannot pay this loan, log to this tracker or open this asset's page", `${pay.status}/${log.status}/${detail.status}`);
    ctx.check("isolation", !JSON.stringify(life.data).includes(assetId), "its lifecycle list does not include this account's asset");
    ctx.check("db", (await ctx.db.count("liability_payments", `liability_profile_id=eq.${loanId}`)) === 0 && (await ctx.db.count("tracker_entries", `tracker_id=eq.${trackerId}`)) === 0, "nothing was written by those attempts");
    for (const p of ["/profiles", "/expenses", "/tasks", "/events", "/habits", "/goals", "/journal", "/notes", "/trackers", "/documents", "/artifacts", "/obligations", "/dashboard-bootstrap", "/calendar/timeline", "/notifications", "/search?q=" + ctx.tag]) {
      const r = await ctx.apiAsOther("GET", p);
      ctx.check("isolation", !JSON.stringify(r.data).includes(ctx.tag), `the other account's ${p.split("?")[0]} shows none of this run's records`, `${r.status}`);
    }

    // the database itself (row-level security)
    const pg = async (q: string, bearer: string | null, init: any = {}) => {
      const { response } = await fetchWithRateLimitRetry(`${SB_URL}/rest/v1/${q}`, { ...init, headers: { apikey: SB_ANON, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers || {}) } });
      const text = await response.text();
      let data: any = text; try { data = JSON.parse(text); } catch { /* text */ }
      return { status: response.status, data };
    };
    const other = await getOtherToken();
    const mineTok = await getSmokeToken();
    const tables = ["profiles", "expenses", "tasks", "events", "habits", "habit_checkins", "goals", "journal_entries", "artifacts", "documents", "trackers", "tracker_entries", "liability_payments", "incomes", "preferences", "memories", "entity_links", "net_worth_snapshots", "asset_party_links", "liability_profile_links", "financial_accounts", "financial_transactions", "ai_action_log", "ai_chat_runs", "audit_log", "user_notifications", "captures", "chat_artifacts"];
    const leaks: string[] = [], anonLeaks: string[] = [], foreign: string[] = [];
    for (const tbl of tables) {
      const asOther = await pg(`${tbl}?select=user_id&user_id=eq.${SMOKE_USER_ID}&limit=1`, other);
      if (Array.isArray(asOther.data) && asOther.data.length) leaks.push(tbl);
      const anon = await pg(`${tbl}?select=user_id&limit=1`, null);
      if (Array.isArray(anon.data) && anon.data.length) anonLeaks.push(tbl);
      const mine = await pg(`${tbl}?select=user_id&user_id=neq.${SMOKE_USER_ID}&limit=1`, mineTok);
      if (Array.isArray(mine.data) && mine.data.length) foreign.push(tbl);
    }
    ctx.check("isolation", leaks.length === 0, `database: the other account reads none of this account's rows (${tables.length} tables)`, leaks.join(", "));
    ctx.check("isolation", anonLeaks.length === 0, "database: a signed-out reader reads no rows", anonLeaks.join(", "));
    ctx.check("isolation", foreign.length === 0, "database: this account reads nobody else's rows", foreign.join(", "));
    const [, , , taskId] = made.find((m) => m[0] === "task")!;
    const upd = await pg(`tasks?id=eq.${taskId}`, other, { method: "PATCH", body: JSON.stringify({ title: "TAKEN" }) });
    const delr = await pg(`tasks?id=eq.${taskId}`, other, { method: "DELETE" });
    const tRow = await ctx.db.row("tasks", taskId);
    ctx.check("db", tRow?.title === `${ctx.tag} private`, `database: the other account's direct UPDATE (${upd.status}) and DELETE (${delr.status}) touch nothing`, JSON.stringify(tRow?.title));
    const ins = await pg("tasks", other, { method: "POST", body: JSON.stringify({ user_id: SMOKE_USER_ID, title: `${ctx.tag} planted`, status: "todo", priority: "low" }) });
    const planted = await ctx.db.count("tasks", `title=eq.${encodeURIComponent(`${ctx.tag} planted`)}`);
    ctx.check("db", planted === 0, `database: the other account cannot insert a row owned by this account (answer ${ins.status})`, `${planted} planted`);
  },
});

scenario({
  id: "hardening.date-edges",
  title: "Month ends, the first and last day of a month, and a leap day land in the right month and on the right day",
  area: "Date boundaries",
  covers: ["expense.create.api", "bill.create.api", "task.create.api"],
  requires: ["action", "db", "derived"],
  run: async (ctx) => {
    const t = O.parseYmd(ctx.today);
    const month = ctx.today.slice(0, 7);
    const first = `${month}-01`;
    const last = O.fmtYmd({ y: t.y, m: t.m, d: O.daysInMonth(t.y, t.m) });
    const prevLast = O.addDays(first, -1);
    const nextFirst = O.addDays(last, 1);
    const snap0 = must(await ctx.api("GET", "/dashboard-enhanced"), "enhanced").financeSnapshot;
    const mk = async (date: string, amount: number) => {
      const e = must(await ctx.api("POST", "/expenses", { description: `${ctx.tag} edge ${date}`, amount, category: "food", date }), "expense");
      ctx.cleanup(() => ctx.api("DELETE", `/expenses/${e.id}`));
      return e.id as string;
    };
    const idFirst = await mk(first, 1.01);
    await mk(prevLast, 100);
    const future = last > ctx.today;
    if (future) await mk(last, 2.02);
    await mk(nextFirst, 1000);
    ctx.same("db", (await ctx.db.row("expenses", idFirst)).date, first, "an expense dated the 1st is stored on the 1st (no time-zone shift)");
    const snap1 = must(await ctx.api("GET", "/dashboard-enhanced"), "enhanced").financeSnapshot;
    // "spent this month" is money already spent: a row dated after today is scheduled, not spent
    ctx.near("derived", O.cents(snap1.totalMonthlySpend - snap0.totalMonthlySpend), 1.01, `this month's spending counts the 1st — not the day before, next month${future ? ", or a day that has not come yet" : ""}`);
    ctx.check("action", listOf(must(await ctx.api("GET", "/expenses"), "expenses")).filter((e: any) => String(e.description).startsWith(`${ctx.tag} edge`)).length === (future ? 4 : 3), "every edge-dated expense is in the expense list");
    ctx.near("derived", O.cents(snap1.lastMonthTotal - snap0.lastMonthTotal), 100, "last month's total counts its last day");

    // a bill on the 31st through February and a 30-day month
    const bill = must(await ctx.api("POST", "/profiles", { type: "liability", type_key: "utility", name: `${ctx.tag} Edge Bill`, fields: { amount: 10, frequency: "monthly", dueDate: "2027-01-31" } }), "bill");
    ctx.cleanup(() => ctx.api("DELETE", `/profiles/${bill.id}`));
    const got = listOf(must(await ctx.api("GET", "/calendar/timeline?start=2027-01-01&end=2027-06-30"), "timeline")).filter((i: any) => i.sourceId === bill.id).map((i: any) => i.date).sort();
    const wantDates = O.occurrencesBetween("2027-01-31", "monthly", "2027-01-01", "2027-06-30");
    const ok = ctx.same("derived", got, wantDates, "a bill due on the 31st: Feb 28, Mar 31, Apr 30, May 31, Jun 30");
    if (!ok) ctx.finding({ severity: "discrepancy", title: "A monthly bill due on the 31st drifts after a short month", detail: `calendar ${JSON.stringify(got)} vs ${JSON.stringify(wantDates)}` });

    // quarterly and yearly from a leap day
    const q = must(await ctx.api("POST", "/profiles", { type: "liability", type_key: "insurance", name: `${ctx.tag} Edge Quarterly`, fields: { amount: 10, frequency: "quarterly", dueDate: "2027-11-30" } }), "bill");
    ctx.cleanup(() => ctx.api("DELETE", `/profiles/${q.id}`));
    const gotQ = listOf(must(await ctx.api("GET", "/calendar/timeline?start=2027-11-01&end=2028-12-31"), "timeline")).filter((i: any) => i.sourceId === q.id).map((i: any) => i.date).sort();
    const wantQ = O.occurrencesBetween("2027-11-30", "quarterly", "2027-11-01", "2028-12-31");
    const okQ = ctx.same("derived", gotQ, wantQ, "a quarterly bill from Nov 30: Feb 29 in the leap year, then back to the 30th");
    if (!okQ) ctx.finding({ severity: "discrepancy", title: "A quarterly bill anchored on the 30th does not keep its day after February", detail: `calendar ${JSON.stringify(gotQ)} vs ${JSON.stringify(wantQ)}` });

    // a task due on New Year's Eve repeating weekly crosses the year
    const task = must(await ctx.api("POST", "/tasks", { title: `${ctx.tag} edge task`, dueDate: "2027-12-31" }), "task");
    ctx.cleanup(() => ctx.api("DELETE", `/tasks/${task.id}`));
    must(await ctx.api("POST", `/tasks/${task.id}/schedule`, { freq: "weekly" }), "weekly");
    const gotT = listOf(must(await ctx.api("GET", "/calendar/timeline?start=2027-12-25&end=2028-01-22"), "timeline")).filter((i: any) => i.sourceId === task.id).map((i: any) => i.date).sort();
    ctx.same("derived", gotT, O.occurrencesBetween("2027-12-31", "weekly", "2027-12-25", "2028-01-22"), "a weekly task from Dec 31 continues on Jan 7, 14, 21");
  },
});
