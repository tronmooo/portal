# Product Quality Audit & Improvement Plan — UX, Performance, Auth, Security

**Date:** 2026-06-10
**Scope:** UI/UX & design, performance & speed, authentication & state, security & privacy.
**Method:** Direct code inspection with file:line evidence plus hard measurements (production bundle sizes from `public/assets`, `npm audit`, CSP/header inspection). This is a plan — no code was changed.

> Note: the four parallel deep-dive agents I launched were terminated mid-run by a platform session-limit event, so every finding below was gathered and verified by direct inspection rather than delegated. Findings are evidence-backed; a few areas flagged "needs deeper sweep" would benefit from a follow-up pass when the limit resets.

---

## 0. Executive summary — the ten things that matter

| # | Finding | Area | Severity |
|---|---|---|---|
| 1 | **16 dependency vulnerabilities (7 high)** — `ws`, `uuid<11`, `exceljs` chain | Security | High |
| 2 | **CSP is declawed** — `script-src` allows `'unsafe-inline' 'unsafe-eval'`, so the policy can't stop injected-script XSS | Security | High |
| 3 | **1.0 MB main JS chunk** loads on every cold start (recharts eager in dashboard, framer-motion, date-fns) | Performance | High |
| 4 | **Service workers are actively unregistered on every load** (`client/index.html`) — zero offline support, zero cross-session asset caching | Performance | Med-High |
| 5 | **Render-blocking fonts from two CDNs** (Google Fonts + Fontshare, 3 families) block first paint | Performance | Med |
| 6 | **No `prefers-reduced-motion` support anywhere** + framer-motion animations — vestibular-accessibility gap | A11y | Med |
| 7 | **Only 6 of 24 pages use Skeleton loaders**; many show blank screens while loading | UX | Med |
| 8 | **`muted-foreground` at 47% lightness** risks failing WCAG AA contrast, especially in dark mode | A11y | Med |
| 9 | **Non-semantic interactive `<div onClick>`** (17+ across dashboard/chat/profile-detail) — keyboard/SR inaccessible | A11y | Med |
| 10 | **`build` has no `drop_console` / explicit minify-target tuning**; 2 stray `console.log` ship to prod | Performance/Polish | Low |

**The strong parts (keep doing this):** auth architecture is genuinely good — server-proxied login (no `supabase-js` on the client), tokens in `sessionStorage` (not `localStorage`), per-IP + per-email rate limiting with Turnstile CAPTCHA support, background refresh 5 min before expiry, origin-based CSRF defense, and per-user query-cache isolation. DOMPurify is correctly applied at all three `dangerouslySetInnerHTML` sites. The heavy editor chunks (UniverSheet 5.4 MB, exceljs, pdfjs) are already lazy-loaded and stripped from cold-load preloads.

---

## 1. UI/UX & Design

### 1.1 Responsive design
- **Mostly responsive**, Tailwind breakpoint-driven. The risk areas are the mega-pages: `profile-detail.tsx` (12k lines), `trackers.tsx` (5.7k), `dashboard.tsx` (4.5k). **Action:** manual device-matrix QA (360px / 768px / 1024px, portrait+landscape) on those three plus `chat.tsx` and `editor.tsx`; the spreadsheet/editor surfaces are the most likely to overflow on phones. *(High-value, needs device pass.)*
- **Touch targets:** 14 components use icon-only buttons (`size="icon"`). Radix's default icon button is 36×36 — **below the 44×44 WCAG 2.5.5 / Apple HIG minimum.** **Action:** bump the icon-button size token to 44px on touch (`@media (pointer: coarse)`), or add a larger hit-area to the shared `ui/button.tsx` icon variant. *(Med.)*

### 1.2 Navigation
- Dual nav (desktop sidebar `app-sidebar.tsx` + mobile `mobile-nav.tsx`) plus `QuickCreateFab.tsx` and `KeyboardShortcuts.tsx`. **Action:** verify every sidebar route has a mobile path (bottom nav typically surfaces 4–5; confirm the rest are reachable via a "More" sheet, not orphaned). *(Med, needs nav-parity check.)*

