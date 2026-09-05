# Financial Assets — the universal account layer

**Status:** authoritative for every surface that touches a money-holding account.
**Code:** `shared/account-kinds.ts`, `shared/financial-assets.ts`, `shared/financial-reconcile.ts`,
`shared/balance-snapshots.ts`, `server/financial-asset-sync.ts`,
`client/src/components/finance/FinancialAssetOverview.tsx`.
**Tests:** `tests/financial-assets.test.ts`, `tests/finance-accounts.test.ts`, `tests/account-profile.dom.test.tsx`.

## The principle

> Any account whose primary purpose is to hold, preserve, or invest monetary value represents an
> **asset** and receives a canonical **Asset Profile**. **Income** describes money entering the
> user's financial system; it is not itself an asset. Each asset subtype may define its own data
> capabilities, history model, and adaptive interface while remaining part of the same global asset
> and net-worth system.

Money-holding accounts are assets. Money-flow sources are not.

| Thing | Is | Record |
|---|---|---|
| Checking, savings, money market, CD, cash | asset | account profile, kind in the cash group |
| Brokerage, IRA / 401(k), HSA, 529, generic investment | asset | account profile, kind in the investment group |
| Crypto wallet / exchange account | asset | account profile, kind `crypto` |
| Credit card, line of credit, loan account, mortgage | liability | account profile (debt side) or liability profile |
| Salary, paycheck, bonus, freelance, reimbursement | income | `log_income` / incomes table |
| A balance, a statement, a holding, a buy/sell, a dividend | activity **inside** an asset | snapshot / holding / activity row on the existing profile |

## One profile per real account

An account **is** a `type: "account"` (or legacy `type: "investment"`) profile. That is what gives it
net worth, ownership shares, the profile filter, nesting under a person, linked documents and
expenses, search, and the chat's entity resolution for free. There is no parallel accounts table.

The profile's `fields` carry the account model:

| key | owner | meaning |
|---|---|---|
| `accountKind` | account-kinds | the subtype (`checking` … `crypto`); decides side, group, layout, capabilities |
| `balance`, `currentBalance`, `currentValue` | finance-accounts | current value, positive magnitude, mirrored so every resolver agrees |
| `balanceAsOf` | finance-accounts | the day the balance was last true |
| `balanceHistory` | finance-accounts | the **adjustment ledger** — why the balance moved (before/after/reason/source) |
| `balanceSnapshots` | financial-assets | the **observation series** — what the balance was on each day, from every source |
| `holdings` | financial-assets | positions with symbol / quantity / price / value / cost basis / asset class |
| `investmentActivity` | financial-assets | contributions, withdrawals, buys, sells, dividends, interest, fees, transfer legs |
| `fieldSources` | financial-assets | provenance per field: which source wrote it and when |
| `connection` | financial-assets | the live source link (provider, connected row id, status, last sync) |
| `possibleDuplicateOf` | financial-asset-sync | a medium-confidence match the sync could not decide; the profile page asks |

Those data keys are hidden from the generic field list and the composed Overview
(`FINANCIAL_DATA_KEYS`, `overview-semantics.ADMIN_EXACT`, `profile-detail.ACCOUNT_CARD_KEYS`).

## Classification from context

`classifyAccountKind({ hint, name, institution, description, providerCategory })` decides the kind
with a confidence:

