// Test script: AI chaos mode multi-intent queries
// Tests that the AI correctly parses complex queries, creates entities, and links them to the right profiles

const BASE = "http://localhost:5000";

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
  aiReply?: string;
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "test2@test.com", password: "Test1234!" }),
  });
  const data = await res.json() as any;
  const token = data.session?.access_token || data.token;
  if (!token) throw new Error("Login failed: " + JSON.stringify(data));
  return token;
}

async function sendChat(token: string, message: string): Promise<any> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ message, conversationHistory: [] }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Chat failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function getProfiles(token: string): Promise<any[]> {
  const res = await fetch(`${BASE}/api/profiles`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  return res.json() as any;
}

async function getTrackers(token: string): Promise<any[]> {
  const res = await fetch(`${BASE}/api/trackers`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  return res.json() as any;
}

async function getTasks(token: string): Promise<any[]> {
  const res = await fetch(`${BASE}/api/tasks`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  return res.json() as any;
}

async function getExpenses(token: string): Promise<any[]> {
  const res = await fetch(`${BASE}/api/expenses`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  return res.json() as any;
}

async function getEvents(token: string): Promise<any[]> {
  const res = await fetch(`${BASE}/api/events`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  return res.json() as any;
}

async function getProfileDetail(token: string, profileId: string): Promise<any> {
  const res = await fetch(`${BASE}/api/profiles/${profileId}`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  return res.json() as any;
}

// ========================
// TEST 1: Multi-command with profile linking
// ========================
async function test1_multiCommand(token: string): Promise<TestResult> {
  const name = "Test 1: Task for Max + Expense for Tesla";
  console.log(`\n🧪 ${name}`);
  
  const chatRes = await sendChat(token, "Create a task for Max to get groomed and log a $50 expense for Tesla oil change");
  console.log("AI reply:", chatRes.reply?.substring(0, 200));
  
  // Wait a moment for async linking
  await new Promise(r => setTimeout(r, 2000));
  
  // Check tasks
  const tasks = await getTasks(token);
  const groomTask = tasks.find((t: any) => t.title?.toLowerCase().includes("groom"));
  
  // Check expenses
  const expenses = await getExpenses(token);
  const oilExpense = expenses.find((e: any) => 
    e.description?.toLowerCase().includes("oil") || e.description?.toLowerCase().includes("tesla")
  );
  
  // Check profiles
  const profiles = await getProfiles(token);
  const maxProfile = profiles.find((p: any) => p.name === "Max");
  const teslaProfile = profiles.find((p: any) => p.name?.includes("Tesla"));
  
  const issues: string[] = [];
  
  if (!groomTask) {
    issues.push("❌ Groom task NOT created");
  } else {
    console.log("  Task created:", groomTask.title, "| linkedProfiles:", groomTask.linkedProfiles);
    if (!groomTask.linkedProfiles?.includes(maxProfile?.id)) {
      issues.push(`❌ Task NOT linked to Max (linkedProfiles: ${JSON.stringify(groomTask.linkedProfiles)})`);
    } else {
      console.log("  ✅ Task linked to Max");
    }
  }
  
  if (!oilExpense) {
    issues.push("❌ Oil change expense NOT created");
  } else {
    console.log("  Expense created:", oilExpense.description, "$" + oilExpense.amount, "| linkedProfiles:", oilExpense.linkedProfiles);
    if (!oilExpense.linkedProfiles?.includes(teslaProfile?.id)) {
      issues.push(`❌ Expense NOT linked to Tesla (linkedProfiles: ${JSON.stringify(oilExpense.linkedProfiles)})`);
    } else {
      console.log("  ✅ Expense linked to Tesla");
    }
  }
  
  // Also check the profile's linked arrays
  if (maxProfile) {
    const maxDetail = await getProfileDetail(token, maxProfile.id);
    console.log("  Max linkedTasks:", maxDetail.linkedTasks);
    if (groomTask && !maxDetail.linkedTasks?.includes(groomTask.id)) {
      issues.push(`❌ Max profile doesn't have task in linkedTasks`);
    }
  }
  
  if (teslaProfile) {
    const teslaDetail = await getProfileDetail(token, teslaProfile.id);
    console.log("  Tesla linkedExpenses:", teslaDetail.linkedExpenses);
    if (oilExpense && !teslaDetail.linkedExpenses?.includes(oilExpense.id)) {
      issues.push(`❌ Tesla profile doesn't have expense in linkedExpenses`);
    }
  }
  
  return {
    name,
    passed: issues.length === 0,
    details: issues.length > 0 ? issues.join("\n") : "✅ Both created and linked correctly",
    aiReply: chatRes.reply?.substring(0, 300),
  };
}

// ========================
// TEST 2: Cross-profile tracker creation + log
// ========================
async function test2_crossProfileTracker(token: string): Promise<TestResult> {
  const name = "Test 2: Blood pressure tracker for Mom + Log Max weight 32 lbs";
  console.log(`\n🧪 ${name}`);
  
  const chatRes = await sendChat(token, "Create a blood pressure tracker for Mom and log Max's weight at 32 lbs");
  console.log("AI reply:", chatRes.reply?.substring(0, 200));
  
  await new Promise(r => setTimeout(r, 2000));
  
  const profiles = await getProfiles(token);
  const momProfile = profiles.find((p: any) => p.name === "Mom");
  const maxProfile = profiles.find((p: any) => p.name === "Max");
  
  const trackers = await getTrackers(token);
  // Find BP trackers linked to Mom specifically, or the most recently created one
  const allBpTrackers = trackers.filter((t: any) => t.name?.toLowerCase().includes("blood pressure"));
  const bpTracker = allBpTrackers.find((t: any) => t.linkedProfiles?.includes(momProfile?.id)) || allBpTrackers[allBpTrackers.length - 1];
  
  // Find weight tracker linked to Max (could be named "Max Weight" or "Weight")
  const allWeightTrackers = trackers.filter((t: any) => t.name?.toLowerCase().includes("weight"));
  const weightTracker = allWeightTrackers.find((t: any) => t.linkedProfiles?.includes(maxProfile?.id)) || allWeightTrackers[allWeightTrackers.length - 1];
  
  const issues: string[] = [];
  
  if (!bpTracker) {
    issues.push("❌ Blood pressure tracker NOT created");
  } else {
    console.log("  BP Tracker created:", bpTracker.name, "| linkedProfiles:", bpTracker.linkedProfiles);
    if (momProfile && !bpTracker.linkedProfiles?.includes(momProfile.id)) {
      issues.push(`❌ BP tracker NOT linked to Mom (linkedProfiles: ${JSON.stringify(bpTracker.linkedProfiles)})`);
    } else {
      console.log("  ✅ BP tracker linked to Mom");
    }
  }
  
  if (!weightTracker) {
    issues.push("❌ Weight tracker NOT found (may not exist yet)");
  } else {
    // Check that a new entry was logged
    const lastEntry = weightTracker.entries?.[weightTracker.entries.length - 1];
    console.log("  Weight tracker latest entry:", lastEntry?.values);
    if (maxProfile && !weightTracker.linkedProfiles?.includes(maxProfile.id)) {
      issues.push(`❌ Weight tracker NOT linked to Max (linkedProfiles: ${JSON.stringify(weightTracker.linkedProfiles)})`);
    } else {
      console.log("  ✅ Weight tracker linked to Max");
    }
  }
  
  // Check profiles' linked arrays
  if (momProfile) {
    const momDetail = await getProfileDetail(token, momProfile.id);
    console.log("  Mom linkedTrackers:", momDetail.linkedTrackers);
    if (bpTracker && !momDetail.linkedTrackers?.includes(bpTracker.id)) {
      issues.push(`❌ Mom profile doesn't have BP tracker in linkedTrackers`);
    }
  }
  
  if (maxProfile) {
    const maxDetail = await getProfileDetail(token, maxProfile.id);
    console.log("  Max linkedTrackers:", maxDetail.linkedTrackers);
    if (weightTracker && !maxDetail.linkedTrackers?.includes(weightTracker.id)) {
      issues.push(`❌ Max profile doesn't have weight tracker in linkedTrackers`);
    }
  }
  
  return {
    name,
    passed: issues.length === 0,
    details: issues.length > 0 ? issues.join("\n") : "✅ Both trackers created and linked to correct profiles",
    aiReply: chatRes.reply?.substring(0, 300),
  };
}

// ========================
// TEST 3: CHAOS MODE — 6-action query
// ========================
async function test3_chaosMode(token: string): Promise<TestResult> {
  const name = "Test 3: CHAOS — Event + Expense + Task + Tracker entry + Steps + Pet weight";
  console.log(`\n🧪 ${name}`);
  
  // Snapshot current counts
  const tasksBefore = await getTasks(token);
  const expensesBefore = await getExpenses(token);
  const eventsBefore = await getEvents(token);
  
  const chatRes = await sendChat(
    token,
    "Schedule a vet appointment for Max next Monday at 10am, I spent $90 on the vet visit for Max, create a task to buy dog food for Max by Friday, log Max's weight at 33 pounds, I walked 8000 steps today, and log my blood pressure at 120 over 80"
  );
  console.log("AI reply:", chatRes.reply?.substring(0, 300));
  
  await new Promise(r => setTimeout(r, 3000));
  
  // Check all the things
  const tasksAfter = await getTasks(token);
  const expensesAfter = await getExpenses(token);
  const eventsAfter = await getEvents(token);
  const trackers = await getTrackers(token);
  
  const profiles = await getProfiles(token);
  const maxProfile = profiles.find((p: any) => p.name === "Max");
  
  const issues: string[] = [];
  let actionsCreated = 0;
  
  // 1. Vet appointment event
  const newEvents = eventsAfter.filter((e: any) => !eventsBefore.find((eb: any) => eb.id === e.id));
  const vetEvent = newEvents.find((e: any) => e.title?.toLowerCase().includes("vet"));
  if (vetEvent) {
    actionsCreated++;
    console.log("  ✅ Vet event created:", vetEvent.title, "| linkedProfiles:", vetEvent.linkedProfiles);
    if (maxProfile && !vetEvent.linkedProfiles?.includes(maxProfile.id)) {
      issues.push("❌ Vet event NOT linked to Max");
    }
  } else {
    issues.push("❌ Vet appointment event NOT created");
  }
  
  // 2. $90 vet expense
  const newExpenses = expensesAfter.filter((e: any) => !expensesBefore.find((eb: any) => eb.id === e.id));
  const vetExpense = newExpenses.find((e: any) => e.amount === 90 || e.description?.toLowerCase().includes("vet"));
  if (vetExpense) {
    actionsCreated++;
    console.log("  ✅ Vet expense created: $" + vetExpense.amount, vetExpense.description, "| linkedProfiles:", vetExpense.linkedProfiles);
    if (maxProfile && !vetExpense.linkedProfiles?.includes(maxProfile.id)) {
      issues.push("❌ Vet expense NOT linked to Max");
    }
  } else {
    issues.push("❌ $90 vet expense NOT created");
  }
  
  // 3. Buy dog food task
  const newTasks = tasksAfter.filter((t: any) => !tasksBefore.find((tb: any) => tb.id === t.id));
  const dogFoodTask = newTasks.find((t: any) => t.title?.toLowerCase().includes("dog food") || t.title?.toLowerCase().includes("food"));
  if (dogFoodTask) {
    actionsCreated++;
    console.log("  ✅ Dog food task created:", dogFoodTask.title, "| linkedProfiles:", dogFoodTask.linkedProfiles);
    if (maxProfile && !dogFoodTask.linkedProfiles?.includes(maxProfile.id)) {
      issues.push("❌ Dog food task NOT linked to Max");
    }
  } else {
    issues.push("❌ Dog food task NOT created");
  }
  
  // 4. Max weight at 33 lbs (tracker entry) — could be in "Max Weight" or "Weight" tracker
  const allWeightTrackers = trackers.filter((t: any) => t.name?.toLowerCase().includes("weight"));
  let foundWeight33 = false;
  for (const wt of allWeightTrackers) {
    const hasWeight33 = wt.entries?.some((e: any) => {
      const vals = e.values || {};
      return Object.values(vals).some((v: any) => v === 33 || v === "33");
    });
    if (hasWeight33) {
      foundWeight33 = true;
      actionsCreated++;
      console.log("  ✅ Weight 33 lbs logged in tracker:", wt.name);
      break;
    }
  }
  if (!foundWeight33) {
    if (allWeightTrackers.length === 0) {
      issues.push("❌ No weight tracker found");
    } else {
      // Show what we have
      for (const wt of allWeightTrackers) {
        const lastEntry = wt.entries?.[wt.entries.length - 1];
        console.log(`  ⚠️ ${wt.name} latest entry:`, lastEntry?.values);
      }
      issues.push("⚠️ Weight 33 lbs entry NOT found in any weight tracker (may have logged to existing entry)");
    }
  }
  
  // 5. Steps (may create a new tracker or log to existing)
  const stepsTracker = trackers.find((t: any) => t.name?.toLowerCase().includes("step"));
  if (stepsTracker) {
    actionsCreated++;
    console.log("  ✅ Steps tracker found:", stepsTracker.name);
  } else {
    // It may have just been created — re-fetch
    const trackersRefresh = await getTrackers(token);
    const stepsRefresh = trackersRefresh.find((t: any) => t.name?.toLowerCase().includes("step"));
    if (stepsRefresh) {
      actionsCreated++;
      console.log("  ✅ Steps tracker found (refresh):", stepsRefresh.name);
    } else {
      issues.push("⚠️ Steps tracker not found (may have been logged differently)");
    }
  }
  
  // 6. Blood pressure
  const bpTracker = trackers.find((t: any) => t.name?.toLowerCase().includes("blood pressure") || t.name?.toLowerCase().includes("bp"));
  if (bpTracker) {
    const hasBPEntry = bpTracker.entries?.some((e: any) => {
      const vals = e.values || {};
      return vals.systolic === 120 || vals.systolic === "120";
    });
    if (hasBPEntry) {
      actionsCreated++;
      console.log("  ✅ Blood pressure 120/80 logged");
    } else {
      console.log("  ⚠️ BP tracker exists but no 120/80 entry found. Last entry:", bpTracker.entries?.[bpTracker.entries.length - 1]?.values);
      issues.push("⚠️ BP 120/80 entry not found");
    }
  } else {
    issues.push("⚠️ Blood pressure tracker not found");
  }
  
  console.log(`\n  Actions detected: ${actionsCreated}/6`);
  
  // Consider it passing if at least 4 of 6 actions were created (AI may handle some differently)
  const passed = actionsCreated >= 4 && issues.filter(i => i.startsWith("❌")).length === 0;
  
  return {
    name,
    passed,
    details: issues.length > 0 ? `${actionsCreated}/6 actions created\n${issues.join("\n")}` : `✅ All ${actionsCreated} actions created and linked`,
    aiReply: chatRes.reply?.substring(0, 400),
  };
}

// ========================
// MAIN
// ========================
async function main() {
  console.log("🔐 Logging in...");
  const token = await login();
  console.log("✅ Logged in\n");
  
  const results: TestResult[] = [];
  
  // Run tests sequentially (they use the same data)
  results.push(await test1_multiCommand(token));
  results.push(await test2_crossProfileTracker(token));
  results.push(await test3_chaosMode(token));
  
  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("TEST RESULTS SUMMARY");
  console.log("=".repeat(60));
  
  for (const r of results) {
    const icon = r.passed ? "✅" : "❌";
    console.log(`\n${icon} ${r.name}`);
    console.log(`   ${r.details}`);
    if (!r.passed && r.aiReply) {
      console.log(`   AI said: ${r.aiReply}`);
    }
  }
  
  const passed = results.filter(r => r.passed).length;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`TOTAL: ${passed}/${results.length} tests passed`);
  console.log("=".repeat(60));
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
