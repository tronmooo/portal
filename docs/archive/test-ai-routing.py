#!/usr/bin/env python3
"""
AI Chat Stress Test — Tests that the AI engine routes tracker entries,
expenses, and tasks to the correct profiles.
"""
import json, subprocess, time, sys

SB_URL = "https://uvaniovwrezzzlzmizyg.supabase.co"
API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDA5MjgsImV4cCI6MjA4OTYxNjkyOH0.0tn5gFfpWN-k5jRUiFehB1cD0BO-DAWP7LQO_IGI1AQ"
SRK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2YW5pb3Z3cmV6enpsem1penlnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0MDkyOCwiZXhwIjoyMDg5NjE2OTI4fQ.WO2hjB0q18xHfZ4OYfxsPmN1V-K4526G7rBMCRVy8vI"
BASE = "https://portol.me"

# Google OAuth user's profiles
TRONMOOO_ID = "ebfd58a4-b170-49ad-8ccb-c2bc752cd816"
REX_ID = "ecba6a91-3539-4aa1-a1fa-053e894b2c48"
JOE_ID = "dcde6842-8a18-41b7-85e9-1881ff2c8172"
USER_ID = "078581d1-333f-4501-b508-6edd3a6b901d"

# Tracker IDs
RUNNING_TRONMOOO = "7ca6aaec-f449-4929-9982-31aaf6281a49"
RUNNING_REX = "b74301b5-b003-4e61-9883-5877f77b38d8"
RUNNING_JOE = "c989753b-4586-4f31-93ac-504cf9e0d10c"
NUTRITION_TRONMOOO = "9640d122-a063-46fc-88f3-cbde9aa27caf"  # will need to verify

results = {"pass": 0, "fail": 0, "details": []}

