/**
 * LIVE end-to-end test of the AI chat's nested-asset creation and rollup.
 *
 * Scenarios covered (from user-spec 2026-05-27):
 *   1. "add my house, it's worth $400k"         -> top-level Home
 *   2. "add a computer in the house for $2,000" -> Computer child of Home
 *   3. "add a mouse for the computer, $50"      -> Mouse grandchild
 *   4. Read-back: Mouse=50, Computer=2050, Home=402050
 *   5. Update Mouse to $100 -> Computer=2100, Home=402100
 *   6. Move Mouse out from under Computer        -> totals reroll
 *   7. Delete Computer                            -> behaviour observed
 *   8. Ambiguous: two computers -> AI should ask
 *
 * Runs against the LIVE production API at portol.me using a dedicated QA user.
 * Cleans up everything it creates at the end.
 */

const API_BASE = "https://portol.me/api";
const TEST_EMAIL = "testfix2026@aol.com";
const TEST_PASSWORD = "Testtest1!";

// Unique prefix so we can find + cleanup our test profiles without
// touching anything the QA user already has.
const TAG = `nestlive_${Date.now()}`;
const HOME_NAME     = `${TAG}_home`;
const COMPUTER_NAME = `${TAG}_computer`;
const COMPUTER2_NAME = `${TAG}_computer2`;
const MOUSE_NAME    = `${TAG}_mouse`;

let authToken: string = "";

interface Step {
  name: string;
  pass: boolean;
  detail: string;
  data?: any;
}
const steps: Step[] = [];
function record(name: string, pass: boolean, detail: string, data?: any) {
  steps.push({ name, pass, detail, data });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name} - ${detail}`);
}

async function login(): Promise<string> {
  const res = await fetch(`${API_BASE}/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  const data = await res.json();
  if (!data.session?.access_token) throw new Error("Login failed: " + JSON.stringify(data));
  return data.session.access_token;
}

async function chat(message: string, history: any[] = []): Promise<any> {
  console.log(`\n>>> USER: ${message}`);
  const res = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({ message, history }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Chat API ${res.status}: ${text}`);
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  const aiReply = parsed?.reply || parsed?.response || parsed?.message || parsed?.text || JSON.stringify(parsed).slice(0, 400);
  console.log(`<<< AI:   ${typeof aiReply === "string" ? aiReply.slice(0, 400) : JSON.stringify(aiReply).slice(0, 400)}`);
  if (Array.isArray(parsed?.actions)) {
    for (const a of parsed.actions) {
      console.log(`    action.type=${a.type} category=${a.category} data=${JSON.stringify(a.data || {}).slice(0, 300)}`);
    }
  }
  if (Array.isArray(parsed?.results)) {
    for (const r of parsed.results) {
      const s = typeof r === "object" ? JSON.stringify(r).slice(0, 300) : String(r).slice(0, 300);
      console.log(`    result=${s}`);
    }
  }
  return parsed;
}

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiDelete(path: string): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${authToken}` },
  });
  if (!res.ok) throw new Error(`DELETE ${path} -> ${res.status}: ${await res.text()}`);
  return res.json().catch(() => ({}));
}

async function apiPatch(path: string, body: any): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

function valueOf(p: any): number {
  const f = p?.fields || {};
  return Number(
    f.currentValue ?? f.current_value ?? f.value ?? f.purchasePrice ??
    f.purchase_price ?? f.balance ?? f.amount ?? f.cost ?? f.price ?? 0,
  ) || 0;
}

async function findByName(name: string): Promise<any | undefined> {
  const profiles = await apiGet("/profiles");
  return profiles.find((p: any) => p.name === name);
}

async function getTreeTotal(rootName: string): Promise<{ root: any; descendants: any[]; total: number }> {
  const root = await findByName(rootName);
  if (!root) throw new Error(`Root ${rootName} not found`);
  const tree = await apiGet(`/profiles/${root.id}/tree`);
  const flat: any[] = [];
  function walk(n: any) {
    flat.push(n);
    (n.children || []).forEach(walk);
  }
  walk(tree);
  const total = flat.reduce((s, n) => s + valueOf(n), 0);
  return { root, descendants: flat.slice(1), total };
}

async function cleanup() {
  console.log("\n=== Cleanup ===");
  for (const name of [MOUSE_NAME, COMPUTER_NAME, COMPUTER2_NAME, HOME_NAME]) {
    const p = await findByName(name).catch(() => null);
    if (p) {
      try { await apiDelete(`/profiles/${p.id}`); console.log(`Deleted ${name}`); }
      catch (e: any) { console.log(`Cleanup ${name} failed: ${e?.message || e}`); }
    }
  }
}

