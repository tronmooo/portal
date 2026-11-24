// Live check (production, smoke account): unusual things typed into the forms.
//
// The workflow checks type ordinary values. A person also pastes a page of
// text, uses emoji and other alphabets, leaves the optional boxes empty,
// types "1,234.56", a date that does not exist, a time like 24:00, or the same
// thing twice. Owner, 2026-11-24: "different combinations … manually to add".
//
// Each value goes through the same route its form posts to. A value the app
// can hold must come back EXACTLY as typed, from the list a screen reads; a
// value it cannot hold must be refused with a reason (a 4xx with `error`),
// never a 500 and never stored as something else.
//   npx tsx tests/live-input-variations-check.ts
import { api } from "./smoke/fixture/api";
import { detail, list, refused, runWorkflowCheck } from "./helpers/live-workflow";

const LONG = `${"The quick brown fox jumps over the lazy dog. ".repeat(260)}END-OF-TEXT`; // ~11,700 characters
const TEXTS: Array<[string, string]> = [
  ["emoji", "Dinner 🍜 with 👨‍👩‍👧 at Café Zoë"],
  ["other alphabets", "買い物 — Обед — غداء — Δείπνο"],
  ["quotes and symbols", `He said "it's 50% off" & paid <$20> (really!) #deal @home`],
  ["markup typed as text", `<b>bold</b> <script>alert(1)</script> {{template}} \${money}`],
  ["a single character", "x"],
  ["line breaks", "first line\nsecond line\n\nfourth line"],
];