1. an explicit label that normalizes to a kind (`roth_ira` → retirement) — high
2. a kind word in the name or description ("Bitcoin wallet", "12-month CD") — high / medium
3. an institution whose business is one kind (Fidelity → brokerage, Coinbase → crypto) — medium
4. a provider category (Stripe's `investment` / `credit` / `cash`) — medium / low
5. a plain bank name — checking, low
6. nothing — `other`, none

The chat, the add-account form, the statement import and the bank sync all call it. A debt kind is
never guessed from a bank name alone.

## Capabilities decide the interface

`capabilitiesForKind(kind)` says which data a kind carries. The Overview renders a section only
when the capability exists **and** there is data:

| layout | capabilities |
|---|---|
| bank (checking, savings, money market, CD) | balance, balanceHistory, cashFlow, transactions, interestRate (+ maturity for a CD) |
| cash | balance, balanceHistory, cashFlow |
| investment (investment, brokerage, retirement, HSA, education) | balance, balanceHistory, holdings, allocation, performance, contributions, dividends (+ employerMatch / beneficiaries) |
| crypto | balance, balanceHistory, holdings, allocation, performance, tokenPricing, transfers |
| debt (credit card, line of credit, loan) | balance, balanceHistory, transactions, creditLimit |

`FinancialAssetOverview` dispatches on `accountLayoutOf(profile)`: the investment dashboard
(portfolio value, 1W/1M/3M/YTD/1Y/ALL performance, holdings, allocation, gain/loss, contributions,
dividends, activity), the bank overview (balance, deposits/withdrawals, history), the cash view, or
the debt card. The Assets-tab card (`FinancialAssetCard`) shows institution/kind, balance, the
one-month change and a sparkline.

## Balance history is first-class

`appendBalanceSnapshot` never overwrites. Every balance write appends an observation:

- `applyBalanceAdjustment` (manual, chat, bill payment) — source `user` / `ai` / `payment`
- `recordAccountSnapshot` (bank sync) — source `api`
- a statement's extracted balance (`action-executor.writeFieldsToProfile`) — source `document`
- the ChatGPT / CSV import — source `import`

Same source + same day collapse to the latest point; different sources on one day are both kept.
`balanceSeries` merges snapshots, the adjustment ledger and legacy `performanceHistory` into one
line; `seriesForPeriod` windows it; `changeSince` answers "how much has it grown since January".

## Source-independent model + reconciliation

Every source becomes an `AccountObservation` (`observationFromConnectedAccount`,
`observationFromImportAccount`, `observationFromInput`). `findAccountMatch` scores it against the
user's account profiles on last-four, institution, kind, name words, currency, owner and balance:

- score ≥ 0.75, unambiguous → **link** silently
- 0.5–0.75, or two candidates close together → **confirm** (chat asks; the sync creates the profile
  and records `possibleDuplicateOf` for the page to ask)
- below → **create**

The bank sync (`reconcileConnectedAccountProfiles`) runs after every import: each connected account
gets or matches a profile, `matched_profile_id` is set, `fields.connection` is stamped, and the
balance lands as an `api` observation. The connected view (`shared/finance-calc.ts`) already
de-duplicates a matched profile, so the two net-worth computations agree.

## Provenance and authority

`fieldSources[key] = { source, at, ref }`. `SOURCE_PRIORITY`: api > document > import/payment >
ai/user > system. For the API-owned keys (`balance`, `currentBalance`, `currentValue`,
`availableBalance`, `balanceAsOf`, `holdings`) on an account with a **live** connection, only the
API, the user or a payment may overwrite (`sourceMayOverwrite`); a statement still records its
observation, it just does not roll a live balance back. Every other field: latest write wins,
provenance recorded.

## Net worth

The latest balance of every money-holding account counts as an asset; every debt-kind account
counts as a liability (`isAssetProfile` / `isLiabilityProfile` in `shared/asset-value.ts`). A
transfer between two owned accounts (`recordAccountTransfer`) moves both balances by the same amount
and logs a transfer leg on each — nothing is income or spending, so net worth is unchanged by
construction. A brokerage gain is a balance observation, never income.

## The chat ontology

`FINANCIAL_ONTOLOGY_GUIDANCE` is in the system prompt; `classifyMoneyMention` pins the rules:

| sentence | kind | tool |
|---|---|---|
| "My Schwab account has $34,000" | asset_balance | `create_account` (kind inferred) or `update_account_balance` — appends history |
| "My Fidelity balance dropped to $18,000" | asset_balance | `update_account_balance` — never delete/recreate |
| "My Bitcoin wallet is worth $8,400" | asset_balance | crypto account + snapshot |
| "I earned $2,000 from work" | income | `log_income` — never an asset |
| "Put $500 into Schwab" | transfer | `transfer_between_accounts` (or `record_account_activity` contribution when one side is unknown) |
| "Bought 10 shares of AAPL in Fidelity" | asset_activity | `record_account_activity` buy + `set_holding` |
| "Got a $120 dividend" | asset_activity | `record_account_activity` dividend — income tied to the asset |

`get_account_history` answers "how much has my Fidelity grown since January".

## Deletion and disconnects

- **Disconnecting** a bank feed flips `fields.connection.status` to `disconnected` on each profile
  and keeps the profile with every observation. Deleting connected data deletes the imported rows,
  never the profiles.
- **Deleting** an account profile removes its snapshots, holdings and activity with the row (they
  live inside it), unlinks the connected row and stamps `financial_accounts.profile_unlinked_at` so
  the next sync does not recreate it. Linked documents, expenses and incomes follow the app's
  normal profile-deletion cascade (sole-owner rows go, shared rows are unlinked).
- Unlinking a match by hand (`PATCH /api/finance/accounts/:id { matchedProfileId: null }`) sets the
  same marker; linking one clears it and reconciles immediately.

## Endpoints

| method | path | purpose |
|---|---|---|
| GET | `/api/accounts/:id/history?period=1M` | value series, change over the period, activity + cash-flow summaries |
| GET | `/api/accounts/:id/holdings` | holdings, allocation, gain/loss, biggest positions, capabilities |
| POST | `/api/accounts/:id/holdings` | upsert one position by symbol/name |
| DELETE | `/api/accounts/:id/holdings/:key` | remove a position |
| POST | `/api/accounts/:id/activity` | record contribution / withdrawal / buy / sell / dividend / interest / fee |
| POST | `/api/accounts/transfer` | move money between two owned accounts |
| GET | `/api/accounts/match?name=&institution=&accountKind=&last4=` | "is this the same account?" |

## Phases (what landed, what is next)

1. ✅ classification + universal financial asset model
2. ✅ financial asset profiles + adaptive dashboard cards
3. ✅ first-class balance snapshots + history charts
4. ✅ investment holdings / performance interface (manual + chat; API holdings when a provider supplies them)
5. ✅ normalized adapter model (observations in, one profile model out); Stripe adapter wired
6. ✅ reconciliation across API / documents / import / chat
7. ◻ advanced analytics: returns (TWR/IRR), token pricing feeds, allocation targets, AI insights over the series
