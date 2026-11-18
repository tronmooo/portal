# Liabilities tutorial: verification checklist

Filled in by the capture run (phase 3). Each item has three parts:
- **UI:** what the screenshot must show.
- **API:** what the stored data must say.
- **Result:** PASS, FAIL, or KNOWN (a documented known issue).

Every API read uses `fetchWithRateLimitRetry` as the smoke account. A screen that
looks right while the data is wrong counts as **FAIL**.

Every API check reads the field strictly. If the field is missing, that is a FAIL, not
a pass (CLAUDE.md, "Writing tests").

Endpoints used:
- `GET /api/profiles` and `GET /api/profiles/:id`
- `GET /api/liabilities`
- `GET /api/liabilities/:id/payments`, `/assets`, `/parties`
- `GET /api/liability-profile-links`
- `GET /api/profiles/:id/documents`
- `GET /api/events`
- `GET /api/dashboard-enhanced`
- `GET /api/version`

Run header (filled automatically):

| Field | Value |
|---|---|
| Run date | |
| `/api/version` sha at start / end | |
| Frozen clock | 2026-11-18 10:00 |
| Viewports | desktop 1440×900@2, iPhone 14 |
| Result | __ PASS / __ FAIL / __ KNOWN |

---

## Chapter 0: Baseline
| ID | UI | API | Result |
|---|---|---|---|
| V-0.1 | The Dashboard and Finance liabilities totals are recorded | `dashboard-enhanced` liabilities total = sum of the liability balances in `/api/liabilities` (expected 0 after reset). Net worth stored as **NW0** | |
| V-0.2 | Empty state shows an add button. If a scope is active it shows the scope notice, never a bare "No liabilities yet" | `/api/liabilities` is empty | |
| V-0.3 | No loan due dates in the calendar | `/api/events` has no liability obligations | |

## Chapter 2: Manual auto loan (A)
| ID | UI | API | Result |
|---|---|---|---|
| V-2.0 | The type list contains all 11 liability types plus the bill types | `/api/profile-types` liabilities category = 11 types | |
| V-2.1 | Toast "Fill in the required fields" lists Lender, Original Loan Amount, Current Balance, Interest Rate, Loan Term, Loan Start Date | No new profile in `/api/profiles` | |
| V-2.2 | Toast `"Honda Civic Loan" profile created` | Exactly one profile named Honda Civic Loan, type `liability`, subtype auto loan. Fields: lender Capital One Auto, original 28000, current 22450, rate 6.9% (stored as 0.069 or 6.9; record which), term 60, start 2025-03-15, monthly 553.12. Tags include `car` | |
| V-2.3 | The list card shows $22,450 and the Auto loan chip | The balance on the card = the canonical balance (`readBalance`, `shared/liability-fields.ts`) of the row in `/api/liabilities` | |
| V-2.4 | Duplicate warning names the existing record | Still exactly one Honda Civic Loan | |

## Chapter 3: Manual credit card (B)
| ID | UI | API | Result |
|---|---|---|---|
| V-3.1 | Created toast | Chase Sapphire: limit 15000, balance 3200, APR 24.99, min 95, due day 12, last 4 4821 | |
| V-3.2 | Utilization ≈ 21.3% | 3200 / 15000 = 0.2133 | |

## Chapter 4: Manual recurring bill (C)
| ID | UI | API | Result |
|---|---|---|---|
| V-4.1 | Created toast | Verizon Phone Plan: amount 85, monthly, start 2026-01-05 | |
| V-4.2 | Bill KPIs only. No Payoff Outlook, amortization, Cost of borrowing or Quick actions | (UI-only: those testids are absent) | |

## Chapter 5: Liability page tour (A)
| ID | UI | API | Result |
|---|---|---|---|
| V-5.1 | Header: name, Auto loan pill, "Capital One Auto", balance $22,450 | Matches V-2.2 | |
| V-5.2 | The payoff date and interest left in Payoff Outlook = the Schedule card and the last amortization row | The page uses one schedule: compare the three values in the DOM | |
| V-5.3 | Linked assets lists 2022 Honda Civic (Collateral) | `/api/liabilities/:A/assets` has the Civic with role collateral | |
| V-5.3b | The Civic's Liabilities tab shows the loan, with balance and monthly badges | Same link, seen from the asset | |
| V-5.4 | Ownership: you 50% · Jamie Lee 50%, total 100% | `/api/liability-profile-links` for A: two owners, pct 50/50 | |
| V-5.5 | Linked people shows Jamie Lee, co-signer | `/api/liabilities/:A/parties` has Jamie with role co_signer | |
| V-5.6 | Toast. Balance drops by the principal part of $553.12 | One new payment of 553.12 in `/payments`. `currentBalance` decreased by `remainingBalanceAfter` math (principal > 0) | |
| V-5.7 | Balance drops by exactly $100 | Payment of 100, type extra principal, all principal | |
| V-5.8 | Payment row shows $250, the date and the note | Payment of 250 with that date and note | |
| V-5.9 | "Total payments made" = $903.12 | Sum of `/payments` = 903.12 | |
| V-5.10 | Nested liabilities lists "Extended warranty $1,800" | Child liability whose parent is A, balance 1800 | |
| V-5.11 | Toast "Loan terms saved". Rate shows 6.5%, due day 15 | Profile fields: rate 6.5%, dueDay 15, firstPaymentDate 2025-04-15. A recurring obligation on the 15th exists in `/api/events` | |
| V-5.12 | After Cancel the values are unchanged | Profile `updatedAt` unchanged | |
| V-5.13 | The occurrence shows Paid | A payment is recorded for that occurrence date | |
| V-5.14 | The occurrence shows Skipped | The record's due date and `firstPaymentDate` are **unchanged** (a skip never moves real dates, rule 8) | |
| V-5.15 | Reverse needs two taps (armed state seen in the `a2` shot). The row then shows as reversed | Reversal recorded and the balance restored by 250 | |
| V-5.16 | The calculator shows months saved and interest saved for each input | (UI only. Values must be > 0 and get smaller as the target months increase) | |
| V-5.17 | Document appears in the list | `/api/profiles/:A/documents` has 1 document | |
| V-5.18 | Delete needs two taps. The list is empty afterwards | 0 documents | |
| V-5.19 | Activity shows the payments, the asset link, the owner change and the terms edit | | |
| V-5.20 | History lists the rate change 6.9 → 6.5 | | |
| V-5.21 | Title "Honda Civic Auto Loan". The note is saved | name and notes updated. Still exactly one profile (renamed, not duplicated) | |