### 1.3 Dark / light mode
- `theme-provider.tsx` exists, tokens defined in `index.css`. But hardcoded colors leak in: **`dashboard.tsx` has ~40 occurrences of `text-white`/`bg-black`/hex, `profile-detail.tsx` ~30, `habits.tsx`/`editor.tsx` ~12 each.** Some are legitimate (chart series colors), but any `text-white`/`bg-white` on a themed surface will break in one mode. **Action:** sweep these files; replace literal colors with semantic tokens (`text-foreground`, `bg-card`, `text-muted-foreground`); keep only chart-data colors as literals (centralize those in `chart-colors.ts`). *(Med.)*
- **FOUC/flash-of-theme:** confirm the theme is applied pre-paint (inline script in `index.html` setting the `dark` class before React hydrates). *(Verify.)*

### 1.4 Accessibility (beyond touch targets)
- **`<div onClick>` without `role`/`tabindex`/key handler:** dashboard (6), chat (6), profile-detail (3), trackers (2) — keyboard and screen-reader users can't activate these. **Action:** convert to `<button>` or add `role="button" tabIndex={0}` + `onKeyDown`. *(Med.)*
- **`aria-label` coverage:** 36 files use it, 14 use icon-only buttons — gap implies some icon buttons are unlabeled. **Action:** audit every `size="icon"` button for an `aria-label`. *(Med.)*
- **Contrast:** `--muted-foreground: ... 47%` lightness on `--muted` backgrounds (both themes). At 47% on the dark `15%` background this is plausibly **below WCAG AA 4.5:1 for body text.** **Action:** run the two token pairs through a contrast checker; bump muted-foreground lightness if it fails (dark mode likely needs ~60%+). *(Med.)*
- **`prefers-reduced-motion`: not handled anywhere** despite framer-motion usage. **Action:** add a global `@media (prefers-reduced-motion: reduce)` rule that neutralizes transitions/animations, and gate framer-motion with `useReducedMotion()`. *(Med — accessibility + battery.)*
- **Font scaling:** verify body text uses `rem` (respects browser font-size) not fixed `px`. *(Verify.)*
- **Pinch-zoom:** already fixed (viewport allows zoom — good, noted in `index.html`).

### 1.5 Loading states & feedback
- **Only 6/24 pages import `Skeleton`; 14/24 reference `isLoading`/`isPending`.** The gap means several pages render blank or jump on load. **Action:** add skeletons to the high-traffic pages that lack them; standardize on one skeleton pattern. *(Med.)*
- **`EmptyState.tsx` exists** — confirm it's used consistently (empty list ≠ blank screen). *(Verify.)*
- Toast feedback on mutations: spot-check that destructive/long mutations surface success/error toasts. *(Verify.)*

---

## 2. Performance & Speed

### 2.1 Bundle (measured from `public/assets`)
| Chunk | Size | On cold path? |
|---|---|---|
| UniverSheet | 5.4 MB | No — lazy, preload-stripped ✅ |
| **main `index`** | **1.0 MB** | **Yes — every load** ⚠️ |
| exceljs | 937 KB | No — editor only ✅ |
| artifacts page | 773 KB | Route-lazy ✅ |
| mermaid / wardley / cytoscape / katex | 545 / 492 / 442 / 259 KB | Should be artifacts/editor-only — **verify none leak to main** |
| recharts | bundled | **Eager in `dashboard.tsx`** ⚠️ |
| Total build | 20 MB | — |

- **The 1 MB main chunk is the top performance win.** Routes are already `React.lazy`'d (good), so the bulk is shared vendor: **recharts (eagerly imported in dashboard, the default landing route), framer-motion, date-fns, Radix, lucide.** **Actions:** (a) lazy-load recharts — render dashboard KPIs immediately, hydrate charts in a `Suspense` boundary below the fold; (b) verify lucide is tree-shaken (import named icons, never `import * as`); (c) confirm date-fns imports are per-function (`date-fns/format`) not the barrel; (d) run `rollup-plugin-visualizer` to confirm the exact composition. *(High.)*
- **Verify mermaid/cytoscape/katex/wardley are not in the main chunk** — they're diagram/math libs that belong only in artifacts/editor. If `manualChunks` is grouping but something imports them eagerly, they inflate cold load. *(High — quick to check with the visualizer.)*

