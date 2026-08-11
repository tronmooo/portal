# Profile Tabs Specification — Production Build

## Architecture Rule
Every tab answers: "What does THIS type of profile actually need to function in real life?"
Tabs are NOT generic. They adapt per profile type.

## Tab Routing Per Profile Type

### Person / Self
Overview | Health | Documents | Finance | Goals & Tasks | Activity

### Pet  
Overview | Health & Vet | Documents | Care Costs | Reminders | Activity

### Vehicle
Overview | Maintenance | Documents | Finance | Tasks | Activity

### Loan / Liability
Overview | Amortization | Payments | Documents | Activity

### Subscription
Overview | Billing | Documents | Activity

### Insurance
Overview | Coverage | Claims | Documents | Activity

### Property
Overview | Maintenance | Mortgage | Documents | Activity

### Investment
Overview | Performance | Documents | Activity

### Asset (generic)
Overview | Documents | Finance | Activity

## Tab Contents

### OVERVIEW — "Control Center"
- Identity block with type-specific key stats
- "What matters right now" smart cards (upcoming bills, expiring docs, tasks due, health alerts)
- Quick insights from computed data
- Recent activity feed (last 10 items from timeline)

### HEALTH (person/pet/self only)
- Top metrics dashboard (latest values for weight, BP, calories, etc.)
- Real trend charts (recharts) from tracker entries over time
- Tracker cards — each clickable to log entry inline
- Medications section
- AI insights from trends

### DOCUMENTS
- Category filter chips (IDs, Medical, Financial, Legal, Warranties, Insurance)
- Document cards with title, type, profile, expiration
- Preview on click (existing DocumentViewerDialog)
- Extracted data panel with save-to-profile actions
- Expiration alerts

### FINANCE
- Top summary: total spent, monthly burn, outstanding balance
- Expenses list with category/date filters
- Subscriptions section with payment calendar
- Loans: balance, rate, payment, amortization chart, payoff simulator
- Linked financial activity from child profiles

### GOALS & TASKS
- Active goals with progress bars + linked trackers
- Tasks with status toggles, due dates, priority
- Recurring tasks
- Quick add inline

### ACTIVITY — Timeline
- Chronological feed of ALL events for this profile
- Type filters (financial, health, documents, tasks)
- Click to drill down
- Monthly summary stats
