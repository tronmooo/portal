// The account every script that talks to the LIVE app signs in with.
//
// Defaults to the dedicated smoke account (tests/smoke/fixture/account.ts),
// which exists to be written to and reset. Point a run at another account
// through the environment — never a literal in this public repository:
//   LIVE_EMAIL=… LIVE_PASSWORD=… npx tsx tests/ai-chat-quick.ts
// (E2E_EMAIL / E2E_PASSWORD are honoured too, for the existing workflows.)
//
// History (2026-10-09): ten scripts signed in to production as a real user
// with a literal password committed here, and every run created and deleted
// test records inside that person's data. tests/ops-guards.test.ts now fails
// on any such literal.
import { SMOKE_EMAIL, SMOKE_PASSWORD } from "../smoke/fixture/account";

export const LIVE_EMAIL = process.env.LIVE_EMAIL || process.env.E2E_EMAIL || SMOKE_EMAIL;
export const LIVE_PASSWORD = process.env.LIVE_PASSWORD || process.env.E2E_PASSWORD || SMOKE_PASSWORD;
