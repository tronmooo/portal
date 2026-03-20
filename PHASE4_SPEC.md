# LifeOS Phase 4 — Production-Ready Overhaul Spec

## Critical Rules
- NO localStorage/sessionStorage (blocked in sandboxed iframe)
- Hash routing mandatory (`useHashLocation` from `wouter/use-hash-location`)
- Uses `apiRequest` from `@/lib/queryClient` for ALL HTTP requests
- Tailwind CSS v3 (NOT v4) — use `@tailwind base; @tailwind components; @tailwind utilities;`
- Do NOT import React explicitly (Vite JSX transformer handles it)
- All shadcn components from `@/components/ui/*`
- Icons from `lucide-react`
- TanStack Query v5 (object form only: `useQuery({ queryKey: [...] })`)
- `queryClient` imported from `@/lib/queryClient` for invalidation
- `data-testid` on all interactive elements

## Profile Type-Specific Tabs
Each profile type has different tabs based on what makes sense:

### Person (person/self)
Tabs: Info | Medical | Contacts | Documents | Timeline
- Info: name, birthday, phone, email, relationship, address, blood type, height, allergies
- Medical: linked health trackers (blood pressure, weight, etc.), medical history notes
- Contacts: emergency contacts, doctor info
- Documents: driver's license, passport, insurance cards, medical records
- Timeline: all activity

### Pet (pet)
Tabs: Info | Health | Vet | Documents | Timeline  
- Info: name, species, breed, birthday, weight, color, microchip#
- Health: linked health trackers, vaccination schedule, medications
- Vet: vet name, vet phone, vet address, last visit, next appointment
- Documents: vaccination records, adoption papers, pet insurance
- Timeline

### Vehicle (vehicle)
Tabs: Info | Maintenance | Insurance | Documents | Timeline
- Info: year, make, model, color, VIN, license plate, mileage, loan info
- Maintenance: oil changes, tire rotations, repairs (each with date, cost, mileage, notes)
- Insurance: policy number, provider, premium, coverage, deductible, expiration
- Documents: title, registration, insurance card, maintenance receipts
- Timeline

### Asset (asset) — electronics, property, valuables
Tabs: Info | Warranty | Specs | Documents | Timeline
- Info: name, type (electronics/appliance/furniture/jewelry/other), brand, model, purchase date, purchase price, serial number
- Warranty: warranty provider, warranty expiration, coverage details
- Specs: custom key-value fields
- Documents: receipts, manuals, warranty cards
- Timeline

### Loan (loan)
Tabs: Info | Payments | Documents | Timeline
- Info: lender, original amount, remaining balance, interest rate, monthly payment, term, start date
- Payments: payment history (date, amount, principal, interest, balance after)
- Documents: loan agreement, statements
- Timeline

### Investment (investment)
Tabs: Info | Performance | Documents | Timeline
- Info: broker, account type, balance, contributions (YTD), allocation
- Performance: value over time entries (date, value, notes)
- Documents: statements, tax forms
- Timeline

### Subscription (subscription)
Tabs: Info | Billing | Documents | Timeline
- Info: service name, plan, cost, frequency, next billing date, auto-renew, login email
- Billing: payment history
- Documents: receipts, contracts
- Timeline

## Upload Flow
When user uploads a file in chat:
1. Show file preview + a profile selector dropdown (list of all profiles + "New Profile" + "Don't link")
2. User picks which profile to link to (or creates new)
3. On send: POST /api/upload with { fileName, mimeType, fileData, profileId?, message? }
4. AI extracts data via Claude vision
5. Document is created and linked to selected profile
6. Extracted data is saved to profile.fields (merged)
7. If medical data with numbers, create/update tracker entries
8. Response shows what was extracted and where it was saved

## Document Viewing
- Documents stored with base64 fileData
- GET /api/documents/:id returns full doc with fileData
- In profile detail Docs tab: click to open inline viewer (image shown, PDF shown in object tag)
- Chat "open document" commands: return documentPreview in chat message so it renders inline

## Dashboard CRUD
Every section in the dashboard needs add/edit/delete:
- Tasks: + button opens "Add Task" dialog, click task opens edit dialog, swipe/delete
- Habits: + button opens "Add Habit" dialog, check-in buttons work (already do)
- Obligations: + button opens "Add Bill" dialog, Mark Paid opens payment dialog
- Journal: + button opens "New Entry" dialog with mood picker + text
- Events: + button opens "Add Event" dialog

## Tracker CRUD
- Create new tracker: + button → dialog with name, category, unit, fields
- Add entry to tracker: + button on card → dialog with dynamic fields based on tracker.fields
- Delete entry: click entry → confirm delete
- Delete tracker: ... menu → confirm delete

## Routes Needed (additions to existing)
- PATCH /api/trackers/:id — update tracker
- DELETE /api/trackers/:id/entries/:entryId — delete single entry
- PATCH /api/obligations/:id — update obligation
- PATCH /api/events/:id — update event
- DELETE /api/events/:id — delete event
- PATCH /api/expenses/:id — update expense
- DELETE /api/expenses/:id — delete expense
- POST /api/documents — create document directly (not just via upload)
- DELETE /api/documents/:id — delete document
- PATCH /api/journal/:id — update journal entry
- POST /api/upload now accepts optional `profileId` field