## Chapter 6: Bill (C)
| ID | UI | API | Result |
|---|---|---|---|
| V-6.1 | Reminder "3 days before", Autopay On | reminder 3, autopay true | |
| V-6.2 | This month's occurrence shows Paid | Payment recorded at 85 | |
| V-6.3 | The next occurrence shows $97 ($85 + $12 overage) | Charge stored on that occurrence | |
| V-6.4 | After pause: a paused badge and no upcoming occurrences. After resume they are back | Paused flag toggles. The calendar obligation follows it | |

## Chapter 7: Chat
For every row, the script checks that the chat reply is not an error, and the
receipt card is shown. **No 429 / "Too many requests" bubble is allowed to count as a step.**

| ID | UI | API | Result |
|---|---|---|---|
| V-7.1 | Receipt card for a new liability | One liability "…Mortgage…" with subtype mortgage, lender Wells Fargo, original 350000, current 312400, rate 6.25%, term 360, firstPaymentDate 2022-07-01, monthly 2155, dueDay 1. Linked to the 742 Evergreen Terrace asset. **No new person or asset profile was created** (rule 13) | |
| V-7.2 | Payoff Outlook drawn on the mortgage page | | |
| V-7.3 | Calendar shows a mortgage due date on Dec 1 2026 | A recurring obligation with day 1 in `/api/events` | |
| V-7.4 | Receipt card | Discover It: credit card, limit 8000, balance 1250, APR 22.9, min 40, dueDay 20 | |
| V-7.5 | The mortgage Payments tab shows a payment with escrow $300 | Payment of 2155 with escrow 300 on the **mortgage** (not another liability) | |
| V-7.6 | Balance drops by $1,000 | Payment of 1000, extra principal | |
| V-7.7 | Chase Sapphire balance $2,700 | Payment of 500 on **Chase Sapphire**. The Discover balance is still 1250 (the right card was paid) | |
| V-7.8 | Mortgage ownership 50/50 with Jamie Lee | Two owner links at 50/50. Jamie is the existing profile; no second Jamie was created | |
| V-7.9 | The balance and payoff date in the reply = the mortgage page | **No write:** the profile count and every `updatedAt` unchanged | |
| V-7.10 | History shows the refinance | rate 5.5%, balance 305000, term 360 | |
| V-7.11 | The $1,000 payment is gone from the history | Payment removed. Balance restored by 1000 | |
| V-7.12 | Assistant does not delete | The Discover It card still exists | |
| V-7.13 | Discover It is gone from the list | Profile deleted. Its calendar obligation is gone from `/api/events` | |

## Chapter 8: Changes show up across the app
| ID | UI | API | Result |
|---|---|---|---|
| V-8.1 | The list shows Honda Civic Auto Loan, Chase Sapphire, Verizon Phone Plan and Wells Fargo Mortgage (plus the nested warranty, if listed) | `/api/liabilities` matches | |
| V-8.2 | With the Mortgage chip on, only the mortgage shows, and the filter notice says others are hidden | (rule 4) | |
| V-8.3 | Scope set to Jamie shows the Honda loan and the mortgage. The chip reads "Jamie Lee" (never "Everyone") and the notice offers "Show everyone" | | |
| V-8.4 | The Dashboard liabilities total = the sum of the balances. Net worth = NW0 + setup assets − liabilities | `computeNetWorth` result in `dashboard-enhanced` = the numbers on screen | |
| V-8.5 | The Finance Liabilities card and totals = the Dashboard | Same payload | |
| V-8.6 | Calendar shows due dates on the 15th (Honda), 12th (Chase), 5th (Verizon) and 1st (mortgage) | Obligations in `/api/events` | |
| V-8.7 | Search finds "Honda Civic Auto Loan" and opens its page | | |
| V-8.8 | After a hard refresh every value above is unchanged | | |

## Chapter 9: Manual delete
| ID | UI | API | Result |
|---|---|---|---|
| V-9.1 | Cancel keeps the record | Chase Sapphire still exists | |
| V-9.2 | Toast. Back on the list without Chase | Profile deleted, along with its payments and links | |
| V-9.3 | Dashboard, Finance and Calendar no longer include it | Totals drop by 2700. Its obligation is gone | |

## Chapter 10: Cleanup
| ID | UI | API | Result |
|---|---|---|---|
| V-10.1 | n/a | `/api/liabilities` is empty, the setup records are deleted, and net worth = NW0 | |

---

## Failures log
| V-ID | What was seen | API response (excerpt) | Screenshot | Follow-up (fix + test / known issue) |
|---|---|---|---|---|
| | | | | |
