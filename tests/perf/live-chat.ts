// Live AI chat probe against portol.me with the smoke account. Measures time to
// first byte (SSE ack), total time, and verifies the records the turn claims.
import fs from "fs";
const TOKEN = fs.readFileSync(process.env.TOKEN_FILE!, "utf8").trim();
const BASE = "https://portol.me/api";
const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "X-Timezone": "America/Los_Angeles" };
const api = async (method: string, path: string, body?: any) => { const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: t }; } };
async function chat(message: string, history: any[] = []) {
  const t0 = Date.now(); let tFirst = 0, tFinal = 0; let final: any = null; const events: string[] = [];
  const r = await fetch(BASE + "/chat", { method: "POST", headers: { ...H, Accept: "text/event-stream" }, body: JSON.stringify({ message, history }) });
  const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = "";
  while (true) { const { value, done } = await reader.read(); if (done) break; if (!tFirst) tFirst = Date.now() - t0; buf += dec.decode(value, { stream: true });
    let idx; while ((idx = buf.indexOf("\n\n")) >= 0) { const frame = buf.slice(0, idx); buf = buf.slice(idx + 2); const ev = frame.match(/^event: (.*)$/m)?.[1]; const data = frame.match(/^data: (.*)$/m)?.[1]; if (ev) events.push(`${ev}@${Date.now() - t0}`); if (ev === "final" && data) { final = JSON.parse(data); tFinal = Date.now() - t0; } } }
  const total = Date.now() - t0;
  const acts = (final?.actions || []).map((a: any) => `${a.type || a.kind || a.action}:${a.status || ""}`).join(",");
  console.log(`CHAT "${message.slice(0, 70)}" → ttfb ${tFirst}ms, final ${tFinal || total}ms, total ${total}ms | frames: ${events.slice(0, 8).join(" ")}${events.length > 8 ? " …" : ""}\n   reply: ${(final?.reply || final?.message || final?.text || JSON.stringify(final)).toString().slice(0, 200).replace(/\n/g, " ")}\n   actions: ${acts}`);
  return { final, history: [...history, { role: "user", content: message }, { role: "assistant", content: final?.reply || final?.message || "" }] };
}
const stamp = Date.now().toString().slice(-5);
let h: any[] = [];
({ history: h } = await chat(`Add 2 miles to my running tracker`));
({ history: h } = await chat(`I ran 3 miles today and Smoke Spouse ran 4 miles, log both to the right running trackers`, h));
({ history: h } = await chat(`Create a task "Probe ${stamp} call plumber" due tomorrow, high priority`, h));
({ history: h } = await chat(`actually make it medium priority`, h));
({ history: h } = await chat(`How much did I spend on food this month?`, h));
({ history: h } = await chat(`spent $12.34 on coffee at Blue Bottle this morning`, h));
({ history: h } = await chat(`delete the probe ${stamp} plumber task`, h));
// verify
const tasks = (await api("GET", "/tasks")).data as any[]; console.log("VERIFY task remains:", Array.isArray(tasks) && tasks.some(t => new RegExp(`Probe ${stamp}`).test(t.title)));
const exp = (await api("GET", "/expenses?limit=20")).data as any[]; const coffee = Array.isArray(exp) ? exp.filter(e => /Blue Bottle|coffee/i.test(`${e.description} ${e.vendor}`)).slice(0, 3) : []; console.log("VERIFY coffee expenses:", coffee.map(e => `${e.amount} ${e.description} ${e.date}`).join(" | "));
const trackers = (await api("GET", "/trackers")).data as any[]; for (const t of (trackers || []).filter((t: any) => /run/i.test(t.name))) { const last = t.entries?.slice(-2) || []; console.log(`VERIFY tracker ${t.name} [${(t.linkedProfiles || []).length} owners] entries=${t.entries?.length} last=${last.map((e: any) => JSON.stringify(e.values)).join(",")}`); }
// cleanup
for (const e of coffee) await api("DELETE", `/expenses/${e.id}`);
for (const t of (tasks || []).filter((t: any) => new RegExp(`Probe ${stamp}`).test(t.title))) await api("DELETE", `/tasks/${t.id}`);
console.log("CHAT_DONE");