### 2.2 Service worker / offline / caching
- **`client/index.html` actively unregisters all service workers and deletes all caches on every load.** This was a deliberate anti-stale-content measure, but the cost is: **no offline support, and no cross-session caching of the app shell** — every visit re-downloads everything not covered by the `/assets/*` immutable header. **Action:** replace the scorched-earth approach with a real service worker (Workbox/`vite-plugin-pwa`) using **network-first for API/HTML, cache-first with hashed filenames for `/assets/*`.** Hashed asset filenames already make stale-content impossible, so the original fear doesn't apply to them. This is the single biggest repeat-visit speed win and unlocks the PWA install you already advertise in `manifest.json`. *(Med-High.)*

### 2.3 Fonts
- `index.html` loads **three families render-blocking from two CDNs** (Fontshare general-sans, Google Inter variable, Google JetBrains Mono). Preconnect is present but the stylesheet links still block first paint. **Actions:** self-host the fonts (eliminates a third-party round-trip and a privacy hop), add `font-display: swap`, and subset to the weights actually used. *(Med.)*

### 2.4 Re-renders & large lists
- **No virtualization library present** (`react-window`/`@tanstack/react-virtual` absent). With 10.8k expenses, 5.4k tasks, 12.8k habit check-ins in the live DB, any view that maps the full set into the DOM will jank. **Action:** confirm list views paginate server-side (the routes have `paginate()`); for any client-side long list (e.g. all expenses on finance/profile-detail), add windowing. *(Med — verify which views are unbounded.)*
- The mega-components are re-render hazards by size. **Action:** profile `profile-detail.tsx` and `dashboard.tsx` with React DevTools Profiler; memoize expensive derived lists and split the 12k-line profile-detail into route-level sub-chunks. *(Med, larger effort.)*

### 2.5 Build config
- **No `drop_console`** and no explicit minify/target tuning in `vite.config.ts`; 2 `console.log` ship to production. **Actions:** add esbuild `drop: ['console','debugger']` for prod, set a modern `build.target`, and enable Brotli/gzip (Vercel does gzip at the edge — confirm Brotli). *(Low, easy.)*
- `api/_bundle.mjs` is 4 MB — serverless cold-start cost. **Action:** check whether heavy server deps (exceljs, jspdf) can be lazy-`import()`ed only in the export route rather than top-level, shrinking the function. *(Med.)*

---

## 3. Authentication & State Management

**Overall: strong.** Architecture details verified:
- **Server-proxied auth** (`server/auth.ts`): `/api/auth/signin|signup|refresh|me|signout|change-password|forgot-password|reset-password|callback`. Client never bundles `supabase-js` (`auth.tsx:2`) — smaller bundle and no SDK localStorage footprint.
- **Tokens in `sessionStorage`, not `localStorage`** (`auth.tsx:37-44`) — cleared on tab close, better for shared devices, survives refresh. Memory-first with sessionStorage backup.
- **Rate limiting** (`server/auth.ts:248-285`): 10 auth req/min/IP, 3 signups/hour/email, bounded LRU maps, optional Cloudflare Turnstile.
- **Background refresh 5 min before expiry** (`auth.tsx:136`) prevents silent 401s; a 401 still dispatches a clean re-auth event (`queryClient.ts:92-99`).
- **Per-user cache isolation** (`cache-isolation.ts`) + full clear on signout (`auth.tsx:362`, `clearAllClientCaches`) — verified in the prior architecture audit; no cross-user leak.

Findings:
- **F-AUTH-1 (Low/UX):** `sessionStorage` means **closing the tab logs you out** — no "remember me." That's a deliberate security/UX tradeoff; if users complain about frequent re-login, offer an opt-in persistent (localStorage) session with a clear toggle. *(Decision, not a bug.)*
- **F-AUTH-2 (Low):** No biometric/passkey despite the Capacitor native wrapper. **Action:** consider WebAuthn/passkey or native biometric unlock for the iOS app — big UX win on mobile. *(Enhancement.)*
- **F-AUTH-3 (verify):** Multi-tab logout sync — confirm a `storage`/custom event in one tab signs out the others. The infra (`portol:auth-cleared` event) exists; verify both tabs listen. *(Verify.)*
- **F-AUTH-4 (verify):** Deep-link-to-login-then-back — confirm an unauthenticated deep link redirects to login and returns to the intended route afterward. *(Verify.)*
- **F-AUTH-5 (verify):** Confirm `forgot-password`/`reset-password`/`change-password` are all behind the auth rate limiter (signin/signup are; check the others share `checkAuthRateLimit`). *(Verify — brute-force surface.)*

