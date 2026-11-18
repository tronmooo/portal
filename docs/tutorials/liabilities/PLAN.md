# Liabilities tutorial: production plan

**Status:** plan (nothing captured yet) · **Written:** 2026-11-18 · **Target app:** https://portol.me

This plan covers a complete, illustrated walkthrough of the Liabilities feature
in Portol. It has two goals:

1. **Tutorial.** A user-facing guide with a screenshot of every click and every
   result. Assembled from `TUTORIAL_TEMPLATE.md`.
2. **Verification.** Every step is checked against the data, not only against the screen.
   A step that shows the right screen but stores the wrong value fails. The checks are in
   `VERIFICATION_CHECKLIST.md`.

It walks through creating liabilities **manually** (the Add Liability dialog)
and **through the chat**. It also covers every feature on the liability page, and
checks that each change shows up across the app: the Liabilities list,
Dashboard, Finance, Calendar and search.

Files in this folder:

| File | What it is |
|---|---|
| `PLAN.md` | This document: scope, setup, conventions, and every step with its click target, screenshot ID and check |
| `VERIFICATION_CHECKLIST.md` | Pass/fail checklist with the API checks behind each step. Filled in during the run |
| `TUTORIAL_TEMPLATE.md` | Outline of the finished tutorial, with a placeholder for every screenshot |
| `screenshots/` | (created by the capture run) `desktop/` and `mobile/` PNGs named by shot ID |

---

## 1. Feature inventory (what the tutorial must cover)

Taken from the code as of `main` on 2026-11-18.

### 1.1 Where liabilities live
- **Liabilities list.** `/linked?tab=liabilities` (also `/liabilities`). It shows one card per
  liability, category chips (mortgage, auto, credit card, …) and the profile-scope
  filter notice. To add one, use the `+` button (`button-create-liability`) on the
  Liabilities tab, or `+` → **Liability** (`menu-add-liability`) on the All tab.
  The empty state has its own add button (`btn-empty-add-liability`).
- **Quick-create FAB.** The floating `+` → **Loan** tile opens the same dialog, titled "Add loan".
- **Chat.** `/chat`, with the input box `input-chat` and the send button `button-send`.

### 1.2 Liability types available in the manual dialog
These come from the live `/api/profile-types`. `*` marks a required field.

| Type | Fields |
|---|---|
| Mortgage | Lender\*, Loan Number, Original Loan Amount\*, Current Balance\*, Interest Rate\*, Loan Term (months)\*, Loan Start Date\*, Monthly Payment (P&I), Extra Monthly Payment, Rate Type, Escrow Included, Property Address |
| Auto Loan | Lender\*, Loan Number, Original Loan Amount\*, Current Balance\*, Interest Rate\*, Loan Term (months)\*, Loan Start Date\*, Monthly Payment, Extra Monthly Payment |
| Credit Card | Card Name\*, Issuer, Last 4 Digits, Credit Limit\*, Current Balance\*, APR\*, Minimum Payment, Due Date (Day of Month), Rewards Program |
| Student Loan | Loan Servicer\*, Loan Type, Original Balance\*, Current Balance\*, Interest Rate\*, Repayment Term, Repayment Start Date, Monthly Payment, Repayment Plan, PSLF Eligible |
| Personal Loan / Business Loan / HELOC / Medical Debt / Tax Debt / Boat Loan / RV Loan | Same pattern: lender or provider, balances, rate, term, payment |
| Recurring bills (the "subscriptions" category, shown in the same dialog): Phone Plan, Internet, Utility, Streaming, Software, Gym, … | Provider\*, amount\*, billing frequency, start date, … |

The tutorial shows **Auto Loan**, **Credit Card** and **Phone Plan** step by step.
The other types get one screenshot each of the filled form in the appendix (chapter 11).

### 1.3 The liability page (`/profiles/:id`, `liability-profile-page`)
- **Header:** name, subtype pill, lender · last 4, KPI stats, progress bar.
  Buttons: **Edit** (`button-header-edit-profile`, name and notes),
  **Delete** (`button-delete-profile` → confirm `button-confirm-delete-profile`),
  **Pay** (`quick-pay-min`). Clicking the avatar uploads a profile picture.
