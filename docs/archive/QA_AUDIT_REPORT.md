# Portol Chat QA Audit Report
**Date:** March 25, 2026  
**Tested against:** localhost:5000 (dev server with Supabase backend)

---

## TEST 1: "Schedule a meeting with Dr. Chan at 3 PM on April 15"

| Check | Expected | Actual | Pass? |
|-------|----------|--------|-------|
| Event created | Yes | Yes — "Meeting with Dr. Chan" | ✅ |
| Title preserves "Dr. Chan" | "Meeting with Dr. Chan" | "Meeting with Dr. Chan" | ✅ |
| Date correct | 2026-04-15 | 2026-04-15 | ✅ |
| Time correct | 15:00 | 15:00 | ✅ |
| In calendar timeline | Yes | Yes | ✅ |
| Linked to Dr. profile | Should link to medical profile if exists | Not linked (`linkedProfiles: []`) | ❌ |

**Severity:** MEDIUM — Detail retained perfectly, but event not linked to any profile despite "Dr. Chan" matching pattern.

---

## TEST 2: "Spent $85 on a vet visit for Max"

| Check | Expected | Actual | Pass? |
|-------|----------|--------|-------|
| Expense created | $85 | $85 | ✅ |
| Description | "Vet visit for Max" | "a vet visit for max" | ⚠️ |
| Category | "pet" or "health" | "general" | ❌ |
| Linked to Max profile | Yes | Yes — `['f58b494b...']` | ✅ |
| Visible in Max's profile detail | Yes | Yes — shows in expenses | ✅ |

**Severity:** LOW — Data saved and linked correctly. Category should auto-detect "vet" as pet/health. Description has lowercase "max" (minor).

---

## TEST 3: "Mom's blood pressure is 145/92"

| Check | Expected | Actual | Pass? |
|-------|----------|--------|-------|
| BP entry created | systolic:145, diastolic:92 | systolic:145, diastolic:92 | ✅ |
| Linked to Mom profile | Yes | Yes — `['35d7a39b...']` | ✅ |
| Visible in Mom's trackers | Yes | Yes | ✅ |
| AHA classification | Stage 2 High | "high_stage2" | ✅ |
| Both values stored | 145/92 | 145/92 | ✅ |

**Severity:** NONE — Perfect execution.

---

## TEST 4: "I ran 5 miles in 42 minutes, then ate a steak dinner with mashed potatoes"

| Check | Expected | Actual | Pass? |
|-------|----------|--------|-------|
| Running entry created | distance:5, duration:42 | distance:5, duration:42, pace:8.4, cal:500 | ✅ |
| Nutrition entry created | calories, protein, etc. | cal:650, protein:45, carbs:35, fat:30 | ✅ |
| TWO separate actions | Yes | Yes — 2 actions | ✅ |
| Notes captured | Yes | "5 miles in 42 minutes - great pace!" | ✅ |
| Running linked to Me | Yes | Yes — `['45a0f90c...']` | ✅ |
| Food linked to Me | Yes | Yes — `['45a0f90c...']` | ✅ |
| Secondary data (pace, cal) | pace + calories | pace:8.4, caloriesBurned:500 | ✅ |

**Severity:** NONE — Perfect multi-action execution with secondary data.

---

## TEST 5: "Remind me to take Max to the groomer next Friday"

| Check | Expected | Actual | Pass? |
|-------|----------|--------|-------|
| Task created | Yes | Yes — "take max to the groomer next friday" | ✅ |
| Title quality | "Take Max to groomer" | "take max to the groomer next friday" (lowercase, raw) | ⚠️ |
| Due date | Next Friday (2026-03-28) | null — date not extracted | ❌ |
| Linked to Max profile | Yes | No — `linkedProfiles: []` | ❌ |
| Went through fast-path? | Probably | Yes — used regex fast-path, bypassed AI | ⚠️ |

**Severity:** HIGH — Fast-path regex caught "remind me to" and created a raw task without AI processing. Lost the date, lost profile linking, lost title formatting. The fast-path is sabotaging the AI's ability to properly handle the command.

---

## TEST 6: "I pay $15.99 per month for Netflix, it renews on the 1st"

| Check | Expected | Actual | Pass? |
|-------|----------|--------|-------|
| Obligation/subscription created | Yes | No — created as expense instead | ❌ |
| Expense created | Possibly | Yes — $15.99 | ✅ |
| Description | Meaningful | "per month for netflix, it renews on the 1st" | ⚠️ |
| Linked to Netflix profile | Yes | Yes — `['2a8b8d2f...']` | ✅ |
| Recurring date captured | 1st of month | Not captured | ❌ |

