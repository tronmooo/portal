// client/src/lib/dev-affordances.ts
//
// One predicate for "should this build show developer/QA-only controls?".
//
// QA report 2026-07-29 (UX-002): the production dashboard's ⋯ menu offered
// "Show test data" to every signed-in user. Flipping it on mixes synthetic
// suite-generated rows into a real person's money and health data with no
// visual distinction — the reader has no way to know which numbers are real.
// "Refresh from ChatGPT" (a bulk re-import) sits next to it and is likewise a
// migration tool, not an everyday action.
//
// Enabled when EITHER:
//   - this is a dev build (`import.meta.env.DEV`), or
//   - the user has explicitly opted in for this browser:
//       localStorage.setItem("portol_dev_tools", "1")
//     or a one-time `?devtools=1` in the URL, which sets the same key.
//
// Export Data / Import Backup stay in the menu unconditionally: data
// portability is a real user feature, not a dev affordance.

const KEY = "portol_dev_tools";

function optedIn(): boolean {
  try {
    // `?devtools=1` is a durable opt-in so a maintainer can turn the tools on
    // for one browser without a rebuild; `?devtools=0` turns them back off.
    const q = new URL(window.location.href).searchParams.get("devtools");
    if (q === "1") localStorage.setItem(KEY, "1");
    else if (q === "0") localStorage.removeItem(KEY);
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** True when developer/QA-only controls may be rendered. */
export function devToolsEnabled(): boolean {
  try {
    if (import.meta.env?.DEV) return true;
  } catch { /* non-Vite host (tests) */ }
  return optedIn();
}