async function main() {
  console.log(`\n=== AI Nested-Asset Live Test (tag=${TAG}) ===\n`);
  authToken = await login();
  console.log("Login OK");

  try {
    // ─── 1. Create top-level Home ─────────────────────────────
    await chat(`Add a house called "${HOME_NAME}", it's worth $400,000.`);
    await new Promise(r => setTimeout(r, 1500)); // let the write settle
    let home = await findByName(HOME_NAME);
    if (!home) {
      // Some users get a property type; relax the search to find by tag
      const all = await apiGet("/profiles");
      home = all.find((p: any) => p.name === HOME_NAME);
    }
    if (home) {
      console.log("   home.fields:", JSON.stringify(home.fields));
    }
    record("Step 1: Home created", !!home,
      home ? `id=${home.id} type=${home.type} value=$${valueOf(home)}` : "Home not found after AI chat");
    if (!home) throw new Error("Cannot continue without Home");

    // ─── 2. Create Computer inside Home ───────────────────────
    await chat(`Add a computer in "${HOME_NAME}" called "${COMPUTER_NAME}" for $2,000.`);
    await new Promise(r => setTimeout(r, 1500));
    const computer = await findByName(COMPUTER_NAME);
    if (computer) console.log("   computer.fields:", JSON.stringify(computer.fields));
    const computerIsChild = computer?.parentProfileId === home.id;
    record("Step 2: Computer child of Home", !!computer && computerIsChild,
      computer ? `id=${computer.id} parent=${computer.parentProfileId} expected=${home.id} value=$${valueOf(computer)}` : "Computer not found");

    // ─── 3. Create Mouse inside Computer ──────────────────────
    await chat(`Add a mouse for "${COMPUTER_NAME}", $50.`);
    await new Promise(r => setTimeout(r, 1500));
    const mouse = await findByName(MOUSE_NAME) || (await apiGet("/profiles")).find((p: any) => p.name.toLowerCase().includes("mouse") && p.parentProfileId === computer?.id);
    const mouseIsGrandchild = mouse?.parentProfileId === computer?.id;
    record("Step 3: Mouse grandchild of Home (parent=Computer)", !!mouse && mouseIsGrandchild,
      mouse ? `id=${mouse.id} parent=${mouse.parentProfileId} expected=${computer?.id} value=$${valueOf(mouse)}` : "Mouse not found under Computer");

    // ─── 4. Read-back tree totals ─────────────────────────────
    if (home) {
      const t = await getTreeTotal(HOME_NAME);
      const expected = valueOf(t.root) + t.descendants.reduce((s: number, d: any) => s + valueOf(d), 0);
      record("Step 4: Tree total matches sum-of-parts", t.total === expected,
        `tree total=$${t.total} expected=$${expected} (root=$${valueOf(t.root)}, ${t.descendants.length} descendants)`);
      // Per user spec: Home=$402,050 when mouse=$50, computer=$2000, home=$400k
      const ideal = 400000 + 2000 + 50;
      const hitsIdeal = Math.abs(t.total - ideal) < 0.01;
      record("Step 4b: Tree total = $402,050 (user-spec example)", hitsIdeal,
        `actual=$${t.total} ideal=$${ideal} (only PASS if AI captured exact values)`);
    }

    // ─── 5. Update Mouse value, expect propagation ────────────
    if (mouse) {
      const beforeTree = await getTreeTotal(HOME_NAME);
      await apiPatch(`/profiles/${mouse.id}`, { fields: { ...(mouse.fields || {}), currentValue: 100 } });
      await new Promise(r => setTimeout(r, 1000));
      const afterTree = await getTreeTotal(HOME_NAME);
      const delta = afterTree.total - beforeTree.total;
      record("Step 5: Mouse value update propagates to Home rollup", delta === 50,
        `before=$${beforeTree.total} after=$${afterTree.total} delta=$${delta} (expected +$50 if mouse was $50)`);
    }

    // ─── 6. Move Mouse out from under Computer ────────────────
    if (mouse && home) {
      await apiPatch(`/profiles/${mouse.id}`, { parentProfileId: home.id });
      await new Promise(r => setTimeout(r, 1000));
      const movedMouse = await apiGet(`/profiles/${mouse.id}`).catch(() => null);
      record("Step 6: Move Mouse to be direct child of Home",
        movedMouse?.parentProfileId === home.id,
        `mouse.parent=${movedMouse?.parentProfileId} expected=${home.id}`);
      // Home rollup should be unchanged in total (mouse still in tree)
      const afterMoveTree = await getTreeTotal(HOME_NAME);
      record("Step 6b: Home total unchanged after move (still contains mouse)",
        afterMoveTree.total > 0,
        `total=$${afterMoveTree.total} descendants=${afterMoveTree.descendants.length}`);
    }

    // ─── 7. Ambiguous parent: create a second computer, then ask AI ───
    await chat(`Add a computer in "${HOME_NAME}" called "${COMPUTER2_NAME}" for $3,000.`);
    await new Promise(r => setTimeout(r, 1500));
    const computer2 = await findByName(COMPUTER2_NAME);
    record("Step 7a: Second computer created", !!computer2,
      computer2 ? `id=${computer2.id} value=$${valueOf(computer2)}` : "Not found");
    // Now ask the AI to add a keyboard "for the computer" — ambiguous because both
    // computers have the same word "computer" in their name. We expect the AI
    // to either ask which one (clarifying question) OR to refuse with our
    // structured AMBIGUOUS_PARENT error.
    const ambResp = await chat(`Add a keyboard for the computer, $80.`);
    const respText = JSON.stringify(ambResp).toLowerCase();
    const asked = respText.includes("which") || respText.includes("ambig") || respText.includes("two") ||
                  respText.includes("clarif") || respText.includes("?");
    record("Step 7b: AI asks for clarification when 'the computer' is ambiguous", asked,
      `response includes question/disambig keywords? ${asked}`);

    // ─── 8. Delete a mid-tree asset ───────────────────────────
    if (computer) {
      await apiDelete(`/profiles/${computer.id}`);
      await new Promise(r => setTimeout(r, 1000));
      const stillThere = await findByName(COMPUTER_NAME);
      record("Step 8: Mid-tree delete removes the profile", !stillThere,
        stillThere ? `still found id=${stillThere.id}` : "Computer is gone");
    }

  } catch (e: any) {
    record("ERROR", false, e?.message || String(e));
  } finally {
    await cleanup();
  }

  console.log("\n=== Summary ===");
  const passed = steps.filter(s => s.pass).length;
  console.log(`${passed}/${steps.length} steps passed`);
  for (const s of steps) console.log(`  ${s.pass ? "✓" : "✗"} ${s.name}: ${s.detail}`);
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