def check(name, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    results["pass" if condition else "fail"] += 1
    icon = "✓" if condition else "✗"
    results["details"].append(f"[{status}] {name}" + (f" — {detail}" if detail else ""))
    print(f"  [{icon}] {name}" + (f" — {detail}" if detail else ""))

def supabase_get(path):
    r = subprocess.run(
        ["curl", "-s", f"{SB_URL}/rest/v1/{path}",
         "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"],
        capture_output=True, text=True, timeout=10)
    return json.loads(r.stdout)

def get_token_google():
    """Get a token for the Google OAuth user by using service role to generate one"""
    # We'll use the tron@aol.com account for API testing since we can get tokens for it
    r = subprocess.run(
        ["curl", "-s", "-X", "POST", f"{SB_URL}/auth/v1/token?grant_type=password",
         "-H", f"apikey: {API_KEY}", "-H", "Content-Type: application/json",
         "-d", '{"email":"tron@aol.com","password":"password"}'],
        capture_output=True, text=True, timeout=10)
    return json.loads(r.stdout)["access_token"]

def chat(token, message):
    """Send a chat message and return the response"""
    r = subprocess.run(
        ["curl", "-s", "-X", "POST", f"{BASE}/api/chat",
         "-H", f"Authorization: Bearer {token}",
         "-H", "Content-Type: application/json",
         "-d", json.dumps({"message": message})],
        capture_output=True, text=True, timeout=60)
    try:
        return json.loads(r.stdout)
    except:
        return {"error": r.stdout[:200]}

def get_recent_entries(tracker_id, limit=3):
    """Get recent entries for a tracker"""
    return supabase_get(f"tracker_entries?tracker_id=eq.{tracker_id}&order=timestamp.desc&limit={limit}&select=id,entry_values,for_profile,timestamp")

def get_recent_expenses(user_id, limit=5):
    """Get recent expenses"""
    return supabase_get(f"expenses?user_id=eq.{user_id}&order=created_at.desc&limit={limit}&select=id,description,amount,linked_profiles,created_at")

def get_recent_tasks(user_id, limit=5):
    """Get recent tasks"""
    return supabase_get(f"tasks?user_id=eq.{user_id}&order=created_at.desc&limit={limit}&select=id,title,status,linked_profiles,created_at")

def delete_entry(entry_id):
    subprocess.run(
        ["curl", "-s", "-X", "DELETE", f"{SB_URL}/rest/v1/tracker_entries?id=eq.{entry_id}",
         "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"],
        capture_output=True, text=True, timeout=10)

def delete_expense(expense_id):
    subprocess.run(
        ["curl", "-s", "-X", "DELETE", f"{SB_URL}/rest/v1/expenses?id=eq.{expense_id}",
         "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"],
        capture_output=True, text=True, timeout=10)

def delete_task(task_id):
    subprocess.run(
        ["curl", "-s", "-X", "DELETE", f"{SB_URL}/rest/v1/tasks?id=eq.{task_id}",
         "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"],
        capture_output=True, text=True, timeout=10)

# Use tron@aol.com for testing (we can authenticate with it)
# The same code path runs for both accounts
token = get_token_google()
# Get tron@aol.com's user ID and profile info
TRON_USER_RESP = supabase_get("profiles?name=eq.Me&select=id,user_id")
if TRON_USER_RESP:
    TRON_USER_ID = TRON_USER_RESP[0]["user_id"]
    ME_ID = TRON_USER_RESP[0]["id"]
else:
    print("ERROR: Can't find Me profile")
    sys.exit(1)

# Get tron@aol.com's Rex profile
REX_TRON = supabase_get(f"profiles?user_id=eq.{TRON_USER_ID}&name=eq.Rex&select=id")
REX_TRON_ID = REX_TRON[0]["id"] if REX_TRON else None

# Get tron@aol.com's trackers
TRON_TRACKERS = supabase_get(f"trackers?user_id=eq.{TRON_USER_ID}&select=id,name,linked_profiles")
tron_tracker_map = {t["name"]: t for t in TRON_TRACKERS}

# Get tron@aol.com's Running tracker for Me
me_running = next((t for t in TRON_TRACKERS if t["name"] == "Running" and ME_ID in (t.get("linked_profiles") or [])), None)
# Also check junction
if not me_running:
    for t in TRON_TRACKERS:
        if "running" in t["name"].lower():
            jlinks = supabase_get(f"profile_trackers?tracker_id=eq.{t['id']}&select=profile_id")
            if any(j["profile_id"] == ME_ID for j in jlinks):
                me_running = t
                break

rex_running = next((t for t in TRON_TRACKERS if "Rex" in t["name"] and "running" in t["name"].lower()), None)

print(f"Testing with tron@aol.com user")
print(f"Me profile: {ME_ID[:8]}")
print(f"Rex profile: {REX_TRON_ID[:8] if REX_TRON_ID else 'NONE'}")
print(f"Me Running tracker: {me_running['id'][:8] if me_running else 'NONE'}")
print(f"Rex Running tracker: {rex_running['id'][:8] if rex_running else 'NONE'}")
print()

# Snapshot current state before tests
pre_me_entries = get_recent_entries(me_running["id"]) if me_running else []
pre_rex_entries = get_recent_entries(rex_running["id"]) if rex_running else []

cleanup_ids = {"entries": [], "expenses": [], "tasks": [], "trackers": []}

# ═══════════════════════════════════════════════════════════════════
print("=" * 60)
print("TEST 1: 'I ran 3 miles' → should go to Me's Running")
print("=" * 60)
resp = chat(token, "I ran 3 miles")
print(f"  AI reply: {resp.get('reply', resp.get('error', '?'))[:100]}...")
time.sleep(2)

if me_running:
    entries = get_recent_entries(me_running["id"], 1)
    if entries:
        latest = entries[0]
        vals = latest.get("entry_values", {})
        check("Entry on Me's Running", vals.get("distance") == 3, f"distance={vals.get('distance')}")
        check("for_profile is Me", latest.get("for_profile") == ME_ID, latest.get("for_profile", "?")[:8])
        cleanup_ids["entries"].append(latest["id"])
    else:
        check("Entry on Me's Running", False, "No entries found")

    # Also verify nothing went to Rex's tracker
    if rex_running:
        rex_entries = get_recent_entries(rex_running["id"], 1)
        rex_latest = rex_entries[0] if rex_entries else None
        if rex_latest and rex_latest not in pre_rex_entries:
            ts = rex_latest.get("timestamp", "")
            recent = "2026-04-07" in ts
            check("Nothing leaked to Rex's Running", not recent, f"Found entry at {ts}")
        else:
            check("Nothing leaked to Rex's Running", True)

# ═══════════════════════════════════════════════════════════════════
print()
print("=" * 60)
print("TEST 2: 'Rex ran 2 miles today' → should go to Rex's Running")
print("=" * 60)
resp = chat(token, "Rex ran 2 miles today")
print(f"  AI reply: {resp.get('reply', resp.get('error', '?'))[:100]}...")
time.sleep(2)

if rex_running:
    entries = get_recent_entries(rex_running["id"], 1)
    if entries:
        latest = entries[0]
        vals = latest.get("entry_values", {})
        check("Entry on Rex's Running", vals.get("distance") == 2, f"distance={vals.get('distance')}")
        check("for_profile is Rex", latest.get("for_profile") == REX_TRON_ID, latest.get("for_profile", "?")[:8])
        cleanup_ids["entries"].append(latest["id"])
    else:
        check("Entry on Rex's Running", False, "No entries found")
else:
    # Check if a new tracker was created
    new_trackers = supabase_get(f"trackers?user_id=eq.{TRON_USER_ID}&name=ilike.*Running*Rex*&select=id,name")
    if new_trackers:
        check("Created Running - Rex tracker", True, new_trackers[0]["name"])
        cleanup_ids["trackers"].append(new_trackers[0]["id"])
    else:
        check("Rex Running tracker", False, "No tracker found")

# ═══════════════════════════════════════════════════════════════════
print()
print("=" * 60)
print("TEST 3: 'I ate a burger, 650 calories' → Nutrition for Me")
print("=" * 60)
resp = chat(token, "I ate a burger, 650 calories")
print(f"  AI reply: {resp.get('reply', resp.get('error', '?'))[:100]}...")
time.sleep(2)

# Find nutrition tracker for Me
me_nutrition = next((t for t in TRON_TRACKERS if t["name"].lower() in ["nutrition", "calories"]), None)
if not me_nutrition:
    me_nutrition = next((t for t in TRON_TRACKERS if "nutrition" in t["name"].lower() or "calories" in t["name"].lower()), None)

if me_nutrition:
    entries = get_recent_entries(me_nutrition["id"], 1)
    if entries:
        latest = entries[0]
        vals = latest.get("entry_values", {})
        check("Nutrition entry created", vals.get("calories") == 650 or vals.get("calories") == "650", f"calories={vals.get('calories')}")
        check("Has food item name", bool(vals.get("item")), f"item={vals.get('item')}")
        check("for_profile is Me", latest.get("for_profile") == ME_ID, latest.get("for_profile", "?")[:8])
        cleanup_ids["entries"].append(latest["id"])
    else:
        check("Nutrition entry created", False, "No entries")
else:
    # Check if a new nutrition tracker was auto-created
    new_nutrition = supabase_get(f"trackers?user_id=eq.{TRON_USER_ID}&category=eq.nutrition&order=created_at.desc&limit=1&select=id,name")
    check("Nutrition tracker exists", bool(new_nutrition), "Auto-created" if new_nutrition else "Not found")

# ═══════════════════════════════════════════════════════════════════
print()
print("=" * 60)
print("TEST 4: 'Spent $45 on groceries' → Expense for Me")
print("=" * 60)
pre_expenses = get_recent_expenses(TRON_USER_ID, 1)
resp = chat(token, "Spent $45 on groceries")
print(f"  AI reply: {resp.get('reply', resp.get('error', '?'))[:100]}...")
time.sleep(2)

expenses = get_recent_expenses(TRON_USER_ID, 3)
new_expense = None
for e in expenses:
    if e["id"] not in [x["id"] for x in pre_expenses]:
        if "grocer" in (e.get("description") or "").lower() or e.get("amount") == 45:
            new_expense = e
            break

if new_expense:
    check("Expense created", True, f"{new_expense['description']}: ${new_expense['amount']}")
    check("Amount is $45", new_expense["amount"] == 45, f"${new_expense['amount']}")
    lp = new_expense.get("linked_profiles") or []
    check("Linked to Me", ME_ID in lp, f"profiles={[p[:8] for p in lp]}")
    check("NOT linked to Rex", REX_TRON_ID not in lp if REX_TRON_ID else True)
    cleanup_ids["expenses"].append(new_expense["id"])
else:
    check("Expense created", False, "Not found in recent expenses")

# ═══════════════════════════════════════════════════════════════════
print()
print("=" * 60)
print("TEST 5: 'Rex needs a vet checkup next week' → Task for Rex")
print("=" * 60)
pre_tasks = get_recent_tasks(TRON_USER_ID, 1)
resp = chat(token, "Rex needs a vet checkup next week")
print(f"  AI reply: {resp.get('reply', resp.get('error', '?'))[:100]}...")
time.sleep(2)

tasks = get_recent_tasks(TRON_USER_ID, 3)
new_task = None
for t in tasks:
    if t["id"] not in [x["id"] for x in pre_tasks]:
        if "vet" in (t.get("title") or "").lower() or "rex" in (t.get("title") or "").lower():
            new_task = t
            break

if new_task:
    check("Task created", True, f"{new_task['title']}")
    lp = new_task.get("linked_profiles") or []
    check("Linked to Rex", REX_TRON_ID in lp if REX_TRON_ID else False, f"profiles={[p[:8] for p in lp]}")
    cleanup_ids["tasks"].append(new_task["id"])
else:
    check("Task created", False, "Not found in recent tasks")

# ═══════════════════════════════════════════════════════════════════
print()
print("=" * 60)
print("TEST 6: 'Spent $80 on Rex vet bill' → Expense linked to Rex")
print("=" * 60)
pre_expenses = get_recent_expenses(TRON_USER_ID, 1)
resp = chat(token, "Spent $80 on Rex vet bill")
print(f"  AI reply: {resp.get('reply', resp.get('error', '?'))[:100]}...")
time.sleep(2)

expenses = get_recent_expenses(TRON_USER_ID, 3)
new_expense = None
for e in expenses:
    if e["id"] not in [x["id"] for x in pre_expenses]:
        if "vet" in (e.get("description") or "").lower() or e.get("amount") == 80:
            new_expense = e
            break

if new_expense:
    check("Vet expense created", True, f"{new_expense['description']}: ${new_expense['amount']}")
    lp = new_expense.get("linked_profiles") or []
    check("Linked to Rex", REX_TRON_ID in lp if REX_TRON_ID else False, f"profiles={[p[:8] for p in lp]}")
    cleanup_ids["expenses"].append(new_expense["id"])
else:
    check("Vet expense created", False, "Not found")

# ═══════════════════════════════════════════════════════════════════
print()
print("=" * 60)
print("TEST 7: 'I walked 1.5 miles and ate a salad 300 cal' → TWO entries")
print("=" * 60)
if me_running:
    pre_run = get_recent_entries(me_running["id"], 1)
if me_nutrition:
    pre_nutr = get_recent_entries(me_nutrition["id"], 1)

resp = chat(token, "I walked 1.5 miles and ate a salad, about 300 calories")
print(f"  AI reply: {resp.get('reply', resp.get('error', '?'))[:100]}...")
time.sleep(3)

if me_running:
    entries = get_recent_entries(me_running["id"], 1)
    if entries and entries[0]["id"] not in [e["id"] for e in pre_run]:
        vals = entries[0].get("entry_values", {})
        check("Running entry created", True, f"distance={vals.get('distance')}")
        cleanup_ids["entries"].append(entries[0]["id"])
    else:
        check("Running entry created", False, "No new entry")

if me_nutrition:
    entries = get_recent_entries(me_nutrition["id"], 1)
    if entries and entries[0]["id"] not in [e["id"] for e in pre_nutr]:
        vals = entries[0].get("entry_values", {})
        check("Nutrition entry created", True, f"calories={vals.get('calories')}, item={vals.get('item')}")
        cleanup_ids["entries"].append(entries[0]["id"])
    else:
        check("Nutrition entry created", False, "No new entry")

# ═══════════════════════════════════════════════════════════════════
print()
print("=" * 60)
print("TEST 8: 'Log my blood pressure at 125/80' → BP tracker for Me")
print("=" * 60)
bp_tracker = next((t for t in TRON_TRACKERS if "blood" in t["name"].lower() and "pressure" in t["name"].lower()), None)
if bp_tracker:
    pre_bp = get_recent_entries(bp_tracker["id"], 1)
resp = chat(token, "Log my blood pressure at 125/80")
print(f"  AI reply: {resp.get('reply', resp.get('error', '?'))[:100]}...")
time.sleep(2)

if bp_tracker:
    entries = get_recent_entries(bp_tracker["id"], 1)
    if entries and entries[0]["id"] not in [e["id"] for e in pre_bp]:
        vals = entries[0].get("entry_values", {})
        check("BP entry created", True, f"systolic={vals.get('systolic')}, diastolic={vals.get('diastolic')}")
        check("for_profile is Me", entries[0].get("for_profile") == ME_ID)
        cleanup_ids["entries"].append(entries[0]["id"])
    else:
        check("BP entry created", False, "No new entry")

# ═══════════════════════════════════════════════════════════════════
print()
print("=" * 60)
print("CLEANUP")
print("=" * 60)
for eid in cleanup_ids["entries"]:
    delete_entry(eid)
    print(f"  Deleted entry {eid[:8]}")
for eid in cleanup_ids["expenses"]:
    delete_expense(eid)
    print(f"  Deleted expense {eid[:8]}")
for tid in cleanup_ids["tasks"]:
    delete_task(tid)
    print(f"  Deleted task {tid[:8]}")
for tid in cleanup_ids["trackers"]:
    # delete entries first, then tracker
    entries = supabase_get(f"tracker_entries?tracker_id=eq.{tid}&select=id")
    for e in entries:
        delete_entry(e["id"])
    subprocess.run(
        ["curl", "-s", "-X", "DELETE", f"{SB_URL}/rest/v1/trackers?id=eq.{tid}",
         "-H", f"apikey: {SRK}", "-H", f"Authorization: Bearer {SRK}"],
        capture_output=True, text=True, timeout=10)
    print(f"  Deleted tracker {tid[:8]}")

# ═══════════════════════════════════════════════════════════════════
print()
print("=" * 60)
total = results["pass"] + results["fail"]
print(f"RESULTS: {results['pass']}/{total} passed, {results['fail']} failed")
print("=" * 60)
if results["fail"] > 0:
    print("\nFailed checks:")
    for d in results["details"]:
        if d.startswith("[FAIL]"):
            print(f"  {d}")