- **Overview tab** (`tab-overview`):
  - Payoff Outlook (`payoff-outlook`): payoff date, interest left, chart, principal/interest split.
  - AI summary (`liability-ai-summary`, with refresh `liability-ai-refresh`).
  - Linked assets (`link-asset-toggle` → select → role → `link-asset-confirm`).
  - Ownership editor (`card-ownership-editor`: add owner, split evenly, save).
  - Linked people (co-signer, guarantor and other roles).
  - A dynamic overview that changes with the subtype (utilization for cards, collateral, escrow).
  - Quick actions: Pay minimum / Pay custom / Extra principal / Interest only.
  - Cost of borrowing, Schedule, Recent payments.
  - Nested liabilities (`btn-add-nested-liability`).
- **Details tab** (`tab-details`):
  - Loans: the Loan terms card and its editor (`button-edit-terms`, with lender, balances,
    rate, payment, term, due day and first payment date) → `button-save-terms`.
  - Bills: the Bill details card and its editor (`button-edit-bill`, with amount, frequency,
    date, count, end date, reminder and autopay) → `button-save-bill`.
- **Payments tab** (`tab-payments`):
  - Bill schedule (`bill-schedule-section`: per-occurrence Pay / Skip / Edit, extra
    charges, pause/resume, frequency, mini calendar, filters).
  - Payment history (`payments-list`, add `payments-add`, reverse `reverse-payment-*`).
  - Payoff calculator (extra per month, lump sum, target months).
  - Balance chart and amortization schedule (`amort-table`).
- **Docs tab** (`tab-documents`): upload (`liability-doc-upload`), view, delete.
- **Activity tab** (`tab-activity`): a timeline grouped by date.
- **History tab** (`tab-history`): the field change history.

### 1.4 Chat capabilities (server tools in `server/ai-engine.ts`)
| Tool | Example phrase |
|---|---|
| `create_liability` | "I have a car loan with Chase…", "opened a Chase Sapphire with $10k limit…" |
| `update_liability` | "my mortgage balance is now $410k", "refinanced to 5.25%" |
| `add_liability_payment` | "paid $500 on my Chase card", "sent $1000 extra to principal", "minimum payment on Visa", "missed last month's payment" |
| `update_liability_payment` / `delete_liability_payment` / `undo_last_payment` | "delete that duplicate payment" |
| `mark_loan_payment` | "mark the next car-loan installment paid" |
| `link_liability_asset` / `link_asset_to_liability` / `unlink_asset_from_liability` | "the mortgage is on 742 Evergreen Terrace" |
| `link_liability_owner` | "Jamie and I split it 50/50" |
| `get_liability_summary` / `get_loan_schedule` | "how much do I owe on my mortgage?", "show my payoff schedule" |
| `delete_profile` | "delete my mortgage". This only runs when the user's own message asks for deletion |

Chat writes straight away and then shows an action receipt card. It shows **no**
confirmation card for typed messages (that only happens for document uploads,
where the user clicks Confirm/Skip).

---

## 2. Environment and safety rules

- **Where it runs:** production (`https://portol.me`) as the **smoke account only**
  (`tests/smoke/fixture/account.ts`, signed in through `tests/helpers/live-account.ts`).
  Production is used because the chat has to use the real AI model; the local
  acceptance rig mocks the model, so it can't prove the chat works.
  Real users' data is never touched.
- **Gate lock:** the contract suite **wipes** the smoke account when it starts. The
  capture script must hold `acquireGateLock` (`tests/smoke/fixture/gate-lock.ts`) for
  the whole run, and must send every API call through `fetchWithRateLimitRetry`
  (`tests/smoke/fixture/api.ts`). Writes are capped at 60/min. Chat is capped at 20 turns/min
  (`chat()` in `tests/acceptance/driver.ts` already waits out the limit).
- **Clean start:** reset the smoke account (`tests/smoke/fixture/reset.ts`), then
  run the setup in §3. Clean up at the end (chapter 10).
- **Browser:** the pre-installed Playwright Chromium.
  - Desktop: 1440×900 at `deviceScaleFactor: 2`.
  - Mobile: Playwright's `iPhone 14` device, for the shots marked **M** below.
  - Light theme. The clock is frozen at **2026-11-18 10:00 local**
    (`page.clock.setFixedTime`) so dates and "next due" values match this plan.
- **Repeatable:** the whole capture is one script (`scripts/tutorial/capture-liabilities.ts`,
  built in phase 2). Running it again produces the same screenshots and the same checklist.

## 3. Test data

