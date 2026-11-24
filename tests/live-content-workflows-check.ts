// Live check (production, smoke account) for content workflows no test drove
// before the workflow matrix (docs/WORKFLOW_MATRIX.md, 2026-11-24):
//
//   document  save one that expires soon → listed, alert raised → rename
//             (its dates kept) → delete → restore → purge → gone for good
//   tracker   create → the same name again is the same tracker (Rule 11) →
//             log → edit an entry → delete the entry → delete the tracker
//   event     create → edit → skip one date of a weekly series (O1) → delete
//   note      create → edit → delete
//   journal   two entries on one day stay two (J1) → edit one → delete both
//
// Every write is read back from the list a screen reads; a bad input is a 4xx
// with a reason. Takes the gate lock and removes what it creates.
//   npx tsx tests/live-content-workflows-check.ts
import { api } from "./smoke/fixture/api";
import { NO_SUCH_ID, detail, list, refused, runWorkflowCheck } from "./helpers/live-workflow";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

runWorkflowCheck("live-content-workflows-check", async ({ tag, check, call, cleanup, section }) => {
  const today: string = (await call("POST", "/autopay/run")).data?.today;
  check(/^\d{4}-\d{2}-\d{2}$/.test(String(today)), `the server says today is ${today}`);

  // ── Document ────────────────────────────────────────────────────────────
  section("document");
  const expires = addDays(today, 10);
  const doc = await call("POST", "/documents", {
    name: `${tag} Gym Membership`, type: "membership", mimeType: "image/png", fileData: PNG,
    extractedData: { expirationDate: expires, memberNumber: "M-4471" },
  });
  check(doc.ok && !!doc.data?.id, `save a document that expires ${expires} (${detail(doc)})`);
  const docId: string = doc.data?.id;
  if (docId) {
    cleanup(() => api("POST", `/documents/${docId}/purge`));
    const inList = () => call("GET", "/documents").then((r) => list(r.data).find((d) => d.id === docId));
    const alerts = async () => list((await call("GET", "/notifications")).data).filter((n) => JSON.stringify(n).includes(`${tag} Gym Membership`));
    check(!!(await inList()), "it is in the documents list");
    check(!JSON.stringify(await inList()).includes(PNG), "the list does not carry the file's bytes");
    check((await alerts()).length >= 1, `an alert about its expiry is raised (${(await alerts()).length})`);
    const renamed = await call("PATCH", `/documents/${docId}`, { name: `${tag} Gym Membership 2027` });
    const one = (await call("GET", `/documents/${docId}`)).data;
    check(renamed.ok && one?.name === `${tag} Gym Membership 2027`, `rename → the document shows the new name (${renamed.status})`);
    check(one?.extractedData?.expirationDate === expires && one?.extractedData?.memberNumber === "M-4471", "a rename left its extracted dates and fields alone");
    check(refused(await call("PATCH", `/documents/${docId}`, { name: "" })), "a blank name is refused");
    const impact = await call("GET", `/documents/${docId}/delete-impact`);
    check(impact.ok && typeof impact.data === "object", `"what would deleting this remove" answers (${impact.status})`);

    const del = await call("DELETE", `/documents/${docId}`);
    check(del.ok && !(await inList()), `delete → gone from the list (${del.status})`);
    const stillAlerting = list((await call("GET", "/notifications")).data).filter((n) => JSON.stringify(n).includes(`${tag} Gym Membership`));
    check(stillAlerting.length === 0, `its expiry alert went with it (${stillAlerting.length} left)`);
    const restore = await call("POST", `/documents/${docId}/restore`);
    const back = await inList();
    check(restore.ok && back?.name === `${tag} Gym Membership 2027`, `restore → back in the list under its name (${detail(restore)})`);
    const purge = await call("POST", `/documents/${docId}/purge`);
    check(purge.ok && !(await inList()), `purge → gone (${purge.status})`);
    check((await call("POST", `/documents/${docId}/restore`)).status === 404, "a purged document cannot be restored");
    check((await call("GET", `/documents/${docId}`)).status === 404, "… and is a 404 by id");
  }
  check(refused(await call("POST", "/documents", { type: "other", mimeType: "image/png", fileData: PNG })), "a document with no name is refused");
  // Any file may be attached; what is refused is a type a browser would RUN when the file is opened.
  const html = await call("POST", "/documents", { name: `${tag} page`, type: "other", mimeType: "text/html", fileData: PNG });
  if (html.data?.id) cleanup(() => api("POST", `/documents/${html.data.id}/purge`));
  check(html.status === 415, `a web page as a document is refused (${html.status})`);
  check(refused(await call("POST", "/documents", { name: `${tag} bad date`, type: "other", mimeType: "image/png", fileData: PNG, extractedData: { expirationDate: "2026-02-31" } })), "a document dated Feb 31 is refused");
  check((await call("POST", `/documents/${NO_SUCH_ID}/restore`)).status === 404, "restoring a document that does not exist is a 404");

  // ── Tracker ─────────────────────────────────────────────────────────────
  section("tracker");
  const tr = await call("POST", "/trackers", { name: `${tag} Pushups`, category: "fitness", fields: [{ name: "reps", type: "number", isPrimary: true }] });
  check(tr.ok && !!tr.data?.id, `create a tracker (${detail(tr)})`);
  const trId: string = tr.data?.id;
  if (trId) {
    cleanup(() => api("DELETE", `/trackers/${trId}`));
    const named = async () => list((await call("GET", "/trackers")).data).filter((t) => String(t.name).toLowerCase() === `${tag} pushups`.toLowerCase());
    const twin = await call("POST", "/trackers", { name: `${tag} Pushups`, category: "fitness", fields: [{ name: "reps", type: "number", isPrimary: true }] });
    if (twin.data?.id && twin.data.id !== trId) cleanup(() => api("DELETE", `/trackers/${twin.data.id}`));
    check((await named()).length === 1, `creating the same tracker again leaves ONE "${tag} Pushups" (${(await named()).length}; second call ${twin.status})`);
    const entries = async () => ((await call("GET", `/trackers/${trId}`)).data?.entries || []) as any[];
    const log = await call("POST", `/trackers/${trId}/entries`, { values: { reps: 20 } });
    const entryId = log.data?.id;
    check(log.status === 201 && !!entryId && (await entries()).some((e) => e.id === entryId && Number(e.values?.reps) === 20), `log 20 reps → it is on the tracker (${log.status})`);
    const edit = await call("PATCH", `/trackers/${trId}/entries/${entryId}`, { values: { reps: 25 } });
    check(edit.ok && Number((await entries()).find((e) => e.id === entryId)?.values?.reps) === 25, `edit the entry → 25 reps (${edit.status})`);
    check(refused(await call("POST", `/trackers/${trId}/entries`, {})), "an entry with no values is refused");
    check(refused(await call("POST", `/trackers/${trId}/entries`, { values: { reps: 20 }, timestamp: "not a time" })), "an entry with a junk time is refused");
    const delEntry = await call("DELETE", `/trackers/${trId}/entries/${entryId}`);
    check(delEntry.ok && !(await entries()).some((e) => e.id === entryId), `delete the entry → gone (${delEntry.status})`);
    check((await call("POST", `/trackers/${NO_SUCH_ID}/entries`, { values: { reps: 1 } })).status === 404, "logging to a tracker that does not exist is a 404");
    const del = await call("DELETE", `/trackers/${trId}`);
    check(del.ok && (await named()).length === 0, `delete the tracker → gone from the list (${del.status})`);
  }
  check(refused(await call("POST", "/trackers", { category: "fitness" })), "a tracker with no name is refused");

  // ── Event ───────────────────────────────────────────────────────────────
  section("event");
  const start = addDays(today, 7);
  const ev = await call("POST", "/events", { title: `${tag} Yoga class`, date: start, time: "18:00", recurrence: "weekly" });
  check(ev.ok && !!ev.data?.id, `create a weekly event (${detail(ev)})`);
  const evId: string = ev.data?.id;
  if (evId) {
    cleanup(() => api("DELETE", `/events/${evId}`));
    const inList = () => call("GET", "/events").then((r) => list(r.data).find((e) => e.id === evId));
    check((await inList())?.time === "18:00", "it is in the events list at 18:00");
    const patched = await call("PATCH", `/events/${evId}`, { location: "Studio B" });
    const after = await inList();
    check(patched.ok && after?.location === "Studio B" && after?.title === `${tag} Yoga class` && after?.recurrence === "weekly", `add a location → saved; title and repeat kept (${patched.status})`);
    check(refused(await call("PATCH", `/events/${evId}`, { date: "2026-02-31" })), "moving it to Feb 31 is refused");
    const second = addDays(start, 7);
    const third = addDays(start, 14);
    const skip = await call("POST", `/events/${evId}/occurrence`, { date: second, state: "skip" });
    check(skip.ok && (skip.data?.tags || []).some((t: string) => t.includes(second)), `skip ${second} → the series carries a mark for that date (${skip.status}, tags ${JSON.stringify(skip.data?.tags)})`);
    check(refused(await call("POST", `/events/${evId}/occurrence`, { date: second, state: "maybe" })), "an occurrence state of \"maybe\" is refused");
    const tl = await call("GET", `/calendar/timeline?start=${start}&end=${addDays(start, 21)}`);
    const mine = JSON.stringify(tl.data);
    check(tl.ok && mine.includes(`${tag} Yoga class`), `the calendar shows the series (${tl.status})`);
    const stored = await inList();
    check(stored?.date === start && stored?.recurrence === "weekly", `the series still starts ${start} and repeats weekly (skipping deleted nothing; ${third} stays)`);
    const del = await call("DELETE", `/events/${evId}`);
    check(del.ok && !(await inList()), `delete → gone from the list (${del.status})`);
  }
  check(refused(await call("POST", "/events", { title: `${tag} bad`, date: "next tuesday" })), "an event dated \"next tuesday\" is refused");
  check(refused(await call("POST", "/events", { date: today })), "an event with no title is refused");

  // ── Note ────────────────────────────────────────────────────────────────
  section("note");
  const note = await call("POST", "/notes", { title: `${tag} Paint colours`, content: "- [ ] Hallway: Swiss Coffee\n- [x] Door: Hale Navy" });
  const noteId: string = note.data?.id ?? note.data?.note?.id;
  check(note.ok && !!noteId, `create a note (${detail(note)})`);
  if (noteId) {
    cleanup(() => api("DELETE", `/notes/${noteId}`));
    const inList = () => call("GET", "/notes").then((r) => list(r.data).find((n) => n.id === noteId));
    check(String((await inList())?.content).includes("- [x] Door: Hale Navy"), "it is in the notes list with its check list as markdown");
    const patched = await call("PATCH", `/notes/${noteId}`, { content: "- [x] Hallway: Swiss Coffee\n- [x] Door: Hale Navy" });
    const after = await inList();
    check(patched.ok && String(after?.content).startsWith("- [x] Hallway") && after?.title === `${tag} Paint colours`, `edit the text → saved, title kept (${patched.status})`);
    const del = await call("DELETE", `/notes/${noteId}`);
    check(del.ok && !(await inList()), `delete → gone from the list (${del.status})`);
  }

  // ── Journal ─────────────────────────────────────────────────────────────
  section("journal");
  const j1 = await call("POST", "/journal", { date: today, content: `${tag} Morning: slept well and felt rested.`, mood: "good" });
  const j2 = await call("POST", "/journal", { date: today, content: `${tag} Evening: long day, a bit frustrated with the commute.` });
  const id1: string = j1.data?.id ?? j1.data?.entry?.id;
  const id2: string = j2.data?.id ?? j2.data?.entry?.id;
  check(j1.ok && j2.ok && !!id1 && !!id2 && id1 !== id2, `two entries on the same day are two entries (${j1.status}, ${j2.status})`);
  if (id1) cleanup(() => api("DELETE", `/journal/${id1}`));
  if (id2 && id2 !== id1) cleanup(() => api("DELETE", `/journal/${id2}`));
  const mineJ = async () => list((await call("GET", "/journal")).data).filter((e) => String(e.content).includes(tag));
  const both = await mineJ();
  check(both.length === 2, `both are in the journal (${both.length})`);
  check(both.every((e) => typeof e.title === "string" && e.title.trim().length > 0), `each has a title (${both.map((e) => JSON.stringify(e.title)).join(", ")})`);
  if (id2) {
    const patched = await call("PATCH", `/journal/${id2}`, { content: `${tag} Evening: long day, but the walk home helped.` });
    const after = await mineJ();
    check(patched.ok && after.find((e) => e.id === id2)?.content?.includes("walk home"), `edit the second → saved (${patched.status})`);
    check(after.find((e) => e.id === id1)?.content?.includes("slept well"), "the first entry is untouched");
  }
  for (const id of [id1, id2]) if (id) await call("DELETE", `/journal/${id}`);
  check((await mineJ()).length === 0, "delete both → gone from the journal");
  check(refused(await call("POST", "/journal", { date: "yesterday-ish", content: `${tag} x` })), "an entry dated \"yesterday-ish\" is refused");
});