runWorkflowCheck("live-input-variations-check", async ({ tag, check, call, cleanup, section }) => {
  const today: string = (await call("POST", "/autopay/run")).data?.today;
  const year = Number(today.slice(0, 4));
  /** The row with this id in a list, read fresh. */
  const inList = async (path: string, id: string) => list((await call("GET", path)).data).find((r) => r.id === id);
  /** Typed markup is kept as words (the page shows it as text) and no script survives. */
  const safeText = (stored: string, _typed: string) => !/<script/i.test(stored) && !/alert\(1\)/.test(stored) && stored.includes("bold") && stored.includes("{{template}}") && stored.includes("${money}");

  // ── Text: what is typed is what is kept ─────────────────────────────────
  section("text in a task title, an expense description and a note");
  for (const [label, text] of TEXTS) {
    const title = `${tag} ${text}`;
    const t = await call("POST", "/tasks", { title });
    if (t.data?.id) cleanup(() => api("DELETE", `/tasks/${t.data.id}`));
    const storedTask = t.data?.id ? (await inList("/tasks", t.data.id))?.title : undefined;
    const markup = label === "markup typed as text";
    check(t.ok && (markup ? safeText(String(storedTask), title) : storedTask === title.replace(/\n/g, " ").trim() || storedTask === title),
      `task title, ${label}: ${t.ok ? `kept as ${JSON.stringify(String(storedTask).slice(0, 70))}` : detail(t)}`);

    const e = await call("POST", "/expenses", { description: title, amount: 1.23, category: "general", date: today, allowDuplicate: true });
    if (e.data?.id) cleanup(() => api("DELETE", `/expenses/${e.data.id}`));
    const storedExp = e.data?.id ? (await inList("/expenses", e.data.id))?.description : undefined;
    check(e.ok && (markup ? safeText(String(storedExp), title) : String(storedExp).replace(/\s+/g, " ") === title.replace(/\s+/g, " ")),
      `expense description, ${label}: ${e.ok ? `kept as ${JSON.stringify(String(storedExp).slice(0, 70))}` : detail(e)}`);

    const n = await call("POST", "/notes", { title: `${tag} note ${label}`, content: text });
    const noteId = n.data?.id ?? n.data?.note?.id;
    if (noteId) cleanup(() => api("DELETE", `/notes/${noteId}`));
    const storedNote = noteId ? (await inList("/notes", noteId))?.content : undefined;
    check(n.ok && (markup ? safeText(String(storedNote), text) : storedNote === text),
      `note text, ${label}: ${n.ok ? `kept as ${JSON.stringify(String(storedNote).slice(0, 70))}` : detail(n)}`);
  }

  section("a long text is kept whole");
  const longNote = await call("POST", "/notes", { title: `${tag} long note`, content: LONG });
  const longNoteId = longNote.data?.id ?? longNote.data?.note?.id;
  if (longNoteId) cleanup(() => api("DELETE", `/notes/${longNoteId}`));
  const keptNote = longNoteId ? String((await inList("/notes", longNoteId))?.content ?? "") : "";
  check(longNote.ok && keptNote.length === LONG.length && keptNote.endsWith("END-OF-TEXT"), `a ${LONG.length}-character note: ${keptNote.length} characters kept, ending intact: ${keptNote.endsWith("END-OF-TEXT")}`);
  const longJ = await call("POST", "/journal", { date: today, content: `${tag} ${LONG}` });
  const longJId = longJ.data?.id ?? longJ.data?.entry?.id;
  if (longJId) cleanup(() => api("DELETE", `/journal/${longJId}`));
  const keptJ = longJId ? String((await inList("/journal", longJId))?.content ?? "") : "";
  check(longJ.ok && keptJ.endsWith("END-OF-TEXT") && keptJ.length >= LONG.length, `a ${LONG.length}-character journal entry: ${keptJ.length} characters kept, ending intact: ${keptJ.endsWith("END-OF-TEXT")}`);
  const longTask = await call("POST", "/tasks", { title: `${tag} ${"very long title ".repeat(40)}`.trim() });
  if (longTask.data?.id) cleanup(() => api("DELETE", `/tasks/${longTask.data.id}`));
  check(longTask.ok || refused(longTask), `a 650-character task title is kept or refused with a reason (${longTask.status}${longTask.ok ? `, ${String(longTask.data?.title).length} characters kept` : ""})`);
  if (longTask.ok) check(String(longTask.data?.title).length >= 600, `… and when kept, it is not silently cut short (${String(longTask.data?.title).length} of 650 characters)`);

  section("blank and whitespace");
  for (const [what, path, body] of [
    ["a task titled with spaces only", "/tasks", { title: "    " }],
    ["an expense with a blank description", "/expenses", { description: "   ", amount: 5, date: today }],
    ["an event with no title", "/events", { title: "", date: today }],
    ["a habit named with spaces only", "/habits", { name: "   " }],
    ["a goal with no title", "/goals", { title: "  ", type: "custom", target: 5, unit: "x" }],
    ["a note with nothing in it", "/notes", { title: "", content: "" }],
    ["a journal entry with nothing in it", "/journal", { date: today, content: "   " }],
  ] as Array<[string, string, any]>) {
    const r = await call("POST", path, body);
    const id = r.data?.id ?? r.data?.note?.id ?? r.data?.entry?.id;
    if (id) cleanup(() => api("DELETE", `${path}/${id}`));
    check(refused(r), `${what} is refused with a reason (${detail(r)})`);
  }
  const spaced = await call("POST", "/tasks", { title: `   ${tag} padded title   ` });
  if (spaced.data?.id) cleanup(() => api("DELETE", `/tasks/${spaced.data.id}`));
  check(spaced.ok && spaced.data?.title === `${tag} padded title`, `spaces around a title are trimmed (${JSON.stringify(spaced.data?.title)})`);

  // ── Money ───────────────────────────────────────────────────────────────
  section("amounts");
  const amountCase = async (typed: unknown, want: number | "refused", why: string) => {
    const r = await call("POST", "/expenses", { description: `${tag} amount ${String(typed)}`, amount: typed, category: "general", date: today, allowDuplicate: true });
    if (r.data?.id) cleanup(() => api("DELETE", `/expenses/${r.data.id}`));
    if (want === "refused") return check(refused(r), `an expense of ${JSON.stringify(typed)} (${why}) is refused with a reason (${detail(r)})`);
    const stored = r.data?.id ? Number((await inList("/expenses", r.data.id))?.amount) : NaN;
    // The amount box sends a number. Text that reads as an amount ("12.50",
    // "1,234.56", "$25") may be understood or refused with a reason — what it
    // may never be is stored as some other figure.
    if (typeof typed === "string") return check(r.ok ? Math.abs(stored - want) < 0.0005 : refused(r), `an expense of ${JSON.stringify(typed)} (${why}) is stored as ${want} or refused with a reason, never as another figure (${r.ok ? stored : detail(r)})`);
    check(r.ok && Math.abs(stored - want) < 0.0005, `an expense of ${JSON.stringify(typed)} (${why}) is stored as ${want} (${r.ok ? stored : detail(r)})`);
  };
  await amountCase(0.01, 0.01, "one cent");
  await amountCase("12.50", 12.5, "typed as text");
  await amountCase("1,234.56", 1234.56, "with a thousands comma");
  await amountCase(999999.99, 999999.99, "large");
  await amountCase(19.999, "refused", "three decimals");
  await amountCase(0, "refused", "zero");
  await amountCase(-5, "refused", "negative");
  await amountCase("abc", "refused", "not a number");
  await amountCase("", "refused", "empty");
  await amountCase(null, "refused", "missing");
  await amountCase(1e15, "refused", "absurdly large");
  await amountCase("$25", 25, "with a currency sign");

  // ── Dates and times ─────────────────────────────────────────────────────
  section("dates and times");
  const leap = year % 4 === 0 ? year : year + (4 - (year % 4));
  const dateCase = async (date: unknown, ok: boolean, why: string) => {
    const r = await call("POST", "/events", { title: `${tag} date ${String(date)}`, date });
    if (r.data?.id) cleanup(() => api("DELETE", `/events/${r.data.id}`));
    if (!ok) return check(refused(r), `an event dated ${JSON.stringify(date)} (${why}) is refused with a reason (${detail(r)})`);
    const stored = r.data?.id ? String((await inList("/events", r.data.id))?.date).slice(0, 10) : "";
    check(r.ok && stored === date, `an event dated ${JSON.stringify(date)} (${why}) is kept on that day (${r.ok ? stored : detail(r)})`);
  };
  await dateCase(`${leap}-02-29`, true, "a real leap day");
  await dateCase(`${leap + 1}-02-29`, false, "not a leap year");
  await dateCase(`${year}-02-30`, false, "no such day");
  await dateCase(`${year}-13-01`, false, "no such month");
  await dateCase("0002-11-25", false, "a half-typed year");
  await dateCase("11/25/2026", false, "not YYYY-MM-DD");
  await dateCase("tomorrow", false, "a word");
  await dateCase(`${year + 30}-01-01`, true, "thirty years out");
  await dateCase(`${year}-12-31`, true, "the last day of the year");
  const timeCase = async (time: string, ok: boolean) => {
    const r = await call("POST", "/events", { title: `${tag} time ${time}`, date: today, time });
    if (r.data?.id) cleanup(() => api("DELETE", `/events/${r.data.id}`));
    check(ok ? r.ok && r.data?.time === time : refused(r), `an event at ${JSON.stringify(time)} is ${ok ? "kept" : "refused with a reason"} (${ok && r.ok ? r.data?.time : detail(r)})`);
  };
  await timeCase("00:00", true);
  await timeCase("23:59", true);
  await timeCase("24:00", false);
  await timeCase("9:5", false);
  await timeCase("3pm", false);
  const dueCase = async (dueDate: unknown, ok: boolean, why: string) => {
    const r = await call("POST", "/tasks", { title: `${tag} due ${String(dueDate)}`, dueDate });
    if (r.data?.id) cleanup(() => api("DELETE", `/tasks/${r.data.id}`));
    check(ok ? r.ok && String(r.data?.dueDate).slice(0, 10) === dueDate : refused(r), `a task due ${JSON.stringify(dueDate)} (${why}) is ${ok ? "kept on that day" : "refused with a reason"} (${ok && r.ok ? r.data?.dueDate : detail(r)})`);
  };
  await dueCase(`${year}-02-30`, false, "no such day");
  await dueCase("0002-11-25", false, "a half-typed year");
  await dueCase(today, true, "today");

  // ── The same thing twice ────────────────────────────────────────────────
  section("the same thing entered twice");
  const twiceBody = { description: `${tag} same lunch`, amount: 18.25, category: "food", date: today };
  const first = await call("POST", "/expenses", twiceBody);
  if (first.data?.id) cleanup(() => api("DELETE", `/expenses/${first.data.id}`));
  const second = await call("POST", "/expenses", twiceBody);
  if (second.data?.id && second.data.id !== first.data?.id) cleanup(() => api("DELETE", `/expenses/${second.data.id}`));
  const sameLunch = list((await call("GET", "/expenses")).data).filter((e) => e.description === twiceBody.description);
  check(first.ok && sameLunch.length === 1, `the same expense posted twice is ONE expense unless the user says so (${sameLunch.length}; second answer ${second.status} ${second.data?.code || ""})`);
  const forced = await call("POST", "/expenses", { ...twiceBody, allowDuplicate: true });
  if (forced.data?.id) cleanup(() => api("DELETE", `/expenses/${forced.data.id}`));
  check(forced.ok && list((await call("GET", "/expenses")).data).filter((e) => e.description === twiceBody.description).length === 2, `… and "yes, it really is a second one" adds it (${forced.status})`);
  const h1 = await call("POST", "/habits", { name: `${tag} Stretch` });
  if (h1.data?.id) cleanup(() => api("DELETE", `/habits/${h1.data.id}`));
  const h2 = await call("POST", "/habits", { name: `${tag} stretch` });
  if (h2.data?.id && h2.data.id !== h1.data?.id) cleanup(() => api("DELETE", `/habits/${h2.data.id}`));
  const sameHabits = list((await call("GET", "/habits")).data).filter((h) => String(h.name).toLowerCase() === `${tag} stretch`.toLowerCase());
  check(sameHabits.length === 1, `a habit named the same but for its capitals is ONE habit (${sameHabits.length}; second answer ${h2.status})`);

  // ── Things that are not what the field holds ────────────────────────────
  section("the wrong kind of value");
  for (const [what, path, body] of [
    ["a task whose title is a number", "/tasks", { title: 12345 }],
    ["a task whose title is a list", "/tasks", { title: ["a", "b"] }],
    ["an expense whose tags are text, not a list", "/expenses", { description: `${tag} tags`, amount: 5, date: today, tags: "food" }],
    ["an event whose owner list is text", "/events", { title: `${tag} owners`, date: today, linkedProfiles: "me" }],
    ["a goal whose target is a word", "/goals", { title: `${tag} goal`, type: "custom", target: "ten", unit: "x" }],
    ["a habit done eleven times a day", "/habits", { name: `${tag} eleven`, targetPerDay: 11 }],
    ["a task with an unknown priority", "/tasks", { title: `${tag} priority`, priority: "whenever" }],
  ] as Array<[string, string, any]>) {
    const r = await call("POST", path, body);
    const id = r.data?.id;
    if (id) cleanup(() => api("DELETE", `${path}/${id}`));
    check(refused(r), `${what} is refused with a reason (${detail(r)})`);
  }
  const noBody = await call("POST", "/tasks");
  check(refused(noBody), `a request with nothing in it is refused with a reason (${detail(noBody)})`);
});