### 3.1 Created before the tutorial starts (setup, no tutorial screenshots)
Each of these is created explicitly by the setup script through the API. A person profile
is created only on explicit request (CLAUDE.md rule 13), and the setup script is that request.

| Record | Type | Why |
|---|---|---|
| **2022 Honda Civic** | Vehicle asset, value $21,000 | Collateral for the manual auto loan |
| **742 Evergreen Terrace** | Property asset, value $480,000 | Collateral for the chat mortgage |
| **Jamie Lee** | Person | Co-owner and co-signer in the ownership and chat steps |

### 3.2 Created during the tutorial
| ID | Name | How | Values |
|---|---|---|---|
| **A** | Honda Civic Loan | Manual, Auto Loan | Lender Capital One Auto · Loan # 4417 · Original $28,000 · Current $22,450 · 6.9% · 60 months · start 2025-03-15 · monthly $553.12 |
| **B** | Chase Sapphire | Manual, Credit Card | Card name Chase Sapphire Preferred · Issuer Chase · last 4 4821 · limit $15,000 · balance $3,200 · APR 24.99% · min $95 · due day 12 |
| **C** | Verizon Phone Plan | Manual, Phone Plan (recurring bill) | Carrier Verizon · monthly $85 · monthly frequency · start 2026-01-05 |
| **D** | Wells Fargo Mortgage | Chat | "original $350,000, current $312,400, 6.25% fixed, 30 years, first payment 2022-07-01, $2,155/month due on the 1st, on 742 Evergreen Terrace" |
| **E** | Discover It Card | Chat | "$8,000 limit, $1,250 balance, 22.9% APR, $40 minimum due on the 20th" |

## 4. Screenshot conventions

