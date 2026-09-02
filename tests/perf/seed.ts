// Seeds a representative dataset into the local harness for user $USER (default u1).
const BASE = process.env.API_BASE || "http://localhost:5000/api";
const USER = process.env.USER_ID || "u1";
const SCALE = parseFloat(process.env.SCALE || "1");
const today = new Date(); const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };
let writes = 0; const failures: string[] = [];
async function api(method: string, path: string, body?: any) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", "x-local-user": USER, "x-seed": "1" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data: any = text; try { data = JSON.parse(text); } catch {}
  if (method !== "GET") writes++;
  if (!r.ok) { failures.push(`${method} ${path} ${r.status} ${text.slice(0, 160)}`); return null; }
  return data;
}
async function batch<T>(items: T[], fn: (t: T) => Promise<any>, conc = 8) { const out: any[] = []; for (let i = 0; i < items.length; i += conc) out.push(...await Promise.all(items.slice(i, i + conc).map(fn))); return out; }
const N = (n: number) => Math.max(1, Math.round(n * SCALE));
const t0 = Date.now();
await api("DELETE", "/data/all", { confirmation: "DELETE" });
// Profiles
const self = await api("POST", "/profiles", { type: "self", name: "Alex Self", fields: { dateOfBirth: "1990-04-12", email: "alex@example.com" } });
const bob = await api("POST", "/profiles", { type: "person", name: "Bob Partner", fields: { dateOfBirth: "1988-09-30", relationship: "spouse" } });
const casey = await api("POST", "/profiles", { type: "person", name: "Casey Kid", fields: { dateOfBirth: "2018-02-14", relationship: "child" } });
const pet = await api("POST", "/profiles", { type: "pet", name: "Biscuit", fields: { species: "dog", breed: "beagle", dateOfBirth: "2021-06-01" } });
const car = await api("POST", "/profiles", { type: "vehicle", name: "Family Car", fields: { currentValue: 25000, make: "Toyota", model: "RAV4", year: 2022, mileage: 31000, registrationExpiry: iso(daysAgo(-40)) } });
const home = await api("POST", "/profiles", { type: "property", name: "Home", fields: { currentValue: 520000, address: "123 Main St", purchasePrice: 450000 } });
const mortgage = await api("POST", "/profiles", { type: "loan", name: "Mortgage", fields: { currentBalance: 350000, interestRate: 6.5, monthlyPayment: 2200, lender: "Big Bank" } });
const carLoan = await api("POST", "/profiles", { type: "loan", name: "Car Loan", fields: { currentBalance: 12000, interestRate: 4.9, monthlyPayment: 380 } });
const checking = await api("POST", "/accounts", { name: "Checking", accountKind: "checking", balance: 5200, institution: "Big Bank" });
const savings = await api("POST", "/accounts", { name: "Savings", accountKind: "savings", balance: 18000, institution: "Big Bank" });
const invest = await api("POST", "/profiles", { type: "investment", name: "Brokerage", fields: { currentValue: 42000 } });
// Trackers
const trackerSpecs = [
  { name: "Weight", category: "health", unit: "lbs", fields: [{ name: "value", type: "number", unit: "lbs", isPrimary: true }], n: 60, gen: (i: number) => ({ value: +(182 - i * 0.05 + Math.sin(i) * 1.2).toFixed(1) }) },
  { name: "Running", category: "fitness", unit: "miles", fields: [{ name: "distance", type: "number", unit: "miles", isPrimary: true }, { name: "duration", type: "duration", unit: "min" }], n: 40, gen: (i: number) => ({ distance: +(2 + (i % 5)).toFixed(1), duration: 20 + (i % 5) * 9 }) },
  { name: "Water", category: "health", unit: "oz", fields: [{ name: "value", type: "number", unit: "oz", isPrimary: true }], n: 30, gen: (i: number) => ({ value: 48 + (i % 4) * 8 }) },
  { name: "Sleep", category: "health", unit: "hours", fields: [{ name: "value", type: "number", unit: "hours", isPrimary: true }], n: 30, gen: (i: number) => ({ value: +(6.5 + (i % 3) * 0.5).toFixed(1) }) },
  { name: "Blood Pressure", category: "health", unit: "mmHg", fields: [{ name: "systolic", type: "number", unit: "mmHg", isPrimary: true }, { name: "diastolic", type: "number", unit: "mmHg" }], n: 20, gen: (i: number) => ({ systolic: 118 + (i % 6), diastolic: 76 + (i % 4) }) },
  { name: "Steps", category: "fitness", unit: "steps", fields: [{ name: "value", type: "number", unit: "steps", isPrimary: true }], n: 45, gen: (i: number) => ({ value: 4000 + (i * 137) % 7000 }) },
];
const trackers: any[] = [];
for (const s of trackerSpecs) {
  const t = await api("POST", "/trackers", { name: s.name, category: s.category, unit: s.unit, fields: s.fields });
  if (!t) continue; trackers.push(t);
  const n = N(s.n);
  await batch(Array.from({ length: n }, (_, i) => i), i => api("POST", `/trackers/${t.id}/entries`, { values: s.gen(i), timestamp: daysAgo(n - i).toISOString() }));
}
// Bob's running tracker
const bobRun = bob && await api("POST", "/trackers", { name: "Running", category: "fitness", unit: "miles", linkedProfiles: [bob.id], fields: [{ name: "distance", type: "number", unit: "miles", isPrimary: true }] });
if (bobRun && bob) { await api("POST", `/profiles/${bob.id}/link`, { entityType: "tracker", entityId: bobRun.id }); await batch([1,2,3,4,5,6,7,8], i => api("POST", `/trackers/${bobRun.id}/entries`, { values: { distance: 3 + (i % 3) }, timestamp: daysAgo(i * 2).toISOString() })); }
// Pet weight
const petW = pet && await api("POST", "/trackers", { name: "Weight", category: "health", unit: "lbs", linkedProfiles: [pet.id], fields: [{ name: "value", type: "number", unit: "lbs", isPrimary: true }] });
if (petW && pet) { await api("POST", `/profiles/${pet.id}/link`, { entityType: "tracker", entityId: petW.id }); await batch([1,2,3,4], i => api("POST", `/trackers/${petW.id}/entries`, { values: { value: 24 + i * 0.2 }, timestamp: daysAgo(i * 7).toISOString() })); }
// Tasks
const prios = ["low", "medium", "high"] as const;
await batch(Array.from({ length: N(40) }, (_, i) => i), i => api("POST", "/tasks", { title: `Task ${i + 1}: ${["Call dentist", "Renew insurance", "Fix fence", "Buy groceries", "Plan trip", "Pay tuition", "Clean garage", "Book vet"][i % 8]}`, priority: prios[i % 3], status: i % 5 === 0 ? "done" : "todo", dueDate: iso(daysAgo(10 - (i % 25))), dueTime: i % 4 === 0 ? "09:00" : undefined, linkedProfiles: i % 6 === 0 && bob ? [bob.id] : i % 7 === 0 && casey ? [casey.id] : [] }));
// Habits + checkins
const habitSpecs = [{ name: "Meditate", frequency: "daily" }, { name: "Run", frequency: "daily", linkedTrackerId: trackers[1]?.id }, { name: "Read 20 min", frequency: "daily" }, { name: "Gym", frequency: "weekly", targetDays: [1, 3, 5] }, { name: "Call Mom", frequency: "weekly", targetDays: [0] }, { name: "Drink water", frequency: "daily", targetPerDay: 3 }];
const habits: any[] = [];
for (const h of habitSpecs) { const created = await api("POST", "/habits", { ...h }); if (created) habits.push(created); }
for (const h of habits.slice(0, 3)) await batch(Array.from({ length: N(30) }, (_, i) => i + 1).filter(i => i % 3 !== 0), i => api("POST", `/habits/${h.id}/checkin`, { date: iso(daysAgo(i)) }), 4);
// Expenses
const cats = ["food", "transport", "utilities", "entertainment", "health", "shopping", "housing", "general"];
await batch(Array.from({ length: N(300) }, (_, i) => i), i => api("POST", "/expenses", { amount: +(5 + ((i * 37) % 180) + (i % 7) * 3.25).toFixed(2), category: cats[i % cats.length], description: `${["Grocery run", "Gas", "Electric bill", "Movie night", "Pharmacy", "Amazon", "Rent", "Misc"][i % 8]} #${i}`, vendor: ["Costco", "Shell", "PG&E", "AMC", "CVS", "Amazon", "Landlord", "Target"][i % 8], date: iso(daysAgo(i % 180)), linkedProfiles: i % 9 === 0 && bob ? [bob.id] : i % 11 === 0 && car ? [car.id] : [] }));
// Incomes
await batch(Array.from({ length: 6 }, (_, i) => i), i => api("POST", "/incomes", { description: "Salary", amount: 6200, category: "salary", frequency: "monthly", date: iso(daysAgo(i * 30 + 1)) }));
await api("POST", "/incomes", { description: "Freelance", amount: 900, category: "freelance", frequency: "once", date: iso(daysAgo(12)) });
// Events
const evCats = ["personal", "work", "health", "family", "social", "travel"] as const;
await batch(Array.from({ length: N(30) }, (_, i) => i), i => api("POST", "/events", { title: `${["Dentist", "Team sync", "Soccer game", "Dinner with Sam", "Flight to NYC", "Vet visit"][i % 6]} ${i}`, date: iso(daysAgo(30 - i * 2)), time: i % 3 === 0 ? "14:00" : "09:30", category: evCats[i % 6], linkedProfiles: i % 6 === 2 && casey ? [casey.id] : i % 6 === 5 && pet ? [pet.id] : [] }));
await api("POST", "/events", { title: "Weekly standup", date: iso(daysAgo(60)), time: "10:00", category: "work", recurrence: "weekly" });
await api("POST", "/events", { title: "Pay day", date: iso(daysAgo(14)), allDay: true, category: "finance", recurrence: "biweekly" });
// Obligations / bills
const bills = [{ name: "Internet", amount: 75, category: "utilities" }, { name: "Netflix", amount: 18.99, category: "entertainment", kind: "subscription" }, { name: "Gym membership", amount: 45, category: "health", kind: "subscription" }, { name: "Electric", amount: 140, category: "utilities", billingModel: "variable" }, { name: "Car insurance", amount: 130, category: "insurance" }, { name: "Phone", amount: 85, category: "utilities" }];
await batch(bills.map((b, i) => ({ ...b, i })), b => api("POST", "/obligations", { name: b.name, amount: b.amount, category: b.category, kind: (b as any).kind || "bill", frequency: "monthly", nextDueDate: iso(daysAgo(-(3 + b.i * 4))), billingModel: (b as any).billingModel }));
// Goals
await api("POST", "/goals", { title: "Emergency fund", type: "savings", target: 25000, unit: "$", startValue: 18000, deadline: iso(daysAgo(-180)) });
if (trackers[1]) await api("POST", "/goals", { title: "Run 100 miles", type: "fitness_distance", target: 100, unit: "miles", trackerId: trackers[1].id, deadline: iso(daysAgo(-60)) });
if (trackers[0]) await api("POST", "/goals", { title: "Get to 175", type: "weight_loss", target: 175, unit: "lbs", startValue: 182, trackerId: trackers[0].id });
// Journal
const moods = ["amazing", "great", "good", "okay", "neutral", "bad"] as const;
await batch(Array.from({ length: N(20) }, (_, i) => i), i => api("POST", "/journal", { date: iso(daysAgo(i)), mood: moods[i % 6], content: `Day ${i}: went for a run, worked on the deck, dinner with family. Feeling ${moods[i % 6]}.`, energy: 1 + (i % 5), tags: i % 2 ? ["family"] : ["work"] }));
// Artifacts / notes
await api("POST", "/artifacts", { type: "checklist", title: "Packing list", items: [{ text: "Passport", checked: true }, { text: "Charger", checked: false }, { text: "Hiking boots", checked: false }] });
await api("POST", "/artifacts", { type: "note", title: "Gate code", content: "Gate code is 4321. Wifi: homenet / password123" });
await api("POST", "/artifacts", { type: "markdown", title: "Deck plan", content: "# Deck\n\n- 12x16\n- composite boards\n- **budget** $8k" });
await api("POST", "/artifacts", { type: "checklist", title: "Weekly chores", items: [{ text: "Vacuum", checked: false }, { text: "Laundry", checked: false }] });
await api("POST", "/memories", { key: "workout preference", value: "Alex prefers morning workouts", category: "preference" });
// Budgets
await api("POST", "/budgets", { category: "food", amount: 600, month: iso(today).slice(0, 7) });
await api("POST", "/budgets", { category: "transport", amount: 250, month: iso(today).slice(0, 7) });
console.log(`seeded user ${USER}: ${writes} writes in ${Date.now() - t0}ms, ${failures.length} failures`);
for (const f of [...new Set(failures.map(f => f.replace(/\d+/g, "N")))].slice(0, 25)) console.log("  FAIL", f);
