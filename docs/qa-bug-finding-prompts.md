# QA Bug-Finding Prompts

A library of brutal QA / code-review prompts you can throw into AI agents
(Cursor, Claude, ChatGPT, etc.) or your dev workflow to uncover bugs, bad
logic, broken UX, race conditions, data leaks, and hidden issues.

A lot of bugs hide in the "works technically but feels wrong" category.
Those are the nastiest ones because users don't report them — they just
slowly lose trust and disappear.

---

## General "Find Everything Wrong" Prompt

You are a hostile senior QA engineer and software auditor.
Your job is to break this app mentally and technically.

Find:

- broken logic
- UI inconsistencies
- bad state management
- stale data
- incorrect calculations
- race conditions
- security issues
- missing validation
- duplicate data
- bad loading states
- routing issues
- anything confusing to users
- places where the app can silently fail
- edge cases developers forgot

Explain every issue in plain English:

- what is wrong
- why it happens
- how users trigger it
- severity level
- how to fix it simply

---

## Frontend UI Bug Prompt

Review this frontend like a product designer and QA tester.

Find:

- buttons that may fail
- bad spacing
- empty areas
- overlapping UI
- unreadable text
- inconsistent colors
- broken mobile responsiveness
- confusing navigation
- places users may get stuck
- missing loading indicators
- popups/modals with missing data
- places requiring refreshes

Explain fixes in simple terms.

---

## State Management Prompt

Find all possible state management problems in this app.

Look for:

- stale UI
- data not updating immediately
- race conditions
- duplicate state
- cache mismatch
- incorrect optimistic updates
- components not rerendering
- filters showing wrong data
- popups showing outdated values
- data disappearing after refresh

Explain exactly what causes each issue.

---

## Database / Data Integrity Prompt

Audit the data architecture.

Find:

- duplicate database entries
- missing relationships
- orphaned records
- incorrect ownership logic
- broken foreign keys
- data leakage between users/profiles
- incorrect aggregations
- calculations that can become inaccurate
- bad schema design
- places where deleting one item breaks another

Explain how data corruption could happen.

---

## Security Prompt

You are a penetration tester.

Find:

- exposed endpoints
- insecure APIs
- missing authentication
- authorization failures
- data leaks
- privilege escalation
- broken session logic
- insecure file uploads
- injection vulnerabilities
- exposed secrets
- weak validation
- ways users could access other users' data

Explain attack scenarios simply.

---

## Performance Prompt

Audit this app for performance issues.

Find:

- unnecessary rerenders
- slow database queries
- overfetching
- memory leaks
- bad loading behavior
- huge components
- expensive calculations
- blocking UI operations
- slow charts
- bad pagination
- excessive API calls

Explain how to make the app feel instant.

---

## Natural Language / AI Prompt

Audit the AI and natural language system.

Test:

- vague commands
- conflicting commands
- multi-action commands
- ownership confusion
- duplicate names
- partial information
- typo handling
- memory consistency
- entity resolution
- extraction accuracy

Find where the AI misunderstands intent or saves data incorrectly.

---

## CRUD Testing Prompt

Test all CRUD operations.

For every object:

- create
- read
- update
- delete

Verify:

- changes appear instantly
- data persists after refresh
- dashboard updates correctly
- filters update correctly
- popups update correctly
- linked pages update correctly
- deleting removes data everywhere

Find every sync issue.

---

## Dashboard Prompt

Audit the dashboard like a financial auditor.

Verify:

- every number is real
- calculations are correct
- cards match drilldowns
- drilldowns match raw data
- filters isolate correctly
- charts use real data
- metrics update instantly
- no fake placeholder values exist

Find all mismatches.

---

## Edge Case Prompt

Find edge cases developers forgot.

Test:

- empty states
- duplicate names
- extremely long text
- negative values
- zero values
- rapid clicking
- refresh during save
- deleting linked items
- multiple tabs open
- bad internet
- partial uploads
- invalid dates
- timezone problems

Explain what breaks.

---

## "Think Like a User" Prompt

Pretend you are a confused first-time user with no technical knowledge.

Find:

- confusing workflows
- unclear buttons
- missing feedback
- unclear errors
- places users may abandon the app
- things requiring too many clicks
- areas where users won't trust the app

Explain what feels broken psychologically.

---

## "Destroy The App" Prompt

Your only goal is to break this app.

Try:

- spam clicking
- creating duplicate data
- rapid editing
- invalid inputs
- switching tabs during saves
- refreshing during API calls
- conflicting actions
- opening multiple modals
- creating recursive relationships
- extremely large datasets

Find every failure point.

---

## Architecture Prompt

Review the architecture like a senior software engineer.

Find:

- scalability problems
- tightly coupled systems
- duplicated logic
- components doing too much
- bad abstractions
- future bottlenecks
- maintainability issues
- technical debt
- fragile systems

Explain long-term risks.

---

## "What Will Break Later?" Prompt

Predict future failures in this codebase.

Find systems that:

- work now but won't scale
- become inconsistent over time
- will create hidden bugs later
- will become slow with more data
- are difficult to maintain
- will cause developer confusion

Explain future disaster scenarios.