- **One click, two shots:**
  - `…-a` is taken **before** the click. It has a 3px red ring and a numbered badge drawn
    on the click target, so the reader sees exactly where to click.
  - `…-b` is taken **after** the click, once the UI has settled (network idle, plus waiting
    for the step's expected element).
- **Typing:** one shot of the filled form (`…-f`) just before submit.
- **Long panels:** an extra full-page shot (`…-full`) for tabs taller than the viewport.
- **Toasts:** they must be visible in the `-b` shot. The script screenshots as soon as
  the toast appears.
- **File name:** `L<chapter>.<step>-<slug>-<a|b|f|full>.png`, for example
  `L2.07-submit-auto-loan-b.png`. Mobile copies go under `screenshots/mobile/` with the
  same name.
- **Overlay:** the ring and badge are a `position:fixed` div added before the shot and
  removed after it. They are never part of the app.
- **Privacy:** only the smoke account and the fictional data in §3 appear in shots.

Shot count estimate: about **150 desktop + 30 mobile**.

---

## 5. Walkthrough: steps, click targets, screenshots, checks

Column **Verify** names the checklist item (`V-…`) that must pass before the
script moves on. A failed check stops the run, takes a `-FAIL.png` and records the
API response.

### Chapter 0: Baseline (before any liability exists)
| Step | Action | Click target | Shots | Verify |
|---|---|---|---|---|
| 0.01 | Open Dashboard and note Net worth and the Liabilities total | `/dashboard` | `L0.01-dashboard-baseline-b` **M** | V-0.1 |
| 0.02 | Open Finance: the balance sheet and Liabilities card are empty | `/finance` | `L0.02-finance-baseline-b` | V-0.1 |
| 0.03 | Open Liabilities: the empty state | `/linked?tab=liabilities` | `L0.03-liabilities-empty-b` **M** | V-0.2 |
| 0.04 | Open Calendar for this month: no loan due dates | `/calendar` | `L0.04-calendar-baseline-b` | V-0.3 |

### Chapter 1: Finding the Add Liability button (three entry points)
| Step | Action | Click target | Shots | Verify |
|---|---|---|---|---|
| 1.01 | Liabilities tab, then `+` | `button-create-liability` | `a`, `b` (type picker titled "Add Liability") | dialog open |
| 1.02 | Cancel | `btn-cancel-create-profile` | `a` | dialog closed |
| 1.03 | All tab, then `+`, then **Liability** | `button-create-menu` → `menu-add-liability` | `a`, `b` (menu), `b2` (dialog) | dialog open |
| 1.04 | Cancel, then use the floating `+` and the **Loan** tile | FAB → loan tile | `a`, `b` ("Add loan") **M** | dialog open |
| 1.05 | Empty-state button | `btn-empty-add-liability` | `a`, `b` | dialog open |

### Chapter 2: Add an auto loan manually (Liability A)
| Step | Action | Click target | Shots | Verify |
|---|---|---|---|---|
| 2.01 | Open the dialog from the Liabilities tab | `button-create-liability` | `a`, `b` | |
| 2.02 | Show the type list (scroll the full list once for the reader) | | `L2.02-type-list-full` | all types in §1.2 present (V-2.0) |
| 2.03 | Select **Auto Loan** | type card "Auto Loan" | `a`, `b` (card highlighted) | Next enabled |
| 2.04 | Next | `btn-next-create-profile` | `a`, `b` ("Create Profile · Auto Loan") | |
| 2.05 | **Required-field check:** enter only the name and submit | `btn-submit-create-profile` | `a`, `b` (toast "Fill in the required fields", fields outlined) | nothing created (V-2.1) |
| 2.06 | Fill every field from §3.2 A, plus tags `car` and a note | `input-profile-name` + dynamic fields | `f` (top), `f2` (scrolled) | |
| 2.07 | Create | `btn-submit-create-profile` | `a`, `b` (toast `"Honda Civic Loan" profile created`) | V-2.2 |
| 2.08 | The new card in the Liabilities list (balance, subtype chip) | | `b` **M** | V-2.3 |
| 2.09 | **Duplicate guard:** add a second "Honda Civic Loan" | dialog | `b` (duplicate warning) | warning shown, no second row (V-2.4) |
| 2.10 | Cancel the duplicate | | `b` | |

### Chapter 3: Add a credit card manually (Liability B)
| Step | Action | Click target | Shots | Verify |
|---|---|---|---|---|
| 3.01 | `+` → Credit Card → Next | as in 2.01–2.04 | `a`/`b` for each click | |
| 3.02 | Fill the §3.2 B values | form | `f` | |
| 3.03 | Create | `btn-submit-create-profile` | `a`, `b` | V-3.1 |
| 3.04 | Open the card: utilization appears in the dynamic overview | card → page | `b`, `full` | V-3.2 (utilization 21.3%) |

### Chapter 4: Add a recurring bill manually (Liability C)
| Step | Action | Click target | Shots | Verify |
|---|---|---|---|---|
| 4.01 | `+` → Phone Plan → Next | | `a`/`b` | |
| 4.02 | Fill the §3.2 C values → Create | | `f`, `a`, `b` | V-4.1 |
| 4.03 | Open it. It shows bill-style KPIs, with no payoff or amortization | | `b` | V-4.2 (no `payoff-outlook`, no `amort-table`) |

### Chapter 5: Tour of the liability page, every feature (Liability A)
| Step | Action | Click target | Shots | Verify |
|---|---|---|---|---|
| 5.01 | Open Honda Civic Loan from the list | card | `a`, `b`, `full` **M** | header values = §3.2 A (V-5.1) |
| 5.02 | Payoff Outlook: payoff date, interest left, chart | `payoff-outlook` | `b` (zoomed crop) | V-5.2 (matches amortization) |
| 5.03 | AI summary loads; click refresh | `liability-ai-refresh` | `a`, `b` | summary text not empty |
| 5.04 | **Link asset:** toggle, pick 2022 Honda Civic, role Collateral, confirm | `link-asset-toggle` → `link-asset-select` → `link-asset-role-select` → `link-asset-confirm` | `a`/`b` for each (4 pairs) | V-5.3 |
| 5.05 | Open the asset from the link and check the loan appears on the vehicle's Liabilities tab | `button-open-asset-*` | `a`, `b` | V-5.3b |
| 5.06 | Back to the loan (Back to Liabilities, then the card) | | `b` | |
| 5.07 | **Ownership:** add Jamie Lee, split evenly, save | `owner-add-select` → `owner-split-evenly` → `owner-save` | `a`/`b` for each | V-5.4 (50/50, total 100%) |
| 5.08 | Ownership history | `owner-history-toggle` | `a`, `b` | history row present |
| 5.09 | **Linked people:** add Jamie Lee as co-signer | `link-party-toggle` → select → role → `link-party-confirm` | `a`/`b` for each | V-5.5 |
| 5.10 | Quick actions card (all four) | | `b` | |
| 5.11 | **Pay minimum:** the dialog prefills $553.12 → Submit | `action-min` → `payment-submit` | `a`, `b` (dialog), `f`, `b2` (toast) | V-5.6 balance drops by the principal portion |
| 5.12 | **Extra principal:** prefill $100 → Submit | `action-extra` → `payment-submit` | `a`, `b`, `b2` | V-5.7 |
| 5.13 | **Pay custom:** $250, with a date and a note | `action-custom` → `payment-amount-input`, `payment-date-input`, `payment-notes-input` → submit | `a`, `f`, `b` | V-5.8 |
| 5.14 | **Interest only:** open, show the prefill, cancel | `action-interest` | `a`, `b` | no write |
| 5.15 | Cost of borrowing, Schedule and Recent payments update | | `b` | totals = sum of 5.11–5.13 (V-5.9) |
| 5.16 | **Nested liability:** add "Extended warranty", $1,800 | `btn-add-nested-liability` → `input-child-name`, `input-child-balance`, `select-child-subtype` → `btn-create-child-liability` | `a`, `f`, `b` | V-5.10 |
| 5.17 | **Details tab** | `tab-details` | `a`, `b` | |
| 5.18 | **Edit loan terms:** set due day 15 and first payment 2025-04-15, change the rate to 6.5 | `button-edit-terms` → inputs → `button-save-terms` | `a`, `f`, `b` (toast "Loan terms saved") | V-5.11 |
| 5.19 | **Cancel an edit:** open, change, Cancel, check nothing changed | `button-cancel-terms-edit` | `a`, `b` | V-5.12 |
| 5.20 | **Payments tab:** schedule, history, calculator, chart, amortization | `tab-payments` | `a`, `b`, `full` | |
| 5.21 | Schedule: Pay on the next occurrence | `occ-pay-<date>` | `a`, `b` | V-5.13 |
| 5.22 | Schedule: Skip an occurrence (as a hidden alert, not a date change) | `occ-skip-<date>` | `a`, `b` | V-5.14 |
| 5.23 | Payment history: reverse the $250 custom payment | `reverse-payment-*` (two taps) | `a`, `a2` (armed), `b` | V-5.15 |
| 5.24 | **Payoff calculator:** extra $200/mo, then lump $2,000, then target 36 months | `calc-extra-input`, `calc-lump-input`, `calc-target-input` | `f` for each, plus `calc-impact` crop | V-5.16 (months/interest saved shown) |
| 5.25 | Amortization table (scroll) | `amort-table` | `full` | first row due 2026-12-15 |
| 5.26 | **Docs tab:** upload `fixtures/sample-auto-loan-statement.pdf` | `tab-documents` → `liability-doc-upload` | `a`, `b` | V-5.17 |
| 5.27 | View and delete the document (two taps) | `liability-doc-view-*`, `liability-doc-delete-*` | `a`, `b`, `a`, `b` | V-5.18 |
| 5.28 | **Activity tab** | `tab-activity` | `a`, `b` | the payments, link and edit show up (V-5.19) |
| 5.29 | **History tab** | `tab-history` | `a`, `b` | rate 6.9→6.5 change listed (V-5.20) |
| 5.30 | **Header Edit:** rename to "Honda Civic Auto Loan", add a note | `button-header-edit-profile` → `input-edit-name`, `input-edit-notes` → `button-save-edit-profile` | `a`, `f`, `b` | V-5.21 |
| 5.31 | **Avatar:** upload `fixtures/car.png` | avatar | `a`, `b` | avatar shown |
| 5.32 | Header **Pay** button (same dialog as Pay minimum) → cancel | `quick-pay-min` | `a`, `b` | |

### Chapter 6: Bill features (Liability C, Verizon Phone Plan)
| Step | Action | Click target | Shots | Verify |
|---|---|---|---|---|
| 6.01 | Details: Bill details card | `tab-details` | `b` | |
| 6.02 | Edit the bill: reminder 3 days, autopay on | `button-edit-bill` → `input-bill-reminder`, `switch-bill-autopay` → `button-save-bill` | `a`, `f`, `b` | V-6.1 |
| 6.03 | Payments: the bill schedule with the mini calendar | `tab-payments`, `btn-toggle-calendar` | `a`, `b` | |
| 6.04 | Pay this month's occurrence | `occ-pay-<date>` | `a`, `b` | V-6.2 |
| 6.05 | Add an extra charge (overage, $12) to the next occurrence | `occ-charge-kind-*`, `occ-charge-amount-*`, `occ-charge-add-*` | `a`, `f`, `b` | V-6.3 |
| 6.06 | Pause, then resume, the bill | `btn-pause` → `btn-resume` | `a`, `b`, `a`, `b` | V-6.4 |
| 6.07 | Schedule filters | `filter-*` | `a`, `b` | |

### Chapter 7: Add and manage liabilities through the chat
Each turn gets these shots:
- `a`: the typed message with the Send button highlighted.
- `b`: the assistant reply plus the action receipt card.
- `c`: the record on its page, as proof.

The reply is AI-generated and its wording changes from run to run, so **every chat step is
verified through the API, not by reading the text.** The script saves each reply's text to
`chat-transcript.md`.

| Step | Message typed (`input-chat` → `button-send`) | Expected tool | Shots | Verify |
|---|---|---|---|---|
| 7.01 | Open the chat | `/chat` | `b` **M** | |
| 7.02 | "I have a mortgage with Wells Fargo on 742 Evergreen Terrace. Original loan $350,000, current balance $312,400, 6.25% fixed, 30 years, first payment was July 1 2022, $2,155 a month due on the 1st." | `create_liability` (+ asset link) | `a`, `b`, `c` **M** | V-7.1 (subtype mortgage, all values, linked to 742 Evergreen Terrace) |
| 7.03 | Open the mortgage page from the receipt card or the list | receipt link | `a`, `b`, `full` | V-7.2 payoff outlook drawn |
| 7.04 | Check Calendar: a due date on the 1st of each month | `/calendar` | `b` | V-7.3 |
| 7.05 | "Opened a Discover It card, $8,000 limit, $1,250 balance, 22.9% APR, $40 minimum due on the 20th." | `create_liability` (credit_card) | `a`, `b`, `c` | V-7.4 |
| 7.06 | "I paid this month's mortgage payment, $300 of it went to escrow." | `add_liability_payment` | `a`, `b`, `c` (Payments tab) | V-7.5 |
| 7.07 | "Sent $1,000 extra to principal on the mortgage." | `add_liability_payment` (extra_principal) | `a`, `b`, `c` | V-7.6 |
| 7.08 | "Paid $500 on my Chase Sapphire." (the card created manually) | `add_liability_payment` | `a`, `b`, `c` | V-7.7 (Chase balance $2,700; Discover unchanged) |
| 7.09 | "Jamie Lee and I split the mortgage 50/50." | `link_liability_owner` | `a`, `b`, `c` (Ownership card) | V-7.8 |
| 7.10 | "How much do I still owe on the mortgage and when will it be paid off?" | `get_liability_summary` (read only) | `a`, `b` | V-7.9: the numbers in the reply = the page's numbers, and nothing was written |
| 7.11 | "I refinanced the mortgage at 5.5%, new balance $305,000, 30 years." | `update_liability` (refinance) | `a`, `b`, `c` (History tab) | V-7.10 |
| 7.12 | "Delete that $1,000 extra payment on the mortgage." | `delete_liability_payment` | `a`, `b`, `c` | V-7.11 |
| 7.13 | **Safety check:** "The Discover card is annoying." (no request to delete) | none | `a`, `b` | V-7.12: the card still exists |
| 7.14 | "Delete my Discover It card." | `delete_profile` | `a`, `b`, `c` (gone from the list) | V-7.13 |

### Chapter 8: Changes show up across the app
| Step | Action | Click target | Shots | Verify |
|---|---|---|---|---|
| 8.01 | Liabilities list with A, B, C, D | `/linked?tab=liabilities` | `b` **M** | V-8.1 |
| 8.02 | Category chip **Mortgage**: only D shows, with the filter notice | chip | `a`, `b` | V-8.2 (filter notice shown, never "No liabilities yet") |
| 8.03 | Clear the chip | | `a`, `b` | |
| 8.04 | Profile scope set to Jamie Lee: only co-owned liabilities show, and the notice names Jamie | scope control | `a`, `b` | V-8.3 |
| 8.05 | Show everyone again | | `a`, `b` | |
| 8.06 | Dashboard: Net worth and the Liabilities total changed by exactly the sum of the balances | `/dashboard` | `b` **M** | V-8.4 |
| 8.07 | Finance: the Liabilities card lists every liability, and the totals match the dashboard | `/finance` | `b`, `full` | V-8.5 |
| 8.08 | Calendar: the loan (15th), card (12th), phone (5th) and mortgage (1st) due dates | `/calendar` | `b` **M** | V-8.6 |
| 8.09 | Search (Cmd-K) "Honda", then open the result | command search | `a`, `b` | V-8.7 |
| 8.10 | Reload the page (hard refresh): every value persists | | `b` | V-8.8 |

### Chapter 9: Delete a liability manually
| Step | Action | Click target | Shots | Verify |
|---|---|---|---|---|
| 9.01 | Open Chase Sapphire → Delete | `button-delete-profile` | `a`, `b` (confirm dialog) | |
| 9.02 | Cancel first: the record is still there | `button-cancel-delete-profile` | `a`, `b` | V-9.1 |
| 9.03 | Delete → Confirm | `button-confirm-delete-profile` | `a`, `b` (toast, back on the list) | V-9.2 |
| 9.04 | Dashboard, Finance and Calendar no longer include it | | `b` × 3 | V-9.3 |

### Chapter 10: Cleanup (no tutorial screenshots)
Delete A, C, D and the setup records through the API, then confirm the smoke account
is back to its baseline totals (V-10.1). Then release the gate lock.

### Chapter 11: Appendix (one shot each)
Filled form for Mortgage, Student Loan, Personal Loan, HELOC, Business Loan, Medical
Debt, Tax Debt, Boat Loan, RV Loan, Internet, Utility, Streaming (`f` only, then Cancel;
nothing is created).

---

## 6. Phases and deliverables

| Phase | Work | Output |
|---|---|---|
| **1. Plan** (this) | Feature inventory, script, data, checks, template | `PLAN.md`, `VERIFICATION_CHECKLIST.md`, `TUTORIAL_TEMPLATE.md` |
| **2. Capture tooling** | `scripts/tutorial/capture-liabilities.ts`. It handles the gate lock, the clock freeze, the highlight overlay, a `shoot(id)` helper and a `verify(id)` helper that calls the API. It also adds fixtures: `sample-auto-loan-statement.pdf` and `car.png` | script and fixtures, dry run on chapter 0–2 |
| **3. Full run** | Run all chapters on desktop, then the **M** shots on mobile | `screenshots/`, filled checklist, `chat-transcript.md` |
| **4. Fix or file** | Every failed `V-` item is either fixed (with a regression test, per CLAUDE.md) or recorded as a known issue before the tutorial ships | issues list |
| **5. Assemble** | Fill `TUTORIAL_TEMPLATE.md` → `TUTORIAL.md`. Optionally export a PDF and/or a shareable page | final tutorial |

**Done means:** every V- item is PASS (or documented as a known issue), every shot ID in
§5 exists for desktop, every **M** shot exists for mobile, and a second run produces the
same checklist.

## 7. Risks and how the plan handles them
| Risk | Handling |
|---|---|
| The AI picks a different tool or words things differently | Verify through the API, not the text. If the API check fails, try one rephrasing and record both attempts. A second failure is a real bug |
| The contract suite wipes the account mid-run | Hold the gate lock for the whole run |
| Rate limits (60 writes/min, 20 chat turns/min) | `fetchWithRateLimitRetry`, and `chat()` waits out the limit |
| Date-dependent values ("next due") | Freeze the browser clock. Expected dates in the checklist are computed from 2026-11-18 |
| Animations or loading in shots | Wait for each step's expected element and network idle, then `animations: "disabled"` |
| Production deploy changes the UI mid-run | Record `/api/version` sha at the start and end. If they differ, run again |

## 8. Gaps found while planning (to handle in phase 4)
- **No test creates a liability through chat in natural language.** The acceptance
  suite only sends scripted tool directives. Chapter 7 becomes the first one.
  Recommendation: turn 7.02 / 7.05 / 7.06 into a permanent live scenario.
- **The acceptance suite's `create_liability` directives use the wrong field names.**
  `tests/acceptance/matrix.ts:70-75` and `tests/acceptance/suites.ts:118,120,196` pass
  `amount` / `liabilityType`, which are not fields in the tool schema (it expects
  `currentBalance` / `subtype`). Those tests create liabilities with no balance,
  so they can't catch balance bugs.
- The document-review Confirm/Skip buttons have no `data-testid`. That doesn't matter
  for this tutorial (typed chat messages don't use them), but it would matter for a future
  "upload a loan statement" chapter.
