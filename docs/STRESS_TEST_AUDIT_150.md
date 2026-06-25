# 150-Command Stress-Test Audit (static code trace)

**Method:** each command was traced through the real handlers in
`server/ai-engine.ts` (tool registry + `executeTool`), `server/routes.ts`
(upload/extraction, cron), and the client display paths — **not** run live (the
sandbox can't reach the deployed app or the chat API). Verdicts reflect whether
a supporting tool exists, routes correctly, persists, and surfaces in the right
UI.

**Legend**
- ✅ **Works** — correct tool exists; routes, persists, and shows in the right place.
- ⚠️ **Partial / at-risk** — works but with a real caveat (LLM-dependent multi-call, no push delivery, vague NLP, two-step).
- ❌ **Won't do what's expected** — no supporting capability; the AI may reply but nothing real happens.

**Where things show up:** trackers → **Linked** tab + Dashboard cards + tracker
detail; expenses/budgets/liabilities → **Finance**; events/reminders →
**Calendar** + in-app **notification bell**; documents → **Artifacts** +
profile doc tab; notes/journal → profile + Journal; habits/tasks → Habits/Tasks +
Calendar (tasks with due dates).

---

## Health / Fitness (1–10) — `log_tracker_entry` / `create_tracker`
| # | Verdict | Notes |
|---|---------|-------|
| 1 run 2.4mi/27min | ✅ | Fitness tracker (distance/duration/pace); "felt tired" → notes. |
| 2 multi-exercise chest day | ⚠️ | **RC-D**: requires the model to emit one `log_tracker_entry` per exercise. Prompt guides it, code doesn't enforce — risk only bench (or one) logs. |
| 3 BP 128/82 + HR 74 | ✅ | Blood-pressure tracker (systolic/diastolic/pulse). |
| 4 steps 9,800 / 4.6mi / 420cal | ✅ | Steps tracker; multiple fields. |
| 5 sleep 11:45p–6:30a, woke twice | ✅ | ~6.75h; "woke twice" → awakenings/notes. |
| 6 weight 184.6 | ✅ | Weight tracker. |
| 7 water 24oz + 16oz | ✅ | Hydration; two entries (or summed). |
| 8 resting HR 58, "don't confuse with BP" | ✅ | Heart-rate tracker. This is the **#144 risk area** — watch HR-vs-BP field mapping. |
| 9 hike 1h20m moderate | ✅ | Fitness + intensity. |
| 10 basketball 90min, knees sore | ✅ | Fitness + notes. |

## Nutrition (11–20) — `log_tracker_entry` → **Nutrition**
All route to the single Nutrition tracker with `item` + macros. **The smoothie
(#17) is now fixed** — the new `shared/nutrition-shaped.ts` guard prevents a food
from becoming a standalone tracker.
| # | Verdict | Notes |
|---|---------|-------|
| 11–15, 18 | ✅ | Item + estimated macros. |
| 16 add 35g sugar | ✅ | `sugar` is a first-class nutrition field. |
| 17 spinach/blueberry/banana/yogurt/honey smoothie | ✅ **(fixed)** | Routes to a Nutrition **entry**, not a rogue tracker. |
| 19 1,900 cal, mark protein low | ✅ | Calories + note. |
| 20 salmon/sweet potato/asparagus, estimate macros | ✅ | AI estimates + saves. |

## Medication / Supplements (21–30) — `create_tracker(medication)` + `schedule_medication_refills`
| # | Verdict | Notes |
|---|---------|-------|
| 21 multivitamin + fish oil | ✅ | Two adherence entries. |
| 22 Amoxicillin 500mg 2×/10d | ✅ | Medication shape (dose/frequency/adherence). |
| 23 ibuprofen 400mg 2pm | ✅ | Entry + reason note. |
| 24 Vitamin D3 5,000 IU | ✅ | Supplement shape. |
| 25 "missed my medication… took today 8am" | ✅ **(improved)** | Names no drug → the new **#5 fix** makes the AI **ask which med** when 2+ exist instead of assuming the last-discussed one. |
| 26 creatine + remind if miss | ⚠️ | Tracker ✅; reminder persists + lands on Calendar/bell, **but no push/email delivery (#6)**. |
| 27 refill at 5 pills | ⚠️ | `schedule_medication_refills` fires via cron in-app; no push. |
| 28 magnesium 200mg bed | ✅ | |
| 29 fish oil 2 softgels breakfast | ✅ | |
| 30 1 pill/morning 6mo + monthly refills | ⚠️ | Recurring fine; delivery in-app only. |

## Expenses / Finance (31–40) — `create_expense` / `create_liability` / `log_income`
| # | Verdict | Notes |
|---|---------|-------|
| 31 $52.43 groceries Walmart | ✅ | |
| 32 $1,250 rent Bob monthly | ✅ | Recurring, scoped to Bob. |
| 33 Jane $75 internet | ✅ | Scoped to Jane. |
| 34 split $120 dinner 3 ways | ⚠️ | **No first-class bill-split** — AI logs one $120 (or three $40) by interpretation; not guaranteed per-person. |
| 35 $18.99 Spotify recurring | ✅ | Subscription/liability. |
| 36 $350 car insurance monthly 15th | ✅ | |
| 37 $96.12 gas (debit) | ✅ | |
| 38 $2,500 paycheck | ✅ | `log_income` / paycheck. |
| 39 "owe Joe $40" | ⚠️ | **No IOU primitive** — modeled loosely as a note/liability; won't behave like a tracked personal debt. |
| 40 personal loan $4,500/$220/8.5% | ✅ | `create_liability`. |

## Assets / Belongings (41–50) — `create_profile` / `revalue_asset` / ownership + link tools
| # | Verdict | Notes |
|---|---------|-------|
| 41 2021 Honda CR-V $24k | ✅ | Vehicle asset. |
| 42 move gaming PC Jim→Bob | ⚠️ | `update_profile` reparent; depends on name resolution. |
| 43 MacBook Air M3 $900 | ✅ | |
| 44 house 50/50 me+Jane | ✅ | `split_ownership`. |
| 45 furniture under Home $3k | ✅ | Nested (parent Home). |
| 46 bike linked to my profile | ✅ | |
| 47 update gaming PC → $1,450 | ✅ | `revalue_asset`. |
| 48 mark CR-V has a loan | ✅ | `link_asset_to_liability` (loan auto-created if missing). |
| 49 Home→Garage→Tools→Drill $180 | ⚠️ | Deep nesting supported, but building 4 levels in one shot is LLM-heavy. |
| 50 remove Joe, Bob sole owner | ✅ | `link_asset_owner` replaceExisting. **#4 fix** prevents a bare "Honda" overwriting the wrong vehicle. |

## Calendar / Scheduling (51–60) — `create_event` / `create_reminder` / `query_calendar`
| # | Verdict | Notes |
|---|---------|-------|
| 51 dentist Fri 10am | ⚠️ | Reminder → Calendar + bell; **no push**. |
| 52 Bob doctor Jul 8 2:30 | ✅ | Scoped event. |
| 53 Luna vet next Tue | ✅ | Pet event. |
| 54 recurring rent reminder | ⚠️ | Recurring ✅; in-app delivery only. |
| 55 Jim birthday yearly | ✅ | |
| 56 remove past doctor appts | ⚠️ | Query + delete; "past/irrelevant" semantics fuzzy. |
| 57 oil change in 3 months | ✅ | Future-dated event. |
| 58 refill every 30 days | ⚠️ | Recurring reminder, in-app. |
| 59 court date Aug 12, important | ✅ | Event + priority. |
| 60 important dates this month | ✅ | `query_calendar`. |

## Documents (61–70) — upload/extraction + **new `manage_document` link/move/unlink**
| # | Verdict | Notes |
|---|---------|-------|
| 61 link Jane's license to her tab | ✅ **(fixed #3)** | `manage_document` now has `link`/`move`. Previously impossible. |
| 62 bank statement → extract+categorize | ⚠️ | Needs an actual file upload via 📎; extraction supported. |
| 63 insurance policy → connect to Honda CR-V | ✅ **(fixed)** | A vehicle is a profile, so `move`/`link` to "Honda CR-V" works. |
| 64 extract due date/amount/acct | ✅ | Extraction. |
| 65 Bob medical report → BP/HR/cholesterol | ✅ | Extraction → trackers on Bob. |
| 66 classify + auto-attach to profile | ⚠️ | Auto-pick at extraction is confidence-gated (≥0.6) and falls back to **self** — repairable now via `move`. |
| 67 find all docs linked to Jane | ✅ | `search_documents` / `get_related`. |
| 68 docs missing a profile | ⚠️ | No dedicated "orphan docs" query — likely conversational/incomplete. |
| 69 reclassify lease (not "other") | ⚠️ | Rename ✅; type reclassification not a clean tool path. |
| 70 every date → calendar obligations | ✅ | Extraction creates events for date fields. |

## Notes / Journal (71–80) — `journal_entry` / notes / `update_journal`
| # | Verdict | Notes |
|---|---------|-------|
| 71 journal today | ✅ | |
| 72 note under Bob (knee) | ✅ | Profile-linked. |
| 73 Luna sick note | ✅ | Pet note. |
| 74 general note | ✅ | |
| 75 private note Jane | ✅ | |
| 76 summarize journal this week | ✅ | `get_summary`/`generate_report`. |
| 77 find "tired" notes | ✅ | `search`. |
| 78 note on Honda CR-V (check engine) | ✅ | Asset is a profile → linkable. |
| 79 relationship note (Jim tools) | ✅ | |
| 80 turn note into task tomorrow | ⚠️ | Two-step (read note → `create_task`); usually works. |

## Habits / Tasks (81–90)
| # | Verdict | Notes |
|---|---------|-------|
| 81 daily 80oz water habit | ✅ | |
| 82 mark workout habit done | ✅ | `checkin_habit`. |
| 83 guitar 30min daily | ✅ | |
| 84 meditated 12min | ✅ | Habit/tracker. |
| 85 weekly cleaning Sunday | ✅ | Recurring task. |
| 86 skipped reading, done today | ✅ | checkin/uncomplete. |
| 87 habit streaks this month | ✅ | `streak.ts`. |
| 88 renew registration before Aug 1 | ✅ | Task w/ due → Calendar. |
| 89 tire pressure biweekly | ✅ | Recurring task. |
| 90 hide overdue irrelevant tasks | ⚠️ | Bulk complete/hide; "irrelevant" is a judgment call. |

## Profiles / People / Pets (91–100)
| # | Verdict | Notes |
|---|---------|-------|
| 91 Luna pet cat | ✅ | |
| 92 Bob + link to rent | ✅ | |
| 93 everything connected to Jane | ✅ | `get_related`/`get_relationships`. |
| 94 create Jim + move his assets | ⚠️ | Create ✅; bulk-move "his assets" is multi-step/ambiguous. |
| 95 make my profile the default dashboard | ⚠️/❌ | This is a **client UI setting**, not an AI tool — AI can't flip it. |
| 96 only Bob's everything | ✅ | Profile filter / `get_profile_data`. |
| 97 remove tracker from Jane (it's mine) | ✅ | Update tracker `linkedProfiles`. |
| 98 link doc to Craig not everyone | ✅ **(fixed #3)** | `manage_document move`. |
| 99 people connected to CR-V | ✅ | `get_relationships`. |
| 100 pet-care tracker Luna | ✅ | One or more trackers. |

## Complex Mixed (101–110) — multiple tools per message
| # | Verdict | Notes |
|---|---------|-------|
| 101 groceries+steps+water+fish oil | ✅ | 4 tools; ⚠️ multi-call reliability. |
| 102 Bob appt + upload report | ⚠️ | Appt ✅; upload needs the 📎 file. |
| 103 $300 car-loan payment + CR-V → $23,500 | ✅ | `add_liability_payment` + `revalue_asset`; **#4 fix** protects the right Honda. |
| 104 guitar tracker + log + weekday remind | ⚠️ | Reminder delivery in-app only. |
| 105 Jane half rent + my half unpaid | ⚠️ | Split/unpaid semantics not first-class. |
| 106 steak+rice + workout + BP 122/78 | ✅ | Nutrition + fitness + BP. |
| 107 bank statement + only my transactions | ⚠️ | Upload + per-transaction isolation. |
| 108 renew insurance + link car + remind 5d before | ⚠️ | Reminder delivery. |
| 109 meds+water+sleep yesterday | ✅ | Back-dated entries. |
| 110 dashboard summary for Bob | ✅ | `generate_report`/`get_summary`. |

## Messy Natural Language (111–120)
| # | Verdict | Notes |
|---|---------|-------|
| 111 ~3 bottles × 16.9oz | ✅ | ⚠️ estimation (~50.7oz). |
| 112 "one twenty five over eighty" | ✅ | ⚠️ word→number for BP. |
| 113 lifted ~1h, no exact sets | ✅ | Vague duration logs. |
| 114 ~$50 Target household | ✅ | |
| 115 "fish oil thing, same dose as usual" | ⚠️ | Needs memory of the prior dose. |
| 116 "dentist thing next Fri morning" | ⚠️ | Reminder, vague time. |
| 117 burger/fries/soda/candy | ✅ | Nutrition. |
| 118 "dog vet thing 12th at 3" | ✅ | Pet event. |
| 119 "paid Joe back $20, don't owe him" | ⚠️ | No IOU primitive to settle. |
| 120 "that doc belongs to Jane not Bob" | ✅ **(fixed #3)** | `manage_document move`. |

## Data Isolation (121–130)
| # | Verdict | Notes |
|---|---------|-------|
| 121 only my expenses | ✅ | |
| 122 Craig showing Bob's reminders — fix | ⚠️ | Diagnose + repair event ownership; partial. |
| 123 move doc everyone → Jane | ✅ **(fixed #3)** | `move`. |
| 124 everyone dashboard, hide habits/journals | ⚠️ | UI filter, not a clean tool. |
| 125 filter to Bob, all categories | ✅ | |
| 126 budget for Jane only | ✅ | `create_budget` forProfile. |
| 127 Jim's BP tracker, not mine | ✅ | `create_tracker` forProfile. |
| 128 rent payment Bob only | ✅ | |
| 129 remove shared visibility | ✅ **(fixed #3)** | `manage_document unlink`. |
| 130 show all data wrongly linked to many profiles | ❌ | **No cross-entity audit tool.** |

## Smart Visuals / Artifacts (131–140) — `generate_chart`/`table`/`report`, `create_artifact`, rollups
| # | Verdict | Notes |
|---|---------|-------|
| 131 protein 7-day chart | ✅ | |
| 132 weekly hydration visual | ✅ | |
| 133 expenses by category | ✅ | `spending_analytics`/chart. |
| 134 obligation timeline | ✅ | |
| 135 card summary Bob health | ✅ | |
| 136 net-worth breakdown | ✅ | `get_asset_rollup` / net-worth. |
| 137 sleep+workouts+mood compare | ⚠️ | Multi-metric composition is harder. |
| 138 unpaid bills table by due date | ✅ | `generate_table`. |
| 139 dashboard artifact for CR-V | ✅ | `create_artifact`. |
| 140 key findings all trackers | ✅ | `get_summary`. |

## Root-Cause / Debug (141–150) — **mostly not real capabilities**
There is **no introspection layer** that exposes parsed fields, confidence
scores, data-source provenance, or cross-tab duplicate/relationship audits to
the chat. The AI will *answer conversationally* but cannot truly inspect these.
| # | Verdict | Notes |
|---|---------|-------|
| 141 why wrong tracker type | ❌ | Conversational guess only. |
| 142 what data source caused this card | ❌ | No provenance tool. |
| 143 audit profile for bad links | ⚠️ | `get_related` gives a partial view. |
| 144 why BP saved as HR | ❌ | No parse-trace tool. |
| 145 show parsed fields before saving | ❌ | No in-chat pre-save preview tool (the extraction confirm UI exists, but not as an introspection answer). |
| 146 confidence scores for extraction | ❌ | Confidence exists internally (`aiPickIndex`) but isn't surfaced. |
| 147 why expense under everyone | ⚠️ | Conversational. |
| 148 duplicates across tabs | ❌ | No dedup audit tool. |
| 149 broken relationships | ❌ | No relationship-integrity tool. |
| 150 validate cards belong to profile | ❌ | No validation tool. |

---

## Headline findings
1. **Fixed in this pass (#3):** documents can now be **linked / moved / unlinked
   to profiles via chat** (`manage_document` actions `link`/`move`/`unlink`,
   resolving people by the safe word-boundary matcher). This unblocks #61, #63,
   #98, #120, #123, #129 and lets users repair the mislinked Jane license.
2. **Already fixed earlier:** #17 (nutrition routing), #25 (med confirmation),
   #41/48/50/103 (asset-overwrite guard).
3. **Biggest remaining functional gap — reminders delivery (#6):** reminders
   persist and show on the Calendar + notification bell (cron-fired in-app), but
   there is **no push or email delivery**. Affects #26, #27, #30, #51, #54, #58,
   #88, #104, #108.
4. **No first-class primitives** for **bill-splitting** (#34, #105) or
   **person-to-person IOUs** (#39, #119) — these are approximated, not tracked.
5. **Debug/introspection (#141–150) are largely aspirational** — the app has no
   tool surface for parse-traces, confidence, provenance, or integrity audits.
6. **Multi-exercise / multi-tool messages (#2, #101)** depend on the model
   emitting one call per item (RC-D) — guided by prompt, not enforced by code.
7. **`make my profile the default dashboard` (#95)** is a client setting the AI
   can't currently toggle.

> Verdicts are from a static trace; a live run against a seeded account would
> confirm the ⚠️ items. Re-run the live AI harness (`vitest.live.config.ts`,
> `scripts/test_ai_e2e.ts`) with API + DB access to validate.