---

## 4. Security & Privacy

### 4.1 Dependency vulnerabilities — **High, act first**
`npm audit`: **16 vulns (7 high, 9 moderate).** Named:
- **`ws` 8.0.0–8.20.0** — uninitialized memory disclosure. Fix: `npm audit fix` (non-breaking). *(Reachable only if a ws server/client is exposed — likely transitive via Supabase realtime; patch regardless.)*
- **`uuid <11.1.1`** — buffer bounds check. Transitive via `exceljs`.
- **`exceljs` chain** — depends on vulnerable `uuid`; full fix needs `exceljs@>=3.5.0` downgrade-or-upgrade (`--force`, breaking). exceljs is **server-side export only**, so reachability is limited to the export path.
**Actions:** (1) `npm audit fix` now for the non-breaking set (`ws` etc.); (2) evaluate the `exceljs` upgrade in isolation (it's isolated to export — low blast radius); (3) add `npm audit` to CI so new vulns fail the build. *(High.)*

### 4.2 CSP is too weak — **High**
`server/security-headers.ts`: CSP ships but `script-src` includes **`'unsafe-inline' 'unsafe-eval'`**. That combination means the policy **cannot stop an injected `<script>` or inline event-handler** — the primary thing CSP exists to do. `style-src` also allows `'unsafe-inline'`.
- `'unsafe-eval'` appears to be needed by a dependency (likely UniverSheet/a chart or formula lib). `'unsafe-inline'` for scripts is the bigger problem.
**Actions:** (1) move inline scripts in `index.html` to external files or add per-script **nonces**, then drop `'unsafe-inline'` from `script-src`; (2) determine which lib needs `'unsafe-eval'` and scope it or replace it — if only the editor needs it, you can't easily scope per-route with a static header, so isolate the editor or accept the risk with documentation; (3) keep the good parts — `frame-ancestors 'none'`, `object-src` (add it: `object-src 'none'`), `base-uri 'self'`, `upgrade-insecure-requests` are all correct. *(High — this is the difference between CSP-as-defense and CSP-as-decoration.)*

### 4.3 XSS — **currently OK, keep it that way**
- All three `dangerouslySetInnerHTML` sites sanitize with DOMPurify: `share-view.tsx:71`, `artifacts.tsx:227`, `editor.tsx:560`. `ui/chart.tsx:81` injects only computed CSS (safe). ✅
- **Action (guardrail):** add a lint/contract rule (mirroring the architecture audit's static gates) banning `dangerouslySetInnerHTML` unless the value comes from a `DOMPurify.sanitize(...)` call — so a future fourth render site can't skip it. *(Med — prevents regression.)*
- `chat.tsx:1675` `Function('p','return import(p)')` is a Rollup-dodge for a dynamic native import, not user-input eval — **benign**, but it forces the `'unsafe-eval'` CSP. Consider Vite's `/* @vite-ignore */` dynamic import instead to remove one `eval` dependency. *(Low.)*

### 4.4 Headers / CSRF / CORS — **good**
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, HSTS (prod, preload) all present and correct.
- **CSRF:** origin-based check on all mutating `/api/*` (`csrfOriginCheck`), correctly exempting `/api/auth`, `/api/public`, `/api/cron`. Combined with bearer-token (not cookie) auth, CSRF surface is minimal. ✅
- **Add:** `object-src 'none'` and `Cross-Origin-Opener-Policy: same-origin` to the header set. *(Low.)*

### 4.5 Secrets / data exposure — **verify**
- Client correctly avoids `supabase-js`; the **anon key is fetched from `/api/auth/config`** (public, fine). **Action:** grep the built client bundle for any `service_role` / `sk-` / `ANTHROPIC`/`OPENAI`/`PERPLEXITY` key to be 100% sure no server secret tree-shook into the client. *(Verify — high impact if wrong.)*
- Error responses: the prior audit hardened `asyncHandler` to return generic 5xx (no stack leak) while honoring 4xx `statusCode`. ✅
- **Action:** audit `server/logger.ts` for PII (emails, tokens, financial amounts) in logs. *(Verify — privacy.)*

### 4.6 Authorization / IDOR — **likely OK, spot-check**
- Every storage method scopes by `user_id` (confirmed in the architecture audit), and `:id` routes have defense-in-depth ownership guards (e.g. `getTracker` 404s on user mismatch). Public share endpoints strip `linked_profiles` and gate on a token.
- **Action:** spot-check 5–6 `GET/PATCH/DELETE /api/<entity>/:id` routes to confirm none trust the id without the `user_id` filter. *(Med — verify.)*

### 4.7 Transport / storage / rate limits
- HSTS + `upgrade-insecure-requests` enforce HTTPS. ✅
- **Body limit 10 MB** (`server/index.ts:22`) — reasonable; confirm the upload endpoint has its own stricter limit and the file-type allowlist. *(Verify — DoS via large/odd uploads.)*
- `crypto-util.ts` exists — **Action:** confirm what it encrypts, the algorithm, and where the key lives (env, not committed). *(Verify.)*
- RLS enabled on all 37 tables (confirmed via Supabase) — defense-in-depth. ✅

---

## 5. Prioritized remediation plan

Effort: S < ½ day · M 1–2 days · L 3–5 days.

### P0 — Security, do this week
| ID | Action | Effort |
|---|---|---|
| S0.1 | `npm audit fix` for the non-breaking set (`ws` + others); add `npm audit --audit-level=high` to CI | S |
| S0.2 | Evaluate + apply the `exceljs`/`uuid` upgrade (isolated to export path) | M |
| S0.3 | Tighten CSP: add `object-src 'none'`; nonce the inline scripts and drop `script-src 'unsafe-inline'`; document/scope the `'unsafe-eval'` dependency | M |
| S0.4 | Grep built client bundle for server secrets; audit logger for PII | S |
| S0.5 | Lint/contract gate banning unsanitized `dangerouslySetInnerHTML` | S |

### P1 — Performance, highest user-visible impact
| ID | Action | Effort |
|---|---|---|
| P1.1 | Run `rollup-plugin-visualizer`; lazy-load recharts off the dashboard cold path; confirm mermaid/cytoscape/katex aren't in main | M |
| P1.2 | Replace the SW-unregister hack with a real Workbox/`vite-plugin-pwa` service worker (network-first API/HTML, cache-first hashed assets) → offline + fast repeat loads + real PWA install | M |
| P1.3 | Self-host + `font-display: swap` + subset the 3 font families; remove render-blocking CDN links | S |
| P1.4 | Add esbuild `drop: ['console','debugger']`, modern build target, Brotli | S |
| P1.5 | Lazy-`import()` exceljs/jspdf in the export route to shrink the 4 MB serverless function | M |

### P2 — Accessibility & UX consistency
| ID | Action | Effort |
|---|---|---|
| P2.1 | Bump icon-button hit area to 44px on touch; audit every `size="icon"` for `aria-label` | S |
| P2.2 | Convert `<div onClick>` (17+) to buttons or add `role`/`tabindex`/`onKeyDown` | M |
| P2.3 | Global `prefers-reduced-motion` rule + `useReducedMotion()` gating framer-motion | S |
| P2.4 | Fix `muted-foreground` contrast in both themes (run AA check) | S |
| P2.5 | Sweep hardcoded `text-white`/`bg-black`/hex → semantic tokens in dashboard + profile-detail | M |
| P2.6 | Add Skeleton loaders to the high-traffic pages missing them; standardize empty states | M |

### P3 — Verification pass (cheap, do alongside)
| ID | Action | Effort |
|---|---|---|
| V3.1 | Device-matrix QA on the 5 mega-pages (360/768/1024, both orientations) | M |
| V3.2 | Mobile nav parity — every route reachable on phone | S |
| V3.3 | Auth edge cases: multi-tab logout sync, deep-link-then-login, forgot/reset/change rate-limited | M |
| V3.4 | IDOR spot-check on `:id` routes; upload size/type limits; `crypto-util` key location; theme FOUC | M |
| V3.5 | Confirm long lists paginate/virtualize (expenses, tasks) | S |

### P4 — Enhancements
| ID | Action | Effort |
|---|---|---|
| E4.1 | WebAuthn/passkey or native biometric unlock (Capacitor) | L |
| E4.2 | Optional "remember me" persistent session toggle | S |
| E4.3 | Split `profile-detail.tsx` (12k lines) into route-level sub-chunks; memoize hot lists | L |

---

## 6. What's already good (don't regress)
Server-proxied auth with no client SDK · `sessionStorage` tokens · auth rate limiting + Turnstile · background token refresh · per-user cache isolation with full logout clear · origin CSRF + bearer auth · complete security-header set with HSTS · DOMPurify at every HTML render site · RLS on all tables · lazy-loaded + preload-stripped heavy editor chunks · immutable `/assets/*` caching · pinch-zoom enabled.

---

## 7. Deep-dive findings (verified) — additions to the plan

The detailed sub-audits surfaced these beyond §1–4. Each was checked for real reachability (two "critical" claims were downgraded after verification — noted below).

### Auth/state (genuine, add to P2/P3)
- **A-1 (High) Cross-tab logout desync** — `signOut()` (`auth.tsx:362-381`) clears only the current tab. Another open tab keeps in-memory tokens until its next request 401s (~100–500 ms window). **Fix:** broadcast logout via a `localStorage` `storage` event; all tabs clear on receipt. *(S)*
- **A-2 (Med) Unscoped localStorage survives logout** — `portol_doc_snooze_v1` (`dashboard.tsx:771`), `portol_dismissed_action_v2` (`dashboard.tsx:1593`), `portol_editor_links_sidebar` (`editor.tsx:266`) are never cleared, so on a shared device user B sees user A's dismissed items. **Fix:** add them to `clearAllClientCaches()`. *(S)*
- **A-3 (Med) Deep-link not preserved across login** — logging in always lands on `/`, discarding the intended route. **Fix:** stash intent in `sessionStorage`, redirect back after auth. *(S)*
- **A-4 (Med, native) Capacitor uses web `sessionStorage`, not Keychain/Keystore** — tokens accessible on rooted/jailbroken devices. **Fix:** native secure-storage plugin for the refresh token. *(M, native only)*
- **A-5 (Low) No client-side backoff on 429** — server rate-limits login but the UI lets users keep hammering. **Fix:** disable submit 60 s on 429. *(S)*

### Security (triaged for reachability)
- **DOWNGRADED — drizzle-orm SQLi advisory is NOT runtime-reachable.** The security agent rated this "critical," but verification shows **zero `drizzle-orm` imports in the query layer** — all reads/writes go through the Supabase client; drizzle is migration tooling only. Patch it for hygiene (`npm audit fix`), but no user-input query path is affected. *(Low.)*
- **DOWNGRADED — public artifact endpoint is a capability-URL, not an IDOR.** It gates on an unguessable random `shareToken` (128-bit for current tokens), rate-limited 10/min/IP, format-checked, constant-delay deny. The agent's "add user_id filter" is inapplicable (no logged-in user on a public share). **Real, narrower fixes:** (a) ~~legacy 32-hex tokens are only 64-bit~~ CORRECTED during execution: 32 hex chars = 128-bit random, which is fine — no migration needed; (b) the response returns the **full `metadata` blob, which contains `shareToken`** (`routes.ts:4731` `select(... metadata ...)`) — project only the needed metadata fields so the share token and any internal flags don't leak back. *(Med — the metadata leak is the actionable part.)*
- **SEC-1 (Med, real) Mermaid renders unsanitized** (`artifacts.tsx` MermaidRenderer) — Mermaid ≤11.14.0 has CSS/HTML-injection advisories; AI/user-authored diagram source reaches `mermaid.render` directly. **Fix:** upgrade Mermaid and/or render it inside a sandboxed iframe. *(Med.)*
- **SEC-2 (full `npm audit`, incl. transitive)** beyond the runtime-dep scan: `@xmldom/xmldom` (high, via PDF/doc tooling — reachable only if untrusted XML is parsed), `lodash` (high — only exploitable via `_.template`/merge on user input; grep shows no direct risky calls), `path-to-regexp`/`picomatch`/`brace-expansion` (mostly build-time), `@anthropic-ai/sdk` memory-tool path traversal (only if the memory tool is used — verify it isn't). **Fix:** `npm audit fix` for the non-breaking set; schedule the breaking ones (exceljs/uuid, anthropic-sdk) in an isolated PR each. Add `npm audit --audit-level=high` to CI. *(Folds into S0.1/S0.2.)*
- **SEC-3 (Low) Share-token timing** — the format pre-check returns before the constant-delay `deny()`, letting an attacker distinguish "bad format" from "unknown token." **Fix:** route the format-fail through the same delayed `deny()`. *(S.)*

### Performance (verified, strong quick wins)
- **PERF-1 (High, trivial) Server bundle is unminified** — `script/build-vercel.ts:31` sets `minify: false`, leaving `api/_bundle.mjs` at 4 MB. Flip to `true`: ~25–30% smaller, ~100–150 ms faster serverless cold start. *(S — highest effort-to-impact ratio in the whole audit.)*
- **PERF-2 (Med) Eager preload of all 11 route chunks before auth** — `App.tsx:87-100` fires every page's dynamic import at module load, so logged-out visitors download 1.6–3.3 MB they'll never use. **Fix:** move the preload inside the authenticated gate or behind `requestIdleCallback`. *(S.)*
- **PERF-3 (Low) Logo PNGs are 180–250 KB each** (`public/portol-logo*.png`), shown on every page. **Fix:** compress to ~20–30 KB or SVG; add WebP. *(S.)*
- **PERF-4 (Med) Mermaid loads on render with no preload/error boundary** — 1–2 s blank when opening a diagram. **Fix:** prefetch on artifacts mount, wrap in try/catch + skeleton. *(S.)*
- Confirmed already-good: route-level `React.lazy`, editor-chunk preload stripping, the single `/api/dashboard-bootstrap` cold-load call, React Query tuning. *(No change.)*

### Updated priority deltas
Add to **P0:** PERF-1 (server minify — do it first, it's one line). Add to **P1:** PERF-2, the Mermaid upgrade (SEC-1) and metadata-projection fix on the share endpoint. Add to **P2/P3:** A-1, A-2, A-3 (all small, high-trust). The drizzle and public-artifact items are **not** the emergencies the raw CVSS suggested.

---

## 8. Execution status (2026-06-10, same day)

Executed and merged to main. Verified: `tsc` clean, 242/242 unit tests, 47/47 static guardrail contracts, production build green.

**Measured wins:**
- Main entry chunk **1,045 KB → 562 KB (−46%)** — chat (the eager home page) was the culprit, not dashboard: `ArtifactPanel`→recharts, `SmartFillDialog`, `DocumentViewer`, and inline chart rendering are now `React.lazy` (`chat.tsx:20-27`, new `ChatChartRenderer.tsx`).
- Serverless function **4.0 MB → 2.4 MB (−40%)** — `build-vercel.ts` now minifies (with `keepNames` for readable stacks).
- **Dependencies: 16 vulnerabilities → 0** — `npm audit fix` (ws + 11 others), uuid pinned via npm `overrides` under exceljs (smoke-tested), drizzle-orm → 0.45.2, @anthropic-ai/sdk → 0.104.1 (both upgraded clean through tsc + tests). New pre-push gate: `npm audit --omit=dev --audit-level=high` blocks pushes (`SKIP_AUDIT=1` bypass).

**S0.1 follow-up (2026-08-04).** The gate went red again and blocked every push. Two causes, both now fixed:

1. *An exact pin went stale.* The `overrides` added above included `"minimatch@10.2.5": { "brace-expansion": "5.0.7" }` (and the same for `10.1.1`). `5.0.7` was safe when written; the advisory range later widened to `<=1.1.17 || 2.0.0 - 2.1.3 || 4.0.0 - 5.0.8`, putting the pinned version inside it — so the override was the *only* reason that path was still vulnerable, and being an exact pin it could not self-heal. Removing both entries was the fix: `minimatch@10.2.5` declares `brace-expansion: "^5.0.5"`, which resolves to the safe `5.0.9` on its own. **Prefer a range over an exact pin in `overrides`** — an exact pin is a future gate failure with a delay fuse.
2. *Patch-level drift.* `npm audit fix` (no `--force`) cleared `postcss 8.5.15→8.5.25`, `dompurify 3.4.11→3.4.13`, `tar 7.5.20→7.5.22`, `brace-expansion 1.1.16→1.1.18` / `2.1.2→2.1.4`. `tsx` floor raised `^4.20.5 → ^4.23.5` (and the `@esbuild-kit/esm-loader` alias with it) so its nested `esbuild` moves `0.27.4 → 0.28.1`.

**Result: the runtime tree is at 0 vulnerabilities, every severity** (`npm audit --omit=dev`). The CI half of S0.1 — never done at the time — is now in place: `.github/workflows/ci.yml` runs `npm run audit:ci` after `npm ci`.

**Accepted exception — `esbuild` under `vite` (low, dev-only).** `npm audit` *including* dev reports one remaining advisory: GHSA-g7r4-m6w7-qqqr, `node_modules/vite/node_modules/esbuild@0.27.4`. Not fixable in range: Vite 7 pins `esbuild: ^0.27.0`, and on a `0.x` version a caret locks the minor, so the ceiling is `0.27.7` while the advisory range is `0.27.3 - 0.28.0` — only `0.28.1` is clean. Reaching it requires Vite 7→8, a major bundler upgrade not worth riding along on a security patch.

Reachability argument for accepting it, in the same spirit as the drizzle-orm downgrade above: the advisory is *arbitrary file read when running the dev server on Windows*. It is dev-only (absent from `--omit=dev`, so it does not gate), Windows-only, and this app builds and deploys on Linux via Vercel. **Follow-up:** evaluate Vite 7→8 as its own task.

**Security:** CSP no longer allows `'unsafe-inline'` for scripts (the SW-unregister inline script is gone; theme bootstrap externalized to `/theme-init.js`); added `object-src 'none'`, `worker-src 'self'`, COOP. Crucially, the full header set (CSP, HSTS, XFO, etc.) now also ships on the **static HTML document via `vercel.json`** — previously Express-only headers never applied to the SPA document in production. Share endpoint: metadata projected at the DB level so `shareToken` can never echo back; timing-leak comment verified safe. `'unsafe-eval'` remains (Univer formula compilation + Capacitor import shim) — documented.

**Performance:** Real service worker (vite-plugin-pwa): precaches only the 39 KB shell, CacheFirst on hashed `/assets/*`, NetworkOnly on `/api/*` — replaces the unregister-everything hack; offline shell + fast repeat loads with zero stale-data risk. Inter + JetBrains Mono self-hosted via @fontsource (Google Fonts links removed); Fontshare kept with preconnect + swap. Route preloads now fire post-auth in `requestIdleCallback` instead of at module load. `console.log/debug` stripped from prod builds. Mermaid renderer hardened (prefetch on mount, try/catch + error fallback).

**Auth/state:** cross-tab logout broadcast + different-user sign-in reload (`auth.tsx:131-165`); five user-scoped localStorage keys (incl. crash-report payload) now cleared on logout; deep links survive the login redirect (`portol_auth_return_to`); 429 sign-in backoff with countdown; refresh-token-rotation canary warning.

**A11y/UX:** ≥44px touch targets on coarse pointers (`.touch-hit` on the icon button variant); global `prefers-reduced-motion` CSS + framer-motion gating (AnimatePresence removed from CommandSearch, `useReducedMotion` in OnboardingWizard); muted-foreground contrast tokens adjusted to clear WCAG AA; pre-paint theme bootstrap kills the dark-mode FOUC; `<div onClick>` → semantic buttons and icon-button `aria-label`s across dashboard/chat/profile-detail/trackers + the smaller pages; theme-breaking color literals replaced with semantic tokens (gradient-hero `text-white` deliberately kept).

**Deferred (with reasons):** logo PNG compression (no image tools in this environment — run pngquant locally or in CI); device-matrix QA + screen-reader pass (needs real devices); skeleton standardization across all 24 pages (top pages covered; rest is incremental); profile-detail.tsx full split + list virtualization (needs profiling data first); Capacitor secure-storage / biometric unlock (needs a native build to test); "remember me" persistent sessions (product decision); fuller CSP `'unsafe-eval'` removal (blocked on Univer).