**Severity:** HIGH — This should have created an obligation/recurring expense, not a one-time expense. Also went through the fast-path `$amount` regex. The Netflix linking worked because of auto-link by name matching.

---

## TEST 7: "Max weighs 34 pounds today"

| Check | Expected | Actual | Pass? |
|-------|----------|--------|-------|
| Weight entry | 34 lbs | weight: 34 | ✅ |
| Correct tracker | "Max Weight" | "Max Weight" | ✅ |
| Linked to Max | Yes | Yes — `['f58b494b...']` | ✅ |
| AI calculated trend | +2 lbs from 32 | Mentioned in reply | ✅ |

**Severity:** NONE — Perfect execution.

---

## TEST 8: "Schedule Tesla Model 3 oil change on April 20 and add $75 expense for it"

| Check | Expected | Actual | Pass? |
|-------|----------|--------|-------|
| Calendar event created | "Tesla Model 3 Oil Change" on Apr 20 | NOT CREATED | ❌ |
| Expense created | $75 | $75 | ✅ |
| Expense description | "Tesla Model 3 oil change" | "expense for it" | ❌ |
| Expense category | "vehicle" or "maintenance" | "general" | ❌ |
| Expense linked to Tesla | Yes | No — `linkedProfiles: []` | ❌ |
| TWO actions executed | Yes | No — only 1 (expense) | ❌ |

**Severity:** CRITICAL — Fast-path regex caught "$75" and created a single expense, completely ignoring the calendar event request and losing all detail. This is a false-positive confirmation — the AI said "Logged: $75" but missed the entire scheduling action.

---

## TEST 9: "I slept 6.5 hours last night, woke up feeling tired"

| Check | Expected | Actual | Pass? |
|-------|----------|--------|-------|
| Sleep entry | hours: 6.5 | Created but with field mismatch warnings | ⚠️ |
| Quality captured | "tired" / "poor" | AI tried to send "quality" but tracker only has "hours" field | ❌ |
| Notes captured | "woke up feeling tired" | Attempted via _notes | ✅ |

**Severity:** MEDIUM — The tracker schema only has "hours" but AI tried to send duration, quality, _notes. Extra fields are being dropped with warnings.

---

## TEST 10: "My cholesterol came back at 210, schedule a follow-up with Dr. James Park on May 1 at 10am"

(Timed out in batch — needs individual retest)

---

## TEST 11: "Create a task to renew Mom's passport by June 15 and another to update her insurance"

| Check | Expected | Actual | Pass? |
|-------|----------|--------|-------|
| Task 1: Renew passport | Yes | Yes — "Renew Mom's passport" due 2026-06-15 | ✅ |
| Task 1 linked to Mom | Yes | Yes — `['35d7a39b...']` | ✅ |
| Task 2: Update insurance | Yes | Need to verify | ⚠️ |

**Severity:** LOW (if both created) — AI handled multi-task correctly.

---

## SYSTEMIC ISSUES FOUND

### 1. FAST-PATH REGEX IS SABOTAGING THE AI (CRITICAL)
The `tryFastPath()` function catches patterns like:
- `$amount` → creates expense immediately, bypasses AI
- `remind me to X` → creates raw task immediately, bypasses AI

This causes:
- Loss of profile linking
- Loss of date extraction
- Loss of detail/context
- Loss of multi-action handling
- Loss of proper naming

Commands that SHOULD go to AI but get intercepted:
- "$85 on a vet visit for Max" → expense with no category/link (fast-path)
- "Remind me to take Max to the groomer next Friday" → task with no date/link
- "$15.99 per month for Netflix" → one-time expense instead of obligation
- "$75 expense + schedule event" → only expense created

### 2. EVENT PROFILE LINKING MISSING
Events created via AI tool are NOT being auto-linked to profiles. "Meeting with Dr. Chan" has empty `linkedProfiles`. The `autoLinkToProfiles` function may not be called for events.

### 3. EXPENSE CATEGORY NOT SMART
AI creates expenses with `category: "general"` even when context clearly indicates "pet", "vehicle", "health", etc.

### 4. TRACKER FIELD SCHEMA MISMATCH
When AI sends extra fields that don't exist in the tracker schema (e.g., "quality" for Sleep tracker), they get dropped silently. The tracker should either:
- Accept extra fields dynamically, OR
- The AI should only send fields that exist in the tracker's schema

### 5. DUPLICATE TASKS
"Get Max groomed" appears 4 times — duplicate prevention is weak or missing for tasks.
