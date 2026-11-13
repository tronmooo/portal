# Portol tutorial briefs (76 tutorials)

Each brief below is written so you can paste it into ChatGPT and get a finished tutorial back. Labels in **bold** or "quotes" are the exact on-screen text, taken from the app's code. **[verify in app]** marks anything the code couldn't confirm. Check those on screen before you record.

## Prompt to paste into ChatGPT first (once per conversation)

> You are writing end-user tutorials for **Portol** (portol.me), an AI-powered personal-life dashboard. Users log their finances, health, tasks, calendar, documents, assets and people, mostly by chatting with Portol in plain language.
> I'll paste one "tutorial brief" at a time. For each one, write:
> 1. A short title and a one-line hook.
> 2. A video script (60–120 seconds) with on-screen directions in [brackets].
> 3. A written step-by-step version for a help center.
>
> Rules:
> - Use the exact button and label text from the brief, in **bold**.
> - Don't invent features, buttons or settings that aren't in the brief.
> - Don't mention anything the brief marks [verify in app]. Leave it out instead.
> - Turn the brief's "Gotchas / FAQ" into a short "Good to know" section.
> - Use a friendly, plain-language tone with no technical jargon. Address the viewer as "you".

## Navigation facts every tutorial relies on

- **Main nav** (desktop sidebar or mobile bottom bar): **Chat**, **Dashboard**, **Calendar**, **Artifacts**. On desktop, **Settings** sits at the bottom of the sidebar. On any screen, it's also in the avatar **Account menu** at the top right.
- **Dashboard** opens a hub with chips: **Executive · Trackers · Finance · Wellness · Assets · Liabilities · Documents · Info**. Finance, Assets and Liabilities live here, not in the main nav.
- The **top bar** holds **Search** (⌘K / Ctrl+K, "Search everything…"), the **bell** (notifications), a light/dark toggle and the Account menu. Pages that aren't in the nav are reached through Search: Habits, Goals, Insights, Tasks and Profiles.
- **Routes** appear after a `#` in the address bar, e.g. `portol.me/#/dashboard/finance`.
- **Chat is the main way to add data.** Several features can only be done from chat today. Their briefs say so.

## Tutorials marked as needing care before you record

- **#2 Onboarding wizard and #6 floating + button:** both exist in the code but are not shown anywhere in the app today.
- **#18:** this imports **finances** (transactions, bills, accounts, budgets) through a prompt you run in ChatGPT. It does not import your chat history.
- **#24:** there is no "Explain" button. Users tap the KPI chips and cards, or ask the chat.
- **#27 Smart Fill:** it fills **PDF forms** from profile data.
- **#30 Merge profiles, #61 Create a tracker:** these work through chat only.
- **#54:** Google Calendar sync can't be connected from the app today. Treat external calendar sync as not available.
- **#56:** snoozing a **task** moves its due date by 7 days. Snoozing a **bill** only hides the alert.
- **#66:** there is no Quick Notes section any more. Notes are created in chat and live in Artifacts.
- **#74:** the notification switches save a setting, but nothing in the app uses it yet.


---

## Part 1 — Getting started (1–6)


### 1. Create an account & sign in
**Goal:** Create a Portol account, sign in with email or Google, and reset a forgotten password.
**Where to find it:** Go to portol.me. If you're signed out, the sign-in screen opens on its own. It has two tabs, **Sign In** and **Create Account**. The reset page lives at `portol.me/#/auth/forgot-password`.
**What it is:** The front door to Portol. You can sign in with your Google account or with an email and password. Below the sign-in card is a short tour: a "What Portol Does" carousel, a "Try Saying" list of example chat commands and a "How It Works" section.
**Step-by-step:**
1. Open portol.me. You'll see the Portol logo and the line "Your AI-powered life command center".
2. **To create an account:** tap the **Create Account** tab (the card reads "Get started"). Fill in **Email**, **Password** (placeholder "At least 8 characters") and **Confirm Password**, then tap **Create Account**. You're signed in right away. There's no confirmation email.
3. **Or** tap **Continue with Google** on either tab.
4. **To sign in:** on the **Sign In** tab (the card reads "Welcome back"), enter **Email** and **Password**, then tap **Sign In**.
5. **Forgot your password?** Tap **Forgot password?** under the Sign In button. On "Reset your password", enter your **Email** and tap **Send Reset Link**. You'll see "Check your email".
6. Open the emailed link. On **Set New Password**, fill in **New Password** and **Confirm New Password**, then tap **Reset Password**. You'll see "Your password has been reset", and the app sends you back automatically.
7. Already signed in? To change your password, open the round avatar (top right) and choose **Change Password**. To sign out, choose **Sign Out** from the same menu.
**Point out on screen:**
- If you submit with a field empty, a red message appears under it, e.g. "Email is required".
- If you try too many times, the error box counts down: "Too many attempts — try again in 60s".
- Below the card: "Your data is secured with row-level security. Only you can access your information."
- The **Sign In Now** button at the bottom of the tour scrolls you back up to the form.
**Gotchas / FAQ:**
- *"Passwords don't match" or "Password must be at least 8 characters"?* Fix the field and submit again.
- *On the reset page the hint says "At least 6 characters".* The real minimum is 8.
- *I signed up with an email that's already registered and got "Invalid email or password".* That email already has an account. Use **Sign In** or **Forgot password?** instead. [verify in app]
- *The reset link says "Invalid reset link. Please request a new one."* The link has expired or was already used. Request a new one.

---

### 2. The onboarding wizard
**Goal:** Know what Portol's three-step welcome wizard does and how to finish it.
**Where to find it:** [verify in app] The wizard is built (`OnboardingWizard`), but nothing in the app opens it right now, so new accounts may never see it. When it does open, it's a pop-up that can't be closed, and it shows only to new accounts with no data of their own yet. A new account lands on **Dashboard** (`/#/dashboard`).
**What it is:** A short welcome that introduces the main features, offers to create your first profile and ends with tips. It's built to appear once. If your account already has extra profiles, trackers or tasks, it's skipped.
**Step-by-step:**
1. **Step 1 — Welcome.** The title reads "Welcome to LifeOS". Four cards appear: **AI Chat**, **Profiles**, **Trackers** and **Dashboard**. Tap **Let's Get Started**.
2. **Step 2 — About You.** "Create your first profile to get started." Fill in **Name** (placeholder "Your name"), pick a **Profile Type** (**Person**, **Pet**, **Vehicle**, **Property** or **Asset**) and add **Notes (optional)** if you like. Tap **Create Profile**, or tap **Skip for now**.
3. **Step 3 — You're All Set!** Four tips appear: upload documents in Chat, use the Dashboard, create trackers, and ask the AI anything. Tap **Go to Dashboard**.
**Point out on screen:**
- The progress dots at the top fill in as you move through the steps.
- **Create Profile** stays greyed out until you type a name.
- You can't close the wizard by tapping outside it or pressing Esc. Finish it or skip through it.
**Gotchas / FAQ:**
- *It says "LifeOS", not "Portol".* That's the wizard's current wording, an old name for the app. Fix it before recording, or mention it in the video.
- *I didn't see a wizard.* Expected today, because nothing in the app opens it. It's also skipped for any account that already has data. [verify in app]
- *If saving fails at the end,* you'll see "Could not save onboarding state", but you still go to the Dashboard. The wizard may show again next time.

---

### 3. Getting around: sidebar, mobile bottom nav, search, keyboard shortcuts
**Goal:** Move between Portol's main areas on desktop and phone, and jump anywhere with search or the keyboard.
**Where to find it:** On desktop, the left sidebar. On a phone, the bar along the bottom. Both list the same four tabs: **Chat** (`/#/chat`), **Dashboard** (`/#/dashboard`), **Calendar** (`/#/calendar`) and **Artifacts** (`/#/artifacts`). The desktop sidebar also has **Settings** at the bottom. The top header has a **Search** button (shows ⌘K), a bell (Notifications), a light/dark toggle and your avatar menu.
**What it is:** Four main tabs cover the whole app. Dashboard holds a row of section chips: **Executive**, **Trackers**, **Finance**, **Wellness**, **Assets**, **Liabilities**, **Documents** and **Info**. Search finds any record by name and also works as a launcher for creating things and jumping to pages.
**Step-by-step:**
1. On desktop, click a sidebar tab. The active tab is highlighted in its own colour. Click the Portol logo to go to **Chat**. Use the sidebar toggle in the header to collapse the sidebar.
2. On a phone, tap a tab in the bottom bar. Swiping left or right across the page also switches tabs. [verify in app]
3. Open **Search**: click the header **Search** button, or press **⌘K** (Mac) / **Ctrl+K** (Windows). The box reads "Search everything… (Esc to close)".
4. Before you type, the list shows **Recent Searches** (if you have any), then **Create** (New document, New spreadsheet, New journal entry, Log an expense, New task, New habit, Scan receipt, Generate weekly review), then **Quick Actions** (Go to Dashboard, Chat, Trackers, Profiles, Finance, Tasks, Habits, Journal, Calendar, Artifacts, Bills, Settings, and Insights).
5. Type a name. Results are grouped by kind, e.g. Trackers, Tasks, Expenses, Events, Documents, Habits, Journal, Bills and Artifacts. Pick one to open it.
6. Single-key shortcuts work when no text box is selected: **D** Dashboard, **C** Chat, **T** Trackers, **P** Profiles, **F** Finance, **K** Tasks, **H** Habits, **J** Journal, **L** Calendar, **A** Artifacts, **O** Bills, **S** Settings, **I** Insights. **⌘/ (Ctrl+/)** opens Chat with the message box ready to type in.
**Point out on screen:**
- Results from outside your current profile selection are still shown, marked "outside current scope".
- "No results found" means nothing matched. "Search timed out" with a **Retry** button means the search itself failed.
- On a phone, pull down at the top of a page to refresh it ("Pull to refresh" → "Refreshing...").
**Gotchas / FAQ:**
- *I typed a letter and the page jumped.* Single-key shortcuts only fire when no text box is selected. Click into a field before typing.
- *Is there a list of shortcuts in the app?* No. The search list doesn't show the letters, so mention them in the video.
- *⌘N / ⌘J?* In this version they only open the Dashboard. No task or journal form opens. Your browser may also catch ⌘N for a new window. [verify in app]
- *Where's Profiles / Finance?* Inside **Dashboard**, as section chips along the top.

---

### 4. Install Portol as an app
**Goal:** Put Portol on your home screen or desktop so it opens like a regular app.
**Where to find it:** In browsers that support installing (Chrome, Edge, Android), an **Install Portol** card can appear in the bottom-right corner. On iPhone Safari, use the Share menu and choose **Add to Home Screen**. That's Safari's own menu, not a Portol screen.
**What it is:** Portol is a web app you can install. Once installed, it opens full-screen with its own icon and no browser bar. A native iOS app wrapper also exists. It loads the live portol.me site inside the app, so it always has the latest version. Whether it's available in the App Store is [verify in app].
**Step-by-step:**
1. Open portol.me in Chrome or Edge (desktop or Android) and sign in.
2. If the browser allows it, a card appears: "Install Portol — Add to your home screen for quick access". Tap **Install**.
3. Confirm in the browser's own install dialog. Portol now shows up as an app icon.
4. No card? Use the browser's menu instead (e.g. Chrome's install icon in the address bar or "Install app"). [verify in app]
5. On iPhone or iPad: open portol.me in Safari → **Share** → **Add to Home Screen** → **Add**. The icon is labelled "Portol".
6. iOS App Store app: [verify in app]. Check whether it's published or on TestFlight.
**Point out on screen:**
- The installed app opens full-screen in portrait with a dark background.
- The install card hides by itself after about 15 seconds.
- Tapping **X** hides the card until you close that tab. Open Portol in a new tab and it can show again.
**Gotchas / FAQ:**
- *I never see the Install card.* iPhone Safari never shows it, and neither do browsers that don't support installing or copies that are already installed. Use the browser menu or Add to Home Screen.
- *Do I need to update the installed app?* No. It loads the latest version every time you're online.
- *Will my data be on the device?* Your data stays in your account online. The app keeps only a short-term copy of recently viewed data to speed up opening. See tutorial 5.

---

### 5. Offline mode
**Goal:** Understand what Portol does when you lose your connection.
**Where to find it:** You don't open it. It turns on by itself. When your device goes offline, a red pill reading **You're offline** appears at the bottom-centre of the screen.
**What it is:** Portol needs the internet to load and save your data. If you lose your connection, it tells you, and it can keep showing data you viewed recently (up to about 24 hours old) on that device. Nothing you change while offline is saved for later, so wait until you're back online to add or edit things.
**Step-by-step:**
1. Use Portol normally while online. It quietly keeps a copy of the pages and data you've viewed.
2. Turn on airplane mode, or lose Wi-Fi. The red **You're offline** pill appears.
3. Screens you've already loaded keep showing their last data. Moving around may still work for pages you've visited. [verify in app]
4. Avoid saving changes. Without a connection they fail, and you'll typically see an error message like "Couldn't save". [verify in app]
5. Reconnect. The pill disappears. Pull down to refresh (on a phone) or reopen the page to get the latest data.
**Point out on screen:**
- The red **You're offline** pill shows and hides by itself.
- Data you looked at earlier is still on screen. Data you never opened won't be there.
- Opening the app again with no connection may still load it from the copy on your device. [verify in app]
**Gotchas / FAQ:**
- *Can I log an expense or chat with the AI offline?* No. Saving and chat need a connection, and nothing is queued to send later.
- *Is what I'm seeing offline up to date?* Maybe not. It's the last copy you loaded. Copies older than about 24 hours are thrown away.
- *An empty list while offline* doesn't mean your data is gone. Reconnect and refresh.

---

### 6. Quick-create button (FAB) & Quick Add dialog
**Goal:** Add an expense, income, bill, note or timed task in seconds without leaving the Dashboard.
**Where to find it:** [verify in app] The round green **+** button (labelled "Quick create") is built but isn't shown anywhere in the app today. The **Quick Add** forms are live, and these buttons open them:
- **Dashboard → Executive** daily briefing → **View all bills** → **Add Bill**
- **Bills** page (`/#/bills`) → **Add Bill**
- **Dashboard → ⋮ (Dashboard menu) → Customize** → turn on **Quick Actions**. This adds a row of buttons: **Expense**, **Income**, **Bill**, **Note**, **Task**.
- **Add expense** / **Add bill** buttons inside some dashboard spending and bills cards [verify in app]
**What it is:** A small form that saves a record without taking you to another page. Each type asks only for what it needs, and the new record shows up across the app right away.
**Step-by-step:**
1. Tap one of the buttons above, e.g. **Expense**.
2. In **Add expense** ("A one-time spend."), fill in **Description** (required), **Amount ($)** (required), **Category**, **Vendor (optional)** and **Date**.
3. **Add income** adds a **Frequency** field. **Add bill** asks for **Name**, **Amount ($)**, **Frequency**, **Category**, **Next due** and an **Autopay** switch.
4. **Add note** has just one box ("What's on your mind?"). **Add task** has **Title** and **When** (a date and time). The task "Lands on your calendar at that time".
5. For expenses, income and bills, pick **Whose is this?**. The line under it confirms, e.g. "Saved to your records".
6. Tap **Save** (or press Enter). A "Expense added" message pops up, and the form closes.
**Point out on screen:**
- A required field left empty turns red after you tap **Save**.
- Amounts over $1,000,000 ask you to confirm first: "That's $X. Save again to confirm."
- The new record shows up on the Dashboard and Finance screens right away.
**Gotchas / FAQ:**
- *Where's the floating + button?* It isn't shown in the current version. Use the buttons above, or just tell Chat.
- *Can I make a tracker here?* No. Trackers are created only through Chat.
- *Wrong owner?* The **Whose is this?** picker sets who the record belongs to. It doesn't change which profiles you're viewing.
**Example chat prompts:**
- "I spent $45 on groceries at Whole Foods"
- "I got paid $3,200 salary today"
- "Add a monthly rent bill of $1,800 due on the 1st"
- "Remind me to mow the lawn Saturday at 10am"
- "Note: the car is making a squeaking noise"

---

## Part 2 — AI chat (7–18)


### 7. Talk to Portol: logging anything in plain language
**Goal:** Log health data, spending, tasks, events and more by typing (or speaking) one normal sentence.
**Where to find it:** The first item in the sidebar (desktop) or bottom bar (mobile) is **Chat** (route `/chat`). Clicking the Portol logo also opens Chat. Keyboard: press **/** from anywhere to jump to Chat with the cursor in the message box.
**What it is:** Chat is the main way to put things into Portol. You write what happened the way you'd text a friend, and Portol works out where it belongs: a tracker, an expense, a task, a calendar event, a bill payment, a habit check-in and so on. Each thing it saved shows up as a card under the reply, so you can see exactly what changed.
**Step-by-step:**
1. Open **Chat**. The box at the bottom is labelled **Message** and shows the hint "Ask me anything...".
2. Type a sentence. Press **Enter** or the **Send** button to send it. **Shift+Enter** starts a new line.
3. Optional: tap the microphone (**Voice input**) to dictate instead. It works in Chrome or Safari.
4. Read the reply. Every saved item appears as a card under it, showing the name, amount, date and who it's for.
5. Tap a card to open that record's page. Tracker-entry cards have **✎ Edit**. Most cards that created something have **× Delete**. A profile update has **↶ Revert**.
6. To clear the conversation, tap the circular-arrow **Reset chat** button.
**Example chat prompts:**
- "Weighed 182 lbs this morning"
- "Spent $64.20 at Costco on groceries"
- "Remind me to call the dentist Friday at 10"
- "BP 128/82, pulse 71"
- "Paid the electric bill, $142"
- "I did my morning walk"
**Point out on screen:** Several things saved from one sentence (each gets its own card). The "→ name" tag on a card shows who the record was saved for. A card with a problem shows an amber ⚠ warning. Messages can be searched with the magnifier (**Search messages**).
**Gotchas / FAQ:**
- *I mentioned a friend's name. Did it make a profile?* No. See tutorial 12.
- *Is my chat saved forever?* The transcript is kept for the browser session, and **Reset chat** clears it. Your records are saved either way.
- *Simple readings save instantly.* That's **Fast-Path Commands** (Settings → **AI & Chat**): common logs like weight, BP or mood skip the AI step so they save faster.

---

### 8. Chat suggestions & follow-up prompts
**Goal:** Use Portol's personalised suggestion cards and follow-up chips to log or ask things in one tap.
**Where to find it:** **Chat** (`/chat`). Suggestions appear on a fresh or reset chat under the heading **Suggested for you**. Follow-up chips appear above the message box after a reply.
**What it is:** When you open a new chat, Portol greets you ("Good morning/afternoon/evening, <name>.") and suggests a few things based on your own records: a habit still due today, a bill coming up, a document about to expire, or a tracker you haven't logged in a while. Each suggestion says why it's there. After Portol does something, it offers short follow-up chips about what just happened.
**Step-by-step:**
1. Open **Chat**, or tap **Reset chat** to start fresh.
2. Read the summary line under the greeting, e.g. "2 things need you · 1 tracker gone quiet".
3. Look at the cards under **Suggested for you**. Each has a label ("Pay Rent", "Log weight") and a reason ("due Friday", "last logged 6 days ago", "still due today", "expires …").
4. Tap a card. Its text is placed in the message box, but it is **not sent yet**. Edit it if you need to (add an amount, say), then press **Send**.
5. After a reply, look above the message box for follow-up chips. They work the same way.
**Example chat prompts** (what the chips put in the box):
- "Pay Netflix $15.49"
- "Log weight"
- "Open my passport"
- "What's my weight trend?" (after logging a tracker)
- "Remind me about that tomorrow" (after creating a task)
- "How much have I spent this month?" (after logging an expense)
**Point out on screen:** The reason line under each card. A brand-new account gets starter cards instead ("Track my weight", "Spent $50 on groceries", "Remind me to call the dentist Friday", "Add my car"). When chatting as one person or pet, the suggestions are for them, e.g. "Log a vet visit for Max · you're chatting as Max".
**Gotchas / FAQ:**
- *I tapped a suggestion and nothing happened.* It only fills the box. Press **Send**.
- *The follow-up chips disappeared.* They hide while you're typing or have a file attached.
- *Why are they different from yesterday's?* They're worked out from your current data each time, not a fixed list.

---

### 9. Reviewing proposed actions (Extraction Review: edit/add/remove before saving)
**Goal:** Check, correct, re-route, add or turn off everything Portol plans to save from a document before anything is written.
**Where to find it:** After you choose **Extract text & save** on an attachment in **Chat** (tutorial 10). A single file opens the full-screen **Review Document** page (route `/documents/<id>/review`). Several files at once show the review inside the chat reply.
**What it is:** Portol reads the document and shows you three things: what the document is, what it plans to do with it, and every piece of data it found. Nothing is saved until you confirm. You can switch any planned action off, change where it goes, fix values, or add your own actions.
**Step-by-step:**
1. At the top, check what Portol thinks the document is: the document type, a confidence pill (**Confident** / **Fairly sure** / **Unsure**), "About <name>" and any "Also mentions …".
2. Read **Proposed actions** and its count. The summary sentence lists what will be written (e.g. expense, recurring bill update, calendar rule).
3. Each action has a switch (**Save this** / **Don't save this**). Turn off anything you don't want.
4. Use the destination menu ("Change where this is saved") to move an action somewhere else.
5. Tap "Show the N fields this came from" to check and edit the values behind an action.
6. To add your own action, tap **+ Add action**, tick the fields, pick a destination (and a record or amount if asked), then tap **Add**.
7. Use **Link to profile…** to set whose document it is.
8. Finish with **Confirm** (inline) or **Confirm All** (full-screen page). Use **Skip** / **Skip All** to save nothing.
**Example chat prompts:** (no prompt needed: the review appears after an upload). Useful follow-ups afterwards:
- "Link that registration to my Honda"
- "Undo that"
**Point out on screen:** The effects listed under a date action (saved, put on the Calendar, reminder alert). The amber "N needs a decision before it can be saved" message, with **Review** / **Link Anyway** on the full-screen page. Rows marked "document only". The collapsed **Extracted data · N** list, where nothing is ever lost.
**Gotchas / FAQ:**
- *Confirm is greyed out.* Every action is switched off. Turn at least one on, or use Skip.
- *An action says "No save destination".* Portol understood it but has nowhere in the app to save it. It's shown for your information only.
- *It wants to "Update recurring bill" but I don't have one.* Documents only update bills you already have. They never create a new bill.

---

### 10. Uploading documents & photos in chat (receipts, insurance cards, bills: what gets extracted)
**Goal:** Attach a photo or file in Chat and either just store it, or let Portol pull out the details.
**Where to find it:** **Chat** → the paperclip (**Attach file or image**) or the camera (**Take photo / pick image**, which opens the camera on a phone) inside the message box.
**What it is:** You can attach photos, PDFs, Word, Excel, PowerPoint, CSV, text and JSON files (up to 10 MB each). Portol can simply file the document under a person or thing, or read it and propose what to save. A paid receipt becomes an expense. A utility bill or premium notice with a due date can update an existing bill. An insurance card or ID gives member numbers and expiry dates, and future dates can go on your calendar. Lab results can become tracker entries.
**Step-by-step:**
1. Tap the paperclip or camera and pick a file.
2. Choose the **Owner** chip (e.g. "Alex (me)"), then **Belongs to**: either "📁 <name>'s documents" or a specific vehicle, property, account and so on. The line underneath confirms "Saves to …".
3. Optional: type in "Add a note about this file...".
4. Under "What do you want to do with this file?", pick one:
   - **Save to Profile**: "Just store the file. No AI processing."
   - **Extract text & save**: "AI reads the file, pulls fields, you confirm." This leads to the review (tutorial 9).
   - **Fill this form (PDF)/(image)**: "AI fills blanks from your saved data, you review."
5. Optional: tick **Don't keep the photo — extract only** to keep the fields but not the image.
6. For several files: set **Link all to:**, then tap **Upload All (N files)**.
**Example chat prompts:** (type into the note, or ask after uploading)
- "This is Mom's new insurance card"
- "Receipt for the brake job on the F-150"
- "What's the member ID on my insurance card?"
- "When does my car registration expire?"
**Point out on screen:** The three choices and how they differ. "Not linked" lets the AI pick the destination for you. A paid receipt becomes an expense, but an unpaid bill or a quote doesn't.
**Gotchas / FAQ:**
- *My bill didn't become an expense.* Only proof of payment does (a receipt, or an invoice stamped PAID). A bill with a balance due is not an expense.
- *The upload failed on cellular.* Your file stays attached. Tap Send again. Re-uploads don't create duplicates.
- *Turn off automatic receipt expenses* with **Auto-Expense from Documents** (Settings → **AI & Chat**).

---

### 11. Item & nutrition enrichment cards
**Goal:** Understand and act on the cards Portol shows after it looks up exact product details for something you logged.
**Where to find it:** Under a chat reply after you log a food or add a specific item. The setting is **Settings → AI & Chat → Enhanced Item Lookup** (**Automatic** / **Ask when uncertain** / **Off**).
**What it is:** When you log a branded food, medication, supplement, pet food, vehicle, device or subscription plan, Portol can look up the exact product: label nutrition, active ingredient and strength, MPG and tank size, specs or plan price. The record is always saved first. Every number says how sure Portol is, and anything you typed yourself is never replaced.
**Step-by-step:**
1. Log something specific, e.g. "Had a Chobani vanilla Greek yogurt".
2. A card appears under the reply:
   - **Nutrition refined**: already applied. It shows the matched item, source, confidence, calories, protein, carbs, fat (plus sugar, sodium, caffeine when present) and the "Serving basis".
   - **Nutrition enrichment available**: waiting for you. Tap **Use exact match** or **Use generic estimate**.
3. To fix the amount, tap **Edit serving size**, enter a **Portion ×** number (e.g. 0.5 or 2), then tap **Apply**.
4. For non-food items the card is titled by kind: **Medication identified**, **Supplement identified**, **Pet food identified**, **Vehicle specs**, **Device specs**, **Plan details** and others. If it's waiting for you, tap **Save these details** or **Keep as saved**.
**Example chat prompts:**
- "Ate a Big Mac and medium fries"
- "Started Lisinopril 10mg daily"
- "Bought a 2022 Toyota RAV4 Hybrid"
- "Max eats Purina Pro Plan Large Breed"
- "Signed up for Spotify Family"
**Point out on screen:** Confidence words ("exact product match", "close product match", "generic estimate", "rough estimate"). The "≈" sign on estimated numbers. "(not saved)" on details shown for information only. "as you stated" for values you gave.
**Gotchas / FAQ:**
- *I never see buttons.* In **Automatic** mode, confident matches are applied for you. Choose **Ask when uncertain** if you want to decide yourself.
- *It assumed a serving.* The card says "(assumed — you did not say how much)". Use **Edit serving size**.

---

### 12. Profile suggestion cards (why a mentioned name doesn't auto-create a person; accepting the offer)
**Goal:** Understand why naming someone in chat doesn't create a profile, and how to create one when you want it.
**Where to find it:** **Chat**. When an offer applies, a small card marked **Optional** appears above the message box.
**What it is:** In Portol, a name is just information. It doesn't count as permission to add a person. If you say "Bob's birthday is Sep 30", Portol saves a yearly birthday event under you and does not create a "Bob" profile. It then offers to make one. You can accept, ignore or decline, and your birthday event is saved either way.
**Step-by-step:**
1. Type something that names a person or pet with no profile yet, e.g. "Bob's birthday is September 30, remind me every year".
2. Check the reply. The event or task was saved under you.
3. Read the card: "Would you also like to create a profile for **Bob**?" Pets say "a pet profile" and doctors or providers say "a provider profile".
4. Tap **Yes, create profile**. Portol sends "Create a person profile for Bob" for you and creates it.
5. Or tap **No, just keep the record** (for pets: "No, just keep the entry"). Nothing extra is written.
6. To create a profile directly at any time, say so explicitly: "Create a profile for Bob" or "Add my cat Luna".
**Example chat prompts:**
- "Bob's birthday is September 30" (creates a yearly event, then offers a profile)
- "Call Mike at 3pm tomorrow" (creates a task, then offers a profile)
- "I bought Sarah a $40 gift" (logs an expense, then offers a profile)
- "Create a profile for Bob" (creates the profile)
- "Add my cat Luna" (creates a pet profile)
**Point out on screen:** The record is saved before you answer. If Bob's profile is created later, it picks up Bob's existing birthday events, which move over instead of being copied. The screen never shows "Bob Robertson" as the owner of "Jordan's birthday".
**Gotchas / FAQ:**
- *I said No. Will it ask again?* No. Each name is offered only once.
- *It didn't offer anything.* A profile with that name already exists, the name was offered before, or the name looks like a typo of an existing profile (like "Bbo" for "Bob").
- *How many offers at once?* At most two per reply.

---

### 13. Undo last action / undo last payment
**Goal:** Reverse a mistake Portol made, or one you made, from chat.
**Where to find it:** **Chat**. Ask in words, or use the buttons on the action cards under a reply.
**What it is:** Portol keeps a log of everything it does from chat. Saying "undo that" reverses the most recent change that can be reversed: new items are deleted, deleted items come back, and edits go back to their old values. If something can't be reversed, Portol tells you so honestly. A separate command removes the most recent payment on a recurring bill, so the bill shows as unpaid again.
**Step-by-step:**
1. Right after a mistake, type "undo that".
2. To go back further, name it: "undo the expense I logged for Starbucks". Portol looks through your recent chat actions.
3. For a bill you marked paid by mistake, type "I didn't actually pay the electric bill".
4. Or use the card buttons:
   - **× Delete** removes a record the reply created. The card turns red, is struck through and shows "· DELETED".
   - **↶ Revert** restores the previous values after a profile update.
5. To check what happened, ask "what did I just do?".
**Example chat prompts:**
- "Undo that"
- "Take that back, I didn't mean to"
- "Undo the task I just created"
- "Unmark the rent as paid"
- "Undo that payment"
- "Show my recent actions"
**Point out on screen:** The confirmation toast ("Deleted: …", "Reverted"). The struck-through card. Portol's honest message when an action can't be reversed.
**Gotchas / FAQ:**
- *Does **× Delete** ask for confirmation?* In the current build it deletes on the first tap. **[verify in app]**
- *Can I undo a bulk delete?* Deleted tasks, habits, expenses, income, events, documents and goals can be restored with "undo that". Other kinds are deleted permanently, and the preview says so.
- *"Undo that payment" vs "undo that":* the first is only for recurring bill payments. The second works on any recent chat action.

---

### 14. Memory: teach Portol facts, recall, update, delete
**Goal:** Tell Portol preferences and facts once, ask for them later, and keep them up to date.
**Where to find it:** **Chat** for saving, recalling, updating and deleting. Saved facts are listed under **Facts from chat** on the **Profiles** page (`/profiles`, reached via ⌘K/Ctrl+K search → "Go to Profiles") and on your own profile's Info tab. **[verify in app]** the exact navigation to Profiles on mobile.
**What it is:** Portol remembers general preferences that aren't about one particular profile, like "I prefer window seats" or "I'm vegetarian". Facts about a person or thing (sizes, phone numbers, a VIN) are saved on that profile's Info instead. When you ask "what's my …?", Portol searches all of it: saved facts, every profile field, and the details read from your documents.
**Step-by-step:**
1. Teach: "Remember that I prefer aisle seats". The card under the reply is labelled **Remember**.
2. Recall: "What's my gate code?" or "What's the VIN on my Honda?". Portol answers and says where the answer came from.
3. Update: "Actually my gate code is 4321". Portol changes the existing fact and does not add a second one.
4. Delete: "Forget my gate code".
5. Manage by hand: open **Profiles** → **Facts from chat**. Tap a fact to edit it, then use ✓ to save. Tap the **X** in its corner to remove it.
**Example chat prompts:**
- "Remember I'm allergic to penicillin" (may be saved to your profile's medical info instead)
- "Remember I like reminders the evening before"
- "What's Mom's phone number?"
- "What's my license plate?"
- "Update the wifi password memory to BlueFox77"
- "Delete the memory about my old gym"
**Point out on screen:** The answer names its source (e.g. "Honda CRV 2021 · vin"). Concrete facts land on the profile's Info tab rather than in Facts from chat.
**Gotchas / FAQ:**
- *My fact isn't in Facts from chat.* It was a fact about a person or thing, so it was saved to that profile instead. Check the profile's Info.
- *Facts from chat is missing.* The section only appears once at least one fact is saved.

---

### 15. Charts, tables & reports from chat
**Goal:** Ask Portol to show your data as a chart, a table or a full report, right in the chat.
**Where to find it:** **Chat**. Just ask. Results appear inside the reply.
**What it is:** Portol can draw real charts from your trackers, spending, bills, habits, goals, assets and tasks: line, bar, area, pie, scatter, combined and radar. It can also build a table (sortable and filterable from your request) or a multi-section report. Reports come in financial, health, life scorecard, profile, goal progress and weekly digest versions.
**Step-by-step:**
1. Ask for a chart: "Show my weight trend for the last 3 months".
2. The chart card has a title, optional headline numbers, the chart itself (hover for values), and sometimes notes and a **Confidence** line.
3. Tap **Copy** to copy the chart's data as text. Tap the header or chevron to collapse or expand it.
4. Ask for a table: "Table of my expenses over $100 this month". The header shows "(N rows)" and has a copy icon that copies the table in a spreadsheet-ready format.
5. Ask for a report: "Give me a financial report for this month". Each section can be collapsed on its own.
**Example chat prompts:**
- "Show my carbs this week"
- "Pie chart of my spending this month"
- "Graph my blood pressure last month"
- "Table of all my tasks due this week"
- "Weekly digest"
- "Life scorecard for this year"
**Point out on screen:** Gaps in a chart are real days with no data (the range is filled in on purpose). For multi-value trackers like Nutrition, name the exact metric (carbs, protein). Copy-and-paste into a spreadsheet.
**Gotchas / FAQ:**
- *It charted calories, not carbs.* Say the metric: "show my **carbs**".
- *Can I save a chart?* Ask Portol to "create an artifact"/"save this as a note". Artifacts live under the **Artifacts** tab. **[verify in app]** whether a chat chart can be saved directly.
- *Charts for one person:* add "for Mom" or "for Max".

---

### 16. Bulk actions (preview, then confirm deletes)
**Goal:** Delete many records at once safely, by seeing exactly what will go before anything is removed.
**Where to find it:** **Chat**. Ask in words. No separate screen.
**What it is:** Instead of deleting things one at a time, you can say "delete all my test tasks". Portol first shows a preview: how many records of each kind, some example names, and whether a profile is included. Nothing is deleted at this point. Portol only acts after you confirm in a new message, and it checks again that nothing changed in between.
**Step-by-step:**
1. Describe what to delete with at least one filter: words in the name, a profile, or dates (on, before, after).
2. Read the preview, e.g. "Bulk delete preview: 12 records (9 tasks, 3 expenses). Nothing has been deleted — confirm to proceed (plan expires in 15 minutes)."
3. If it's right, send a new message: "Yes, delete them".
4. If not, narrow it down: "Only the ones before June".
5. Changed your mind afterwards? Say "undo that".
**Example chat prompts:**
- "Delete all my test tasks"
- "Remove all expenses containing 'lunch' from before June"
- "Delete all my expenses from today"
- "Clear out everything for the Demo profile"
- "Mark all overdue tasks done" (bulk complete, a non-delete example)
**Point out on screen:** The counts and example names in the preview. The words "Nothing has been deleted". What happens if data changed between preview and confirm: Portol cancels and shows a fresh preview.
**Gotchas / FAQ:**
- *It won't delete straight away.* That's on purpose. Confirm in your next message.
- *"That plan expired."* Previews last 15 minutes. Ask again.
- *Can I get them back?* Tasks, habits, expenses, income, events, documents and goals can be restored. Other kinds can't, and Portol says so.
- *"Delete everything"* is refused without a filter.

---

### 17. Data cleanup with AI (find duplicates, merge profiles, repair orphans)
**Goal:** Use chat to find and fix duplicates, double profiles and broken links in your data.
**Where to find it:** **Chat**. Ask in words.
**What it is:** Portol has cleanup helpers that look before they touch anything. "Find duplicates" only lists likely doubles and never deletes. "Merge" combines two profiles after showing a preview. "Check my data" looks for records linked to a missing or wrong owner, and "repair my data" fixes them once you've seen the list. Portol can also find things wrongly filed as people (like "my MacBook Pro") and fix them.
**Step-by-step:**
1. Ask "Do I have duplicate expenses?" (or profiles, tasks and so on). Review the candidates.
2. To combine two profiles: "Merge the duplicate Mike profiles" or "Combine Mother into Mom". Portol shows a preview of how many records and sub-profiles will move. Nothing changes yet.
3. Confirm in your next message: "Yes, merge them". The extra profile is archived and its records, children and missing details move to the one you keep.
4. Ask "Check my data for orphaned records". Portol lists up to 25 issues.
5. Say "Repair my data" to fix them.
6. Ask "Why is my MacBook a person?" or "Fix my profile types". Review the list, then confirm the fix.
**Example chat prompts:**
- "Find duplicate profiles"
- "Any doubled-up tasks?"
- "Merge Mom and Mother into one"
- "Is my data healthy?"
- "Fix the broken links"
- "Is my data isolated correctly?"
**Point out on screen:** Every fix is a two-step process (look, then fix). The merge preview counts. The merged profile is archived and can be brought back with "undo that".
**Gotchas / FAQ:**
- *It found duplicates but didn't remove them.* Finding is read-only. Delete or merge them as a separate step.
- *It won't merge my own profile away.* Your own profile can't be merged into another. Merge the other profile into yours instead.
- *"The data changed since the merge preview."* Run the merge again to get a fresh preview.

---

### 18. Import your finances from ChatGPT
> **Important for the script writer:** In the code this feature is **"Import from ChatGPT"**, a **finance** import. It does **not** import ChatGPT chat transcripts. Portol writes a prompt, you run it in ChatGPT (which already knows about your finances from your past conversations), and you paste ChatGPT's structured reply back. Please present it that way. **[verify in app]** with the owner whether the title should change to "Import your finances from ChatGPT".

**Goal:** Bring the financial details ChatGPT already knows about you into Portol in one checked, undoable import.
**Where to find it:** **Settings** (sidebar, bottom; route `/settings`) → card **Import from ChatGPT** → button **Refresh from ChatGPT**.
**What it is:** Portol creates a prompt that includes your current finances. You paste it into ChatGPT, which replies with your transactions, bills, subscriptions, accounts, assets, liabilities and budgets in a format Portol can read. You paste that reply back, see exactly what's new, updated, duplicated or skipped, and import it all in one go. Every import can be undone.
**Step-by-step:**
1. Optional: pick the person in the profile filter first. The dialog says "Importing into <name>. Data stays locked to this profile."
2. Tap **Refresh from ChatGPT**. The prompt is generated and copied. Tap **Copy prompt** if needed, or use **Open ChatGPT**.
3. Run the prompt in ChatGPT and copy its reply. Back in Portol, tap **Next**.
4. Paste the reply into "Paste ChatGPT's JSON reply:" and tap **Validate & preview**. If there are problems, the list under "Can't import — fix these:" shows them.
5. Review the counts (**New**, **Updated**, **Duplicates**, **Skipped**), any **Smart detection** insights, and each line (New / Update / Dup / Skip).
6. Tap **Import N items**, then **Done**.
7. To reverse an import: go to **Import history** on the same card and tap **Undo**.
**Example chat prompts:** (these go in ChatGPT, not Portol: Portol writes the prompt for you)
- Paste Portol's generated prompt as-is.
- Afterwards in Portol chat: "How much have I spent this month?" / "Show my bills".
**Point out on screen:** Duplicates are skipped automatically. "Net worth, cash flow, budgets and the dashboard have all been refreshed." The **Undo** button in Import history.
**Gotchas / FAQ:**
- *Will it import my old ChatGPT conversations?* No. Only financial records.
- *The import went to the wrong person.* Undo it from **Import history**, choose the right profile, and run it again.
- *Validation failed.* ChatGPT's reply wasn't in the required format. Ask ChatGPT to redo it using the prompt exactly as written.

---

## Part 3 — Dashboard & profiles (19–32)


### 19. Dashboard tour (Executive Briefing, KPI strip, attention items)
**Goal:** Read the dashboard at a glance and know what each part does.
**Where to find it:** Main nav **Dashboard** → **Executive** chip (route `/dashboard`).
**What it is:** The Executive tab is your command center: one screen that answers "how am I doing, and what needs me today?" A strip of live numbers sits at the top, with a grid of cards below it. Tapping almost anything opens a detail pop-up right there, so you don't lose your place.
**Step-by-step:**
1. Tap **Dashboard** in the nav. The **Executive** chip is selected.
2. Point out the KPI strip: **Net Worth**, **Cash Flow**, **Wellness**, **Streak**, **Tasks Due**, **Docs Exp**. On a phone it scrolls sideways. Arrows appear only when chips are cut off.
3. Below that is **Next Important**, the next dated item that matters.
4. Walk through the cards: **Needs Attention** (subtitle "Documents, renewals & deadlines"), **Tasks** (Remaining / Overdue / Completed today), **Schedule** (Next up, Dates to remember), **Habits**, **Money** (This Month: Income / Expenses / Cash Flow), **Documents** (Expired / Expiring / In library, Recently added), **Wellness** (Steps, Sleep, Exercise, Calories, Water), **Upcoming**, and **Recent Activity** at the bottom.
5. Tap a task's circle to complete it. Tap a habit row to check in.
**Example chat prompts:**
- "Refresh my dashboard"
- "Why is the mortgage on my dashboard?"
- "Are my dashboard numbers right?"
**Point out on screen:**
- When nothing needs attention, the Needs Attention card says "You're all caught up".
- A small pulsing dot means a number is updating. "Couldn't load" means the request failed. It never shows a fake $0.
- If loading stalls, a banner reads "Some sections are taking too long to load." with a **Retry** button.
**Gotchas / FAQ:**
- *Why don't I see bills or tasks under Needs Attention?* That card covers documents, renewals and deadlines. Bills live in **Money** and tasks in **Tasks**.
- *Each record appears once.* An item shows in one card only, so it won't be counted twice.

---

### 20. Executive vs Daily view
**Goal:** Switch between the full Executive layout and the lean "Daily ops" focus view.
**Where to find it:** The mode buttons **Executive · Finance · Health · Daily ops**. They appear at the top of the standalone dashboard page, for example route `/dashboard/daily` or `/dashboard/executive`. [verify in app: how users reach this page from the normal UI]
**What it is:** A focus mode changes which dashboard sections show and in what order. **Executive** uses your own saved layout. **Daily ops** is a slim "what do I do today" view with no finance or trends sections. Switching modes never touches your saved layout: go back to Executive and it is exactly as you left it.
**Step-by-step:**
1. Open the standalone dashboard (route `/dashboard/daily`).
2. Tap **Daily ops**. You see **Briefing**, **Now**, **Key Metrics**, **Explore** and **Goals**.
3. Tap **Executive** to return to your saved layout. By default that layout is the briefing card grid from tutorial 19.
4. Optional: try **Finance** (adds the Finance widget and Hero Metrics) or **Health** (leads with Health and Trends).
**Point out on screen:**
- The selected mode is filled in with the accent color.
- Each mode shows a clearly different set of cards, not just a reshuffle.
**Gotchas / FAQ:**
- *I don't see the mode buttons.* They are hidden inside the main Dashboard hub, because the hub's own **Finance** and **Wellness** chips cover those views. They are also hidden when the scope is **Everyone**.
- *The mode is remembered on this device only.* The route does not pick the mode by itself: the page opens in whichever mode you last chose here. [verify in app]
- *Naming:* in **Customize**, the default Executive section is called "Daily Briefing". It is not the same thing as the "Daily ops" mode.

---

### 21. Customizing dashboard sections (show/hide/reorder, incl. via chat)
**Goal:** Choose which dashboard sections show, and in what order, either by hand or by asking the chat.
**Where to find it:** **Dashboard** → the ⋮ button (**Dashboard menu**, top right of the Executive tab) → **Customize**.
**What it is:** The **Customize Dashboard** dialog lists every available section. You can hide or show each one, move it up or down, and place it full-width or in a left or right column. Your layout is saved to your account.
**Step-by-step:**
1. Tap ⋮ → **Customize**. The header shows "Reorder, toggle, and place sections in columns." plus counts such as "3 visible · 17 hidden".
2. Tap the eye icon to hide or show a section. Hidden sections appear struck through.
3. Use the up and down arrows to reorder.
4. Tap the column badge to cycle **Full → Left → Right**.
5. Tap **Save**. A "Layout saved" message appears. **Reset** restores the defaults, and **Cancel** discards your changes.
6. Available sections: Daily Briefing, Briefing, Quick Actions, Action Required, Today's Schedule, Now, Notifications, Upcoming, Bills & Subscriptions, Hero Metrics, Key Metrics, Weekly Summary, Trends, Health, Goals, Key Findings, Explore, Recent Activity, AI Summary, Finance.
**Example chat prompts:**
- "Show the Finance section on my dashboard"
- "Hide the Goals section"
- "Move Goals to the top"
- "What sections are on my dashboard?"
- "Reset my dashboard layout"
- "Undo that"
**Point out on screen:**
- Out of the box, only **Daily Briefing** is visible. A chat reset returns you to "Daily Briefing only".
- A change made in chat appears in the same Customize list.
**Gotchas / FAQ:**
- *My layout disappeared when I picked Everyone.* The Everyone view has a fixed household layout: the briefing plus a **Household** section. Pick a person to see your custom layout again.
- Customize while the **Executive** mode is selected. In other modes, the list shows that mode's preset, and saving would store that preset as your layout. [verify in app]

---

### 22. Attention filters & briefing pop-ups
**Goal:** Tune what Needs Attention shows, and act on items from their pop-ups.
**Where to find it:** **Dashboard** → **Executive** → **Needs Attention** card → the sliders icon (**Attention filters**). Pop-ups open when you tap any card row or "View…" link.
**What it is:** Attention filters set how far ahead Needs Attention looks and how urgent an item must be before it shows. Pop-ups are detail panels that open on top of the dashboard. They let you act (complete, pay, check in, renew, dismiss) without leaving the page.
**Step-by-step:**
1. Tap the sliders icon. Under **Needs Attention**, pick **Look ahead**: 7d / 14d / 30d / 45d / 60d / 90d.
2. Pick an urgency level: **Immediate only**, **Within 7 days** or **Everything**. **Reset to defaults** goes back to 45d and Everything.
3. Items are grouped under colored headings: "Expired · overdue", "Expiring this week", "Expiring this month", "Expiring later", "Also needs attention".
4. Tap a row to open its pop-up. Try **Document Dates · Due & Expiring**, which offers **View**, **Edit**, **Renewed — set new date**, **Dismiss 30d** and **Clear all · 30d**.
5. Try **View all upcoming**. The Upcoming pop-up has filters: All / Tasks / Events / Bills / Other.
6. Tap the sparkle button for **AI advice**. You can dismiss suggestions one by one, or all at once with **Dismiss**.
**Point out on screen:**
- **Pay** takes two taps. The first tap turns the button red and changes it to "Confirm". Money moves only on the second tap.
- Row buttons depend on the item: Complete, Check in, Taken, Done, Reschedule, Pay / Record payment.
- Closing a pop-up leaves the dashboard exactly where it was.
**Gotchas / FAQ:**
- *Does Dismiss 30d change the expiration date?* No. It only hides the alert for 30 days. The date stays on the document.
- Document dismissals are stored on this device. [verify in app: whether they sync to other devices]

---

### 23. Profile scope: viewing everyone vs selected people
**Goal:** Switch whose data the app shows, and recognize when a filter is hiding things.
**Where to find it:** The profile switcher button at the top right of the Dashboard hub. It shows **Everyone**, **My dashboard**, a person's name, or "Name +N".
**What it is:** The profile scope is an app-wide filter. Choose one person, several people, or **Everyone**, and the hub tabs, counts and lists show only those people's records. Hidden items are not deleted. The app tells you when a filter is active.
**Step-by-step:**
1. Tap the switcher. The hint reads "Click a name to view just that person · tick boxes to combine".
2. Tap a name to view just that person. Your own entry shows as "Name (me)", and the button then reads **My dashboard**.
3. Tick the checkboxes to combine several people (for example "Sam +1").
4. Tap **Everyone** for the combined household view. This adds a **Household** section with **Household net worth** and one card per person.
5. Use **View everyone’s info…** to open the **Info** tab for everyone.
**Example chat prompts:**
- "Show me Sam's dashboard only"
- "Switch to Everyone"
- "Only show Max's tasks"
**Point out on screen:**
- An empty list while filtered says "Filtered to Sam — anything for anyone else is hidden, not deleted." with a **Show everyone** link.
- **Tasks** page: "Showing 2 of 5 tasks · filtered by Sam" with **Clear filter**. If the filter hides everything: "No tasks match this filter… are hidden, not deleted."
- **Calendar**: "Showing Sam only — tasks and events for anyone else are hidden, not deleted" with **Show everyone**.
**Gotchas / FAQ:**
- *My tasks vanished!* A leftover selection is probably hiding them. Tap **Show everyone**.
- The Calendar's own filter (**Filter by Person**) and its **Show everyone** link affect only the Calendar, not the rest of the app.
- The app usually opens scoped to you (**My dashboard**), not to Everyone.

---

### 24. Drilling into dashboard numbers (and asking chat to explain them)
**Goal:** See what's behind any dashboard number, and ask the chat to explain or double-check it.
**Where to find it:** Tap any KPI chip in the hub strip, or any card header link on the **Executive** tab. Questions go to **Chat**.
**What it is:** Every number on the dashboard can be opened. Tapping it shows the list of records that make it up. There is no "Explain" button on screen [verify in app]. Explanations and recounts come from the AI chat.
**Step-by-step:**
1. Tap **Net Worth**. The pop-up shows a trend chart with 30D / 90D / 1Y / All and **Assets** / **Liabilities** tabs, each with **Add asset** / **Add liability** buttons.
2. Tap **Cash Flow** to open the cash-flow breakdown.
3. Tap **Tasks Due** for the Tasks pop-up. Tap **Streak** for Habits. Tap **Docs Exp** for Document Dates. **Wellness** opens the Wellness tab itself.
4. On the cards, use **View all tasks**, **View schedule**, **View habits**, **Open finances**, **View all bills**, **View documents** and **View all upcoming**.
5. To ask why something is counted, go to **Chat**.
**Example chat prompts:**
- "Why is the car registration on my dashboard?"
- "Why does this task show as upcoming?"
- "Are my dashboard numbers right?"
- "The task count looks wrong"
- "My counts look stale — refresh my dashboard"
**Point out on screen:**
- The pop-up is filtered by the same profile scope as the chip you tapped.
- Only an explicit "Open…" or "View all…" link takes you to another page. Everything else opens in place.
**Gotchas / FAQ:**
- *The chat's recount matches but the screen doesn't.* Ask "refresh my dashboard". That clears cached counts.
- *A number shows "—".* The data couldn't load. It is not zero.

---

### 25. Creating a profile (types & type-specific fields)
**Goal:** Add a person, pet, asset or other profile with the right details.
**Where to find it:** The floating **Quick create** button → **Profile** ("Add profile"). Also the **Assets** chip → **Add Asset**, and the **Liabilities** chip → **Add Liability**. Quick create also offers **Asset**, **Subscription** and **Loan**.
**What it is:** A profile is a person, pet, vehicle, property, account, subscription or other thing you track. You pick a type, and the form shows the fields that make sense for that type. Then you fill in what you know.
**Step-by-step:**
1. Tap **Quick create** → **Profile**.
2. In "Add profile", search with "Search profile types…" or browse the groups: People, Assets, Liabilities, Subscriptions & Recurring, Insurance, Investments, Property. The exact list of types comes from the server. [verify in app]
3. Choose a type → **Next**.
4. Under **Create Profile**, enter **Name \***, fill in the "<Type> Details" fields (a red \* means required), then add **Tags** (comma-separated) and **Notes**.
5. Tap **Create Profile**. A message confirms '"Name" profile created'.
**Example chat prompts:**
- "Create a profile for my dog Max, a golden retriever born March 2020"
- "Add a profile for my 2021 Honda CR-V, VIN 1HGXXXX"
- "Create a person profile for my mom, Linda"
- "Bob's birthday is Sep 30" (no profile is created; see Gotchas)
**Point out on screen:**
- If you leave required fields empty, the app shows "Fill in the required fields" and outlines them.
- A matching name triggers **Duplicate Profile** → **Cancel** / **Create Anyway**.
**Gotchas / FAQ:**
- *Mentioning a name in chat doesn't create a person.* "Bob's birthday is Sep 30" saves a yearly event. The chat then offers "Would you also like to create a profile for Bob?" with **Yes, create profile** / **No, just keep the record**.
- Use **Add Liability** (or ask the chat about the debt) for loans, cards and mortgages.

---

### 26. The profile page (hero, tabs, info page, shared tabs)
**Goal:** Find your way around a profile and know where each kind of detail lives.
**Where to find it:** People: **Info** chip, or tap a person (route `/profiles/<id>/info`). Assets and other profiles: **Assets** chip → tap a card (route `/profiles/<id>`).
**What it is:** People and pets open an **Info** page: a quick reference for their identity details, notes, tags, documents and activity. Assets, vehicles, properties and subscriptions open a full profile page with a header and tabs. Liabilities have their own page with payment details.
**Step-by-step:**
1. Person Info page: photo ("Change photo"), name with a pencil (**Rename**), a type picker (person / pet), **Add field**, the field grid, **Notes**, **Tags**, **Documents**, "Activity · Name", and **Journal** (**Write entry** / **View all**).
2. Your own Info page also shows **Facts from chat**.
3. Asset page header: back link (**Back to Assets** / **Back to Linked** / **Back to Profiles**), picture, name, type, tag pills, notes, count tiles, **Edit** and **Delete**.
4. Below the header: an AI summary card with **Refresh** (and **Look up value** for valuable items).
5. Tabs depend on the type. A vehicle has **Overview, Contained, Financials, Money, History, Maintenance, Documents, Activity, Notes**. A pet has **Overview, Trackers, Habits, Money, Documents, Reminders, Activity**.
6. Open **History** to see ownership changes, each tagged **AI** or **user**, with **Undo** available for 24 hours.
**Point out on screen:**
- Count tiles that would show 0 are hidden.
- Each tab has its own link (for example `/profiles/<id>/documents`).
- With one person selected in the switcher, the hub chips (Trackers, Finance, Documents…) show that person's data.
**Gotchas / FAQ:**
- *Some tabs are missing.* **Notes** and **Activity** stay hidden until they have content.
- People also have a full tabbed page (**Overview, Finance, Trackers, Documents, Productivity, History**) at `/profiles/<id>/overview`. [verify in app: the on-screen path to it]

---

### 27. Editing profile fields & filling PDF forms with Smart Fill
**Goal:** Correct or add profile details, and use Smart Fill to fill a PDF form from your data.
**Where to find it:** Person: **Info** page field cards. Asset: the **Edit** button in the profile header. Smart Fill: the **Smart Fill PDF** button on a profile's **Documents** tab, also in the **Artifacts** page header.
**What it is:** You can edit any field in place, add custom fields, or remove ones you don't want. Smart Fill is separate: you give it a blank PDF form, and it fills the form with details from the profiles and documents you choose. Smart Fill does not change the profile itself.
**Step-by-step:**
1. On the Info page, tap a field value, edit it, then tap ✓ (**Save**) or ✕ (**Cancel**). The small X (**Remove <field>**) deletes the field.
2. Tap **Add field** → enter **Field** (e.g. Nickname) and **Value** → **Add**.
3. On an asset, tap **Edit** → change **Name**, the suggested fields and **Notes** → **Save**.
4. Smart Fill: on the **Documents** tab, tap **Smart Fill PDF** and choose a PDF (PDF only, up to 10 MB).
5. **Sources**: the current profile is pre-selected. Add more from Profiles / Assets / Liabilities / Documents → **Smart Fill**.
6. "Reading the PDF…" takes about 10–20 seconds. Then **Review** each detected field: you can edit it, untick it, or fill in the "Missing — type if you want them filled" fields.
7. Tap **Fill PDF** → "PDF filled" → **Open filled PDF**. Any reminders it added are listed under "Reminders added".
**Example chat prompts:**
- "Max's microchip number is 985112000123456"
- "Update my blood type to O+"
- "The Honda's mileage is now 48,200"
**Point out on screen:**
- The review step says "Review every field. Nothing is filled until you approve."
- Signature fields carry a **sign manually** badge.
- When it finishes: "The original is untouched — a new filled copy was saved."
**Gotchas / FAQ:**
- *I can't remove Birthday or Age.* Age is calculated from Birthday. Birthday has no remove X, but you can still edit it.
- Smart Fill is not available from the chat.

---

### 28. Linking records (profiles, documents, assets)
**Goal:** Connect documents, assets and debts to the right profiles.
**Where to find it:** Document: open it from **Artifacts** or a profile's **Documents** tab → **Linked Profiles** → **Link to entity**. Asset to debt: asset → **Financials** tab → **Linked Liabilities** → **Link Liability** / **Link**. Debt to asset: liability page → **Linked assets**.
**What it is:** Links tell Portol what belongs to what: a registration to a car, an insurance card to a person, a loan to the house it's secured by. Linked items then show up on each other's pages and in the right totals.
**Step-by-step:**
1. Open a document → under **Linked Profiles**, tap **Link to entity**.
2. Search ("Search entities…") or browse **People / Assets / Liabilities / Other**. When available, **Related** suggestions are listed first.
3. Tick the profiles you want → **Save**. The button now reads "Linked to 2 entities".
4. On an asset's **Financials** tab, tap **Link Liability**, choose the debt, and set the role and %.
5. To undo a link, expand the row → **Unlink from this asset** → **Unlink**.
6. Nesting (for example a laptop inside a home office): asset → **Contained** tab → **Adopt as Child** or **Add Child**. [verify in app: which profile types show these buttons]
**Example chat prompts:**
- "Link the registration to my Honda"
- "Attach that insurance card to Mom"
- "This mortgage is on 123 Maple"
- "The auto loan is for my Civic"
- "Remove the Tesla from this loan"
- "Show everything related to my Tesla"
**Point out on screen:**
- The link button's label counts the links ("Linked to N entities").
- Each liability row shows its role, %, and the secured share of the balance.
**Gotchas / FAQ:**
- *A document can link to several profiles.* Ticking a second profile adds a link. It doesn't move the document.
- Placing an item under a person is location, not ownership. See tutorial 29.

---

### 29. Ownership: owners, co-owners, beneficiaries, % splits
**Goal:** Say who owns an asset or owes a debt, and in what shares.
**Where to find it:** Asset: **Contained** tab → **Ownership** card. Liability: **Overview** → **Ownership** card, plus **Linked people**.
**What it is:** Ownership sets whose net worth an asset or debt counts toward. Shares must add up to exactly 100%. If you set no owners, the item counts toward you at 100%.
**Step-by-step:**
1. Open an asset → **Contained**. The **Ownership** badge reads "Not set" ("Ownership not set — this counts toward <you> at 100%.").
2. Choose a person from **+ Add owner…**. Add a second owner the same way.
3. Drag the sliders or type the percentages. Use **Split evenly** for equal shares.
4. Tap **Save ownership**. It stays disabled until the total is 100%. **Reset** undoes your unsaved edits, and **Clear** removes all owners.
5. Open **Show ownership history** to see past changes.
6. On a liability, the **Linked people** section has **Add Person** → **Add Linked Person**, with **Person**, **Role** (Owner, Co-Owner, Beneficiary, Trustee, Manager, Guarantor) and **Ownership %**.
**Example chat prompts:**
- "Split the Tesla 60/40 between me and Sarah"
- "Make Sarah the beneficiary of my brokerage account"
- "This loan is split 50/50 with my wife"
- "My dad co-signed the car loan"
- "Who owns the house?"
**Point out on screen:**
- The total badge turns green at 100% and amber when the total is wrong. An error line explains the problem.
- "Filed under Sam — that's location, not ownership." with a shortcut button **Assign Sam 100%**.
- A person's **Overview** lists their assets and liabilities with their share.
**Gotchas / FAQ:**
- *Why isn't my 50% saving?* All shares must total 100%. The app never splits the rest for you.
- For assets, roles like beneficiary or trustee are set through the chat. [verify in app: no on-screen role picker on asset pages]

---

### 30. Merging duplicate profiles
**Goal:** Combine two profiles for the same person or thing into one, safely.
**Where to find it:** **Chat**. There is no merge button on screen. [verify in app]
**What it is:** If "Mom" and "Mother" both exist, a merge moves everything from one profile (the source) into the other (the target): records, ownership shares, nested items, and any details the target is missing. The source is archived, not permanently erased, and smaller merges can be undone.
**Step-by-step:**
1. In **Chat**, ask "Find duplicate profiles".
2. Ask to merge, naming which profile to keep: "Merge Mother into Mom".
3. Read the preview. It reads "Merge preview: "Mother" → "Mom" will re-point N records… Nothing has been changed — confirm to proceed (15 min)."
4. Reply "Yes, go ahead" in your next message, within 15 minutes.
5. The result reads 'Merged "Mother" into "Mom": … "Mother" was archived (soft-deleted) — this can be undone.'
6. If it was a mistake, say "Undo that".
**Example chat prompts:**
- "Do I have any duplicate profiles?"
- "Merge the duplicate Mike profiles"
- "Combine Mom and Mother into one — keep Mom"
- "Yes, confirm the merge"
- "Undo that"
**Point out on screen:**
- Nothing changes until you confirm.
- Afterwards, the kept profile's lists and totals include the moved records.
**Gotchas / FAQ:**
- *Which details win?* The kept profile keeps its own values. Only its empty fields are filled in from the merged one.
- Merges that move more than 500 records cannot be undone.
- To avoid duplicates in the first place, watch for the **Duplicate Profile** warning when creating a profile.

---

### 31. Deleting a profile safely
**Goal:** Remove a profile you no longer need, and know exactly what goes with it.
**Where to find it:** Person or pet: **Info** page → **Delete profile** section at the bottom. Asset or other profile: the header **Delete** button, or **Overview** tab → **Danger zone** → **Delete this <type>**.
**What it is:** Deleting a profile permanently removes it and every record only it owns: fields, notes, documents, trackers, tasks, events, expenses, habits, goals and journal entries. Records shared with someone else are kept, with this person removed from them. It cannot be undone.
**Step-by-step:**
1. Person: scroll to **Delete profile**, read the warning, and tap **Delete profile** (it says **Delete pet** for pets).
2. In the dialog "Delete <name>?", choose **Keep** or **Delete everything**.
3. Asset: tap **Delete** → in '"Delete "<name>"?"', choose **Cancel** or **Delete Profile**.
4. A confirmation appears and you return to the profiles list.
**Example chat prompts:**
- "Delete the Test Dog profile"
- "Delete the profile for my old Civic"
**Point out on screen:**
- The warning names what goes and what stays before you confirm.
- Your own profile has no delete option. The app keys everything you own to it.
**Gotchas / FAQ:**
- *What if deletion fails partway?* The profile is kept, and the app shows "This profile couldn't be fully deleted, so it was kept (nothing is left pointing at a missing profile). Please try again."
- Items filed under the profile (for example vehicles under a person) are deleted too. Move them first, or merge instead (tutorial 30). [verify in app]
- Just want the alerts to stop? Use **Clear document alerts** instead (tutorial 32).
- Whether the chat asks for confirmation before deleting: [verify in app].

---

### 32. Profile alerts (expirations, upcoming dates)
**Goal:** See which dates on a profile will raise alerts, and quiet them without losing the dates.
**Where to find it:** Profile page → **Overview** tab → **Alerts** section at the bottom. Alerts also appear on **Dashboard** → **Executive** (**Needs Attention**, **Docs Exp** chip, **Upcoming**).
**What it is:** Dates on a profile's documents (expirations, renewals, due dates) create alerts as they get close. Each profile has one place to see how many documents can raise alerts and to clear them for 30 days. Clearing hides the alert. It never changes the date.
**Step-by-step:**
1. Open the profile → **Overview** → scroll to **Alerts**. It reads, for example, "3 documents can raise due and expiring alerts."
2. Tap **Clear document alerts**. A message confirms: "Hidden from document alerts for 30 days. The dates stay on the records."
3. Tap **Restore alerts** to bring them back right away.
4. On the dashboard, tap a document row → **Renewed — set new date** once you've actually renewed it.
**Example chat prompts:**
- "What's expiring in the next 60 days?"
- "When does Max's rabies vaccine expire?"
- "Mute info notifications"
- "Why is my passport in Needs Attention?"
**Point out on screen:**
- The status line changes to "1 of 3 documents cleared…" after clearing.
- Profiles with no documents read "No documents on this record, so nothing is producing date alerts."
**Gotchas / FAQ:**
- *I uploaded the new registration but still see the old alert.* A newer document of the same kind for the same subject replaces the old alert automatically. If it doesn't, check that the new document is linked to the same profile (tutorial 28).
- *"Jordan's birthday" filed under me?* Undated owners default to you, but the app won't print your name beside someone else's birthday.
- The **Alerts** section appears on full profile pages. Person Info pages may not show it. [verify in app]

---

## Part 4 — Assets, finance & liabilities (33–50)


### 33. Tracking an asset & its current value
**Goal:** Add something you own and see Portol estimate what it's worth now, or set the value yourself.
**Where to find it:** **Dashboard** → **Assets** tab (`/linked?tab=assets`) → **+** / **Add Asset**. Open any asset to reach its profile (`/profiles/<id>`), **Overview** tab.
**What it is:** Every asset (car, home, laptop, collectible, investment) has a value card at the top of its Overview. Portol estimates the current value automatically from what it knows about the item and keeps it up to date in the background. If you prefer, you can switch that off and type in your own value.
**Step-by-step:**
1. On the **Assets** tab, tap **Add Asset** (or the **+** button). The dialog is titled "Add Asset".
2. Pick a type, tap **Next**, then fill in **Name \*** and any type-specific fields. Finish with **Create Profile**.
3. Open the new asset. The **Estimated current value** card shows the estimate and a "Likely $X – $Y" range.
4. Tap **Refresh** to re-run the estimate now.
5. Tap **How this was estimated** to see the method, the evidence and its sources, the notes, and "Would tighten it:".
6. To use your own number, turn off **Track value automatically**. The card changes to **Your current value**. Tap **Tap to set a value**, type the amount and tap **Save**.
**Example chat prompts:**
- "I have a 2021 Honda Civic EX with 42,000 miles"
- "What's my Civic worth now?"
- "Revalue my house"
- "Add my Rolex Submariner as an asset, I paid $9,000 for it"
**Point out on screen:**
- The confidence badge, e.g. "high confidence · 82%".
- "Valued 2d ago" and, while it runs, "Refreshing in background…".
- A value you typed is never overwritten. With auto tracking on, it shows as "Your entered value: $X (kept)".
- With auto tracking off, the card shows a **Set by you** badge.
**Gotchas / FAQ:**
- *It says "Not enough information for a defensible estimate".* Add more details (see tutorial 34).
- *Why doesn't my bank account have an estimate?* Accounts are never estimated. An account is worth its balance.
- *Turning auto off deleted the estimate?* No. It stays under **Last AI estimate (not in use)**, marked as history.

---

### 34. Improve Estimate (better valuation inputs)
**Goal:** Give Portol the missing details it needs to narrow an asset's value range.
**Where to find it:** An asset profile → **Overview** tab: the **Complete this profile** section. The **Tighten this estimate** panel appears in the **AI Summary** card after **Look up value**, and on the **Valuation** tab for collectibles.
**What it is:** When Portol can't price something precisely, it lists the facts that would help (square footage, bedrooms, trim, mileage, condition, VIN…). You fill those in right on the profile. Portol saves them as real profile details and uses them in the next estimate, so the range gets tighter.
**Step-by-step:**
1. Open the asset and expand **How this was estimated** on the value card. Read the "Would tighten it:" line.
2. In the **AI Summary** card, tap **Look up value** (it reads "Looking up…" while it works). Under the result, "Add for a better estimate:" lists what's missing.
3. In the **Tighten this estimate** panel, fill any of the fields (e.g. **Square footage**, **Bedrooms**, **Mileage**, **Trim level**, **VIN**).
4. Tap **Save & re-estimate** to save and run the estimate again right away, or **Save** to keep the details for the next estimate.
5. Or use **Complete this profile** on the Overview: tap a missing item, type the value, and tap **Save**.
**Example chat prompts:**
- "My house is 2,400 sq ft with 4 bedrooms and 3 baths"
- "The Civic has 48,000 miles now"
- "The VIN on my truck is 1FTFW1E50NFA00000"
- "Re-estimate my house value"
**Point out on screen:**
- The panel's note: "fills real profile fields".
- The toast: "Saved 2 details · Re-running the estimate with the new details…".
- The range and confidence change after the re-estimate.
- A VIN fills in the decoded trim and drivetrain if those were empty. [verify in app]
**Gotchas / FAQ:**
- *I don't see Look up value.* It only shows for assets, vehicles, property and investments with **Track value automatically** on.
- *Editing tags or contacts didn't trigger a new estimate.* Only facts that affect value (identity, specs, mileage, condition, purchase, appraisals…) trigger one.

---

### 35. Turning an expense into an asset
**Goal:** Turn a big purchase you logged as an expense into an asset you track.
**Where to find it:** **Chat** only. There's no button for this in the Finance tab.
**What it is:** Sometimes a purchase is really something you own, like a laptop, camera or bike. Ask Portol in chat and it creates an asset profile using the expense's amount as the purchase price and its date as the purchase date. Then it removes the original expense so the money isn't counted twice.
**Step-by-step:**
1. Make sure the expense exists. Check **Dashboard** → **Finance** → **Expenses**.
2. Open **Chat** and say which expense to convert, e.g. "that laptop I expensed is actually an asset".
3. You can give the asset a name and type (asset, vehicle or property). If you don't, Portol uses the expense description and works out the type.
4. Open the new asset from the chat reply, or from **Dashboard** → **Assets**.
5. Check that the purchase price and date are filled in. The value card then starts estimating the current value.
**Example chat prompts:**
- "That laptop I expensed is actually an asset"
- "Turn my $1,200 camera purchase into an asset"
- "I bought a bike for $800, track it as an asset"
- "Convert the Peloton expense into an asset called Home Bike"
**Point out on screen:**
- The expense disappears from the **Expenses** list.
- The new asset shows the purchase price and date from the old expense.
- Net worth goes up by the asset's value.
**Gotchas / FAQ:**
- *Will my spending totals change?* Yes. The expense is removed, so that month's spend drops by its amount.
- *Should I just create the asset and delete the expense myself?* You can, but the chat command does both in one step and carries the price and date over.
- *Changed your mind?* Try "undo that" in chat right after. [verify in app]

---

### 36. Asset rollup & cost of ownership
**Goal:** See the combined value of an asset and everything inside it, and what owning it costs you.
**Where to find it:** Asset profile → **Contained** tab and **Financials** tab. For the owner's side: a person's profile → **Finance** tab → **Cost of ownership**.
**What it is:** Assets can sit inside other assets (a TV inside a house). The **Financials** tab adds them all up and subtracts any loans. Expenses you log against an asset (gas, repairs) appear on that asset. They also appear on its owner's profile as "cost of ownership", but each expense is still counted only once in your totals.
**Step-by-step:**
1. Open an asset. The Overview summary shows **Value**, **Liabilities** and **Net** for this asset only ("This asset only. See Financials tab for the full rollup including children.").
2. Go to **Contained** to see the **Ownership Tree** and the child assets. Use **Adopt an existing asset** to move one inside it.
3. Go to **Financials**. The **Value Rollup** card shows **Base Value**, **Nested Assets**, **Total Combined**, **Total Loans** and **Net Value**.
4. Scroll to **Financial Breakdown** (columns Item / Value / Liab. / Net), then **Linked Liabilities**, then **Expenses** for this asset.
5. Open the owner's profile → **Finance** to see the **Cost of ownership** card.
**Example chat prompts:**
- "What's the total value of my home and everything in it?"
- "$50 gas for my Honda"
- "How much have I spent on my truck this year?"
- "Show everything related to my Tesla"
**Point out on screen:**
- The Overview's "What's Inside" preview (top 3 children).
- Under Cost of ownership: "Expenses from assets you own… counted once in your totals."
- A loan linked to the asset lowers **Net Value**.
**Gotchas / FAQ:**
- *Why is the Overview value lower than Financials?* The Overview shows this asset only. Financials includes the children.
- *Is an asset's expense double-counted on my profile?* No. It's one record shown in two places.

---

### 37. Maintenance reminders for assets
**Goal:** Set up recurring upkeep reminders (oil changes, filters, HVAC service) tied to an asset.
**Where to find it:** **Chat** (recommended), or the asset profile → **Maintenance** tab (vehicles, property and general assets). Reminders also appear on **Calendar**.
**What it is:** Tell Portol in chat what needs doing and how often. It creates a recurring calendar event in the maintenance category, filed under that asset. On the asset's **Maintenance** tab you can also add one-off to-dos for it.
**Step-by-step:**
1. Open **Chat** and describe the reminder with the asset's name and how often, e.g. "Replace the fridge filter every 6 months".
2. Portol confirms the event. Open **Calendar** to see the upcoming dates.
3. For a one-off job, open the asset → **Maintenance** tab → **Add Task**. Fill in the title, priority and due date.
4. Use the filter chips **All**, **Open** and **Completed**. Tick a task's circle to mark it done.
5. Back on **Overview**, a **Service** section can show the last and next service dates and how many service tasks are open, once that data exists.
**Example chat prompts:**
- "Remind me to change the oil in my Civic every 3 months"
- "HVAC service on the house every year in April"
- "Replace the fridge water filter every 6 months"
- "My car needs maintenance next month"
- "Log $89 oil change for the Civic"
**Point out on screen:**
- The event is linked to the asset, not just to you.
- Completed tasks hide under **Open** by default and stay under **Completed**.
- A maintenance cost logged in chat shows under the asset's **Financials** → **Expenses**.
**Gotchas / FAQ:**
- *Is there a "maintenance schedule" form?* Not on the tabs today. Recurring reminders are created from chat. [verify in app]
- *I said "every 6 months". What does the calendar show?* Portol uses a monthly repeat with the interval noted. Check the dates on Calendar. [verify in app]

---

### 38. Finance overview (money overview, cash flow)
**Goal:** Read your month at a glance (net worth, money in vs out, bills, savings rate) and drill into each number.
**Where to find it:** **Dashboard** → **Finance** tab (`/dashboard/finance`, also `/finance`).
**What it is:** The Finance tab opens with six summary cards and charts built from your accounts, income, expenses and bills. Tap any card to open a detailed popup. Further down are your accounts, your expenses, and a **More** section with paychecks, income, loan schedules and a weekly cash-flow plan.
**Step-by-step:**
1. Open **Finance**. The top row shows **Net Worth**, **Cash Flow · <MONTH>** (with "IN $X · OUT $Y"), **Spend · MTD**, **Income · MTD**, **Bills Due** and **Savings Rate**.
2. Tap **Cash Flow** to open "Cash Flow · <MONTH>", a waterfall with **Money in** and **Money out**. Tap a column for details.
3. Tap **View →** on **Cash Flow Overview** for inflow vs outflow over the last six months.
4. Scroll through **Spending by Category · MTD**, **Cash Flow Trend**, **Budgets · MTD vs limit**, **Bills · next 30d**, **Balance Sheet** and **Financial Alerts & Insights**.
5. Tap **More — paychecks, income, loan schedules, cash flow** to show the extra sections. Under **Cash Flow — <Month>**, tap **Add Entry** to plan a week (Projected/Actual Income and Expenses), then **Save Entry**.
**Example chat prompts:**
- "What's my cash flow this month?"
- "Show my weekly cash flow for October"
- "Give me a finance report for this month"
- "Go to finance"
**Point out on screen:**
- Tapping a category in the donut filters the Expenses list below it.
- Alerts are clickable, e.g. "2 bills due in the next 7 days totaling $X".
- Spend is labelled "manual ledger". Bank-connected spending is shown separately.
**Gotchas / FAQ:**
- *Why is "Income · MTD" lower than my salary?* It counts money that has arrived so far this month. The full expected amount appears as "…expected by month end".
- *Is a paid bill counted twice?* No. OUT is this month's expenses plus bill money still owed.

---

### 39. Connecting bank accounts (Stripe Financial Connections: link, sync, relink)
**Goal:** Link a bank, card or loan account so balances and transactions import automatically, and keep it working.
**Where to find it:** **Settings** (`/settings`) → **Connected Services** → **Finance** card. Imported data then appears at the top of **Dashboard** → **Finance**.
**What it is:** Portol uses Stripe's secure window to connect your bank. You sign in directly with your bank, and Portol never sees your banking password. Once connected, the Finance tab gets a connected section with accounts, transactions, cash flow, spending, income and liabilities. This is opt-in: until you connect, the Finance tab shows nothing extra.
**Step-by-step:**
1. Go to **Settings** → **Connected Services**. The **Finance** card says "Not connected" and lists what Portol will request: account details, balances and transactions.
2. Tap **Connect Financial Account** ("Opening your bank…"), then finish in Stripe's window. You'll see the toast "Bank connected".
3. Each institution then shows its linked accounts with **Refresh now**, **Manage accounts**, **Disconnect** and **Remove imported data**. Tap **Connect another institution** to add more.
4. In **Manage accounts**, use **Include in net worth** and **Hide from Finance** for each account.
5. On **Finance**, use the range control (**This month / 30D / 90D / 1Y**), the account picker, **Refresh**, and the tabs **Accounts · Transactions · Cash flow · Spending · Income · Liabilities**.
6. If the badge says **Action needed**, tap **Reconnect**. If it says **Sync failed**, tap **Try again**.
**Example chat prompts:**
- "How much do I have in checking and savings?"
- "Refresh my bank data"
- "What did I spend at Amazon last month?"
- "Are any of my bank connections broken?"
**Point out on screen:**
- The "Connected net worth" card, with the caption "Not your complete financial picture."
- "Updated 5m ago" freshness next to **Refresh**.
- The amber banner: "Your bank needs you to authorize Portol again. Choose Reconnect…".
**Gotchas / FAQ:**
- *Does Disconnect delete my data?* No. Imported data stays. **Remove imported data** deletes it, and your manual records are kept.
- *Counted twice?* Turn off **Include in net worth** if you also track that account manually.
- *It says "Unavailable".* Bank connection isn't turned on for this deployment. [verify in app]

---

### 40. Manual accounts & balances
**Goal:** Add checking, savings, cash, card and investment accounts by hand and keep their balances current.
**Where to find it:** **Dashboard** → **Finance** → **Accounts** card → **Add account**. Also on the **Assets** tab via the wallet (**Add Account**) button.
**What it is:** A manual account holds a balance you maintain. Those balances feed Net Worth, the Balance Sheet and cash flow, so there's one record per account. Every balance change is saved as an entry in the account's history.
**Step-by-step:**
1. On **Finance**, scroll to **Accounts** and tap **Add account**. The dialog is titled "Add a financial account".
2. Fill in **Account name** (e.g. "Chase Checking"), **Type** (Checking, Savings, Cash, Investment / brokerage, Credit card, Line of credit, Loan account, Other), **Institution**, **Current balance** (or **Balance owed**), **As of**, and optionally **Credit limit**, **Last 4 digits** and **Owner**. Tap **Add account**.
3. The card totals **Cash on hand**, **Investments**, **Card + credit debt** and **Available credit** / **Loan balances**.
4. Tap an account to expand it. Type an amount in **Adjust by…** and tap **+ Add** or **− Subtract**.
5. Check **Balance history** (the last 5 changes). Use **Open**, **Edit** or **Remove** for the account.
**Example chat prompts:**
- "Add my Chase checking account with $4,200"
- "My savings balance is now $12,500"
- "Paid the electric bill from my checking account"
- "How much cash do I have?"
**Point out on screen:**
- On **Add Expense**, picking a **Paid from** account lowers its balance automatically.
- History lines read like "Oct 3 · Manual decrease −$50 → $4,150".
- Credit cards show **Credit limit** and **Utilization**.
**Gotchas / FAQ:**
- *Edit vs Adjust?* Use **Adjust by…** for a change you want recorded in history. Use **Edit** to fix the account's details.
- *Is my manual account estimated by the valuation engine?* No. An account's value is its balance.

---

### 41. Expenses: logging, categories, refunds, receipt scanning
**Goal:** Log, find, edit and delete expenses, record refunds, and create an expense from a receipt photo.
**Where to find it:** **Dashboard** → **Finance** → **Expenses** card → **Add Expense**. Receipt scanning: **Insights** page (`/insights`) → **Scan Receipt**, also reachable from command search (Ctrl/Cmd+K) → **Scan receipt**.
**What it is:** Expenses are your manual spending ledger. Each one has a category, an optional vendor, a date, an owner, and optionally the account it was paid from. You can type one in, say it in chat, or snap a receipt and let Portol read it.
**Step-by-step:**
1. Tap **Add Expense**. Fill in **Description \*** (the category is suggested as you type), **Amount ($) \***, **Category**, **Vendor (optional)**, **Date**, **Profile** and **Paid from (optional)**. Tap **Save Expense**.
2. If you already logged the same thing, you'll see "You already logged this". Choose **Don't add** or **Add anyway**.
3. Tap a row to expand it, then **Edit** (change fields and tap **Save Changes**) or **Delete** (then confirm in "Delete Expense?").
4. **Receipt:** on Insights, tap **Pick a receipt photo**. Review **Vendor**, **Amount**, **Date**, **Category** and the line items, then tap **Save as expense**.
5. **Refund:** tell chat, e.g. "I got refunded $40 for the shoes". Portol adds a credit linked to the original expense.
**Example chat prompts:**
- "Spent $52 on groceries at Whole Foods"
- "Paid $120 for the plumber yesterday from checking"
- "I got refunded $40 for the shoes"
- "Return the headphones I bought" (refunds the full amount)
- "Change the Uber expense to $23"
**Point out on screen:**
- The category list (General, Food, Transport, Health, Pet, Vehicle, Debt payments…).
- "Couldn't read receipt fully": review the fields before saving.
**Gotchas / FAQ:**
- *Is there a refund button?* No. Refunds are recorded from chat.
- *Can receipts become expenses automatically?* Yes: **Settings** → **AI & Chat** → **Auto-Expense from Documents**.

---

### 42. Income & expected paychecks (confirming received)
**Goal:** Record your income sources, schedule expected paychecks, and mark them received when they arrive.
**Where to find it:** **Dashboard** → **Finance** → tap **More — paychecks, income, loan schedules, cash flow** → **Expected Paychecks** and **Income sources**. The **Income · MTD** card opens "Income · this month".
**What it is:** Income sources are recurring or one-time money coming in (salary, rent you collect, a bonus). Expected paychecks are dated amounts you're waiting for. A paycheck only counts as money in once you mark it received, so your month-to-date income reflects reality.
**Step-by-step:**
1. Under **Income sources**, tap **Add Income**. Fill in **Description \*** (e.g. "Salary, Rental, Dividends"), **Amount ($) \***, **Date**, **Category** (Salary, Freelance, Business, Rental, Investment, Gift, Other), **Frequency** (One-time, Weekly, Biweekly, Monthly, Quarterly, Yearly) and **Profile**, then tap **Add Income**.
2. Under **Expected Paychecks**, tap **Add Paycheck**. Fill in **Source Name \***, **Expected Amount ($) \*** and **Expected Date \***, then tap **Add Paycheck**.
3. Each paycheck shows a status: **Upcoming**, **Overdue**, **Received** or **Covered**.
4. Once the date has passed, expand the paycheck and tap **Mark received**.
5. Tap the **Income · MTD** card to see the **Recurring**, **One-time** and **Paychecks received** groups.
**Example chat prompts:**
- "I got paid $3,200 from Acme today"
- "Expect a $2,500 paycheck from Acme on the 15th"
- "My Acme paycheck came in. It was $2,480"
- "Delete the freelance income"
**Point out on screen:**
- The alert "1 expected paycheck is past its date and not marked received".
- **Covered** means a received paycheck for the same day and amount already accounts for it.
**Gotchas / FAQ:**
- *I can't pick a past date for a paycheck.* Expected paychecks are future income. Log money already received with **Add Income** or in chat.
- *Mark received records today's date and the expected amount.* To record a different date or amount, say so in chat. [verify in app]

---

### 43. Budgets (create, summary, copy last month)
**Goal:** Set monthly spending limits by category, track them, and carry last month's budgets forward.
**Where to find it:** **Dashboard** → **Finance** → **Budgets · MTD vs limit** card → **+ Budget** (or tap the card's heading). This opens the "Monthly Budget" popup.
**What it is:** A budget is a monthly limit for a spending category, set as a dollar amount or as a percentage of your income. Portol compares it with what you've actually spent this month and colors the bar green, amber (80%+) or red (over budget).
**Step-by-step:**
1. Open the **Monthly Budget** popup. With no budgets yet, it shows "No budget categories yet" and **Add first category**.
2. Tap **Add category**. Type a **Category (e.g. groceries, rent)**, choose **$** or **%** (percent needs income on file), enter the amount and tap **Add**.
3. Each row shows spent / limit, the percentage, and "% inc" (its share of your income). Use the pencil to edit (then **Save**) or the trash icon to delete.
4. The **Overall** bar sums all your budgets. The top of the popup shows a spending breakdown with **This Month / Last Month / This Year**.
5. **Copy last month:** ask in chat, e.g. "copy last month's budgets".
**Example chat prompts:**
- "Set a $600 grocery budget"
- "Copy last month's budgets"
- "How am I doing on my budgets this month?"
- "Raise my dining budget to $300"
- "Delete the entertainment budget"
**Point out on screen:**
- The **Financial Alerts & Insights** line "Food spending is over budget (112%)" opens the popup.
- Over-budget percentages turn red.
**Gotchas / FAQ:**
- *I don't see the Budgets card.* It only appears once you have a budget. Create the first one in chat, or from the **Budget** tile on the dashboard if it's shown there. [verify in app]
- *Is there a "copy last month" button?* No. It's chat-only.
- *Deleting a budget asks for no confirmation*, and the trash icon removes it right away. [verify in app]

---

### 44. Spending analytics & transaction search
**Goal:** See where your money goes and find a specific purchase or transaction.
**Where to find it:** **Dashboard** → **Finance**: the **Spend · MTD** card, **Spending by Category**, and the **Expenses** search and filters. For bank data: the connected section's **Spending** and **Transactions** tabs.
**What it is:** Portol breaks spending down by category and by month, highlights your largest purchases, and lets you search and filter your expense list. If you've connected a bank, you can also search the imported transactions and correct how each one is classified.
**Step-by-step:**
1. Tap **Spend · MTD** to open "Spend · <MONTH>", with a **Spending heatmap**, **Where it went** and **Largest purchases**.
2. Under **Expenses**, use **Expense date range** (**All time / This month / 30 days / This year**), **Search expenses…**, the category filter (**All Categories**) and the sort menu (**Newest first**, **Oldest first**, **Amount: high → low**, **Amount: low → high**, **Name: A → Z**).
3. **Spending by Category** (donut plus "By month" bars) follows the same filters. Tap a category to filter the list.
4. **Bank transactions:** open **Transactions** and use **Search transactions…** plus the institution, category, type (Income/Expenses/Transfers/Refunds) and status (Posted/Pending) filters.
5. Tap a transaction to change its **Category**, **Mark as transfer**, **Mark as income**, **Mark as refund**, **Exclude from totals**, **Attach to a record** or add a **Note**.
**Example chat prompts:**
- "How much did I spend on food this month vs last month?"
- "What's my biggest spending category?"
- "Show my last 10 expenses"
- "Break down my bank spending by merchant"
- "Chart my spending by category this year"
**Point out on screen:**
- The filter notice when rows are hidden, with a one-tap clear.
- The chart header names the active filters, so a filtered chart never passes for "all".
**Gotchas / FAQ:**
- *Why do manual and bank spending differ?* They're separate ledgers and each is labelled.
- *"No expenses match the selected filter"?* Clear the filters. Your data is still there.

---

### 45. Net worth (how it's calculated, history)
**Goal:** Understand what goes into your net worth and how it has changed over time.
**Where to find it:** **Dashboard** → **Finance** → **Net Worth** card (opens the "Net Worth" popup). Also the **Net Worth** chip in the Dashboard's top stats strip, and the **Balance Sheet** card.
**What it is:** Net worth is everything you own minus everything you owe. Assets count at their current value (your own value or Portol's estimate), accounts at their balance, and debts at their balance. If you co-own something, only your share counts when you look at one person. Portol saves a snapshot every day, so you can see the trend.
**Step-by-step:**
1. Tap **Net Worth**. The popup header shows the total and "N assets · N liabilities".
2. Read the change since a month ago (or since the first snapshot) and the trend chart. Switch the **Net worth time frame**: **30D**, **90D**, **1Y** or **All** (only ranges your history covers appear).
3. Switch between the **Assets** and **Liabilities** tabs to see each item and its value. Tap an item to open it.
4. Tap **Add asset** or **Add liability** to add one right here.
5. On Finance, the **Balance Sheet** card shows **Assets**, **Liabilities** and **Net worth**, with breakdown lists.
**Example chat prompts:**
- "What's my net worth?"
- "Why did my net worth change today?"
- "How did Bob's net worth change this month?"
- "Show my net worth history"
**Point out on screen:**
- The profile filter changes whose net worth you see, and co-owned items count at that person's share.
- A sparkline sits on the **Net Worth** card.
**Gotchas / FAQ:**
- *No percentage change shown?* Portol needs about 30 days of snapshots before it shows a month-over-month change.
- *Are bank-connected balances in this number?* The connected section shows its own "Connected net worth". Check how it combines with this total. [verify in app]

---

### 46. Recurring bills & subscriptions (obligations; paying a specific month)
**Goal:** Add recurring bills, see what's due, mark them paid or skipped, and pay a particular month.
**Where to find it:** The **Bills** page (`/obligations`, also `/bills` and `/dashboard/obligations`), reached via **View All Bills** or from Calendar. On **Finance**: the **Bills Due** card and **Bills · next 30d**. Subscriptions also appear in the **Subscriptions** card on Finance.
**What it is:** Bills are money you owe on a schedule (rent, phone, Netflix). Portol tracks each due date, shows what's due soon or overdue, and when you pay it records the payment, logs an expense and moves the bill to its next cycle.
**Step-by-step:**
1. On **Bills**, tap **Add Bill** (or **Add a bill**). Fill in **Name**, **Amount ($)**, **Frequency**, **Category**, **Next due**, **Autopay** and **Whose is this?**, then tap **Save**.
2. The headline stats show **Total Due**, **Due Soon**, **Overdue** and **Paid**. Filter by **All Bills**, **Due Soon**, **Overdue** or **Paid**.
3. Tap a bill to expand it: **Mark as paid**, **Skip payment**, **Edit** (then **Save**) or **Delete** (then confirm **Delete**, or **Keep**).
4. On **Finance**, tap **Pay** next to a bill, then confirm with **Pay $X** in "Pay <bill>?".
5. **To pay a specific month**, use chat: "mark the phone bill paid for June 2026".
**Example chat prompts:**
- "Add Netflix $15.99 monthly on the 12th"
- "Mark Bob's phone bill paid for June 2026"
- "Paid the August electric bill from my checking account"
- "Undo the last payment on rent"
- "Skip this month's gym payment"
**Point out on screen:**
- The expanded bill shows **Upcoming** dates and **Payment history**.
- A skipped bill keeps its next due date scheduled.
**Gotchas / FAQ:**
- *Which month does Mark as paid pay?* The oldest open one. Use chat to pick a month.
- *Variable bill?* Leave the amount out in chat and Portol settles that month's real total.

---

### 47. Liabilities: credit cards, mortgages, loans
**Goal:** Add a debt and read its balance, rate, payment and payoff at a glance.
**Where to find it:** **Dashboard** → **Liabilities** tab (`/liabilities`) → **+** / **Add Liability**. Open one to see its page, with the tabs **Overview · Details · Payments · Docs · Activity · History**.
**What it is:** A liability is something you owe: a credit card, mortgage, auto loan, student loan, personal loan, medical debt or buy-now-pay-later. Each has its own page with headline numbers, payment tools and the full loan terms. Its balance counts against your net worth.
**Step-by-step:**
1. Tap **Add Liability**, choose a type, tap **Next**, fill in the fields and tap **Create Profile**.
2. Open it. Loans show **Current balance**, **Monthly payment**, **APR** and **Payoff**. Credit cards show **Balance**, **Available**, **Utilization** and **Min payment**.
3. On **Overview**, use **Quick actions**: **Pay minimum**, **Pay custom**, **Extra principal** or **Interest only**. Read **Cost of borrowing** and **Schedule**.
4. On **Details** → **Loan terms**, tap **Edit**. Set **Lender / creditor**, **Current balance ($)**, **Original balance ($)**, **Annual interest rate (%)**, **Monthly payment ($)**, **Remaining term (months)**, **Due day of month (1–31)** and **First payment date**, then tap **Save terms**.
5. The **Liabilities** tab header shows the total owed and the total per month.
**Example chat prompts:**
- "Add my Chase Sapphire card, $3,400 balance, 24% APR, $15k limit"
- "I have a mortgage of $410,000 at 6.5%, $2,600 a month"
- "Refinanced the car loan to 4.9%"
- "Summarize all my debts"
**Point out on screen:**
- The payoff progress bar against the original balance.
- **Remaining interest** vs **Interest paid (history)**.
**Gotchas / FAQ:**
- *Credit card as an account or a liability?* An account under **Finance → Accounts** tracks a balance you maintain. A liability profile adds payoff tools. Use one, not both, to avoid counting it twice. [verify in app]
- *A recurring bill here shows different tiles (Amount, Next due, Remaining, Status) and no Quick actions.* That's expected.

---

### 48. Loan payment schedules & payoff outlook
**Goal:** See every future loan payment and how extra payments change your payoff date.
**Where to find it:** The liability's **Overview** (the payoff outlook) and **Payments** tab (**Payoff Calculator**, **Amortization Schedule**). Also **Finance** → **More** → **Loan Schedules**.
**What it is:** For loans and cards with a balance, rate and payment, Portol builds the full payment schedule: each payment split into principal and interest, and the balance falling to zero. The calculator shows how much time and interest you save by paying extra.
**Step-by-step:**
1. On **Overview**, read **Remaining balance**, **Payoff date** and **Interest left**, the **Balance until payoff** chart, and **Where the rest goes** (Principal vs Interest).
2. Open **Payments** → **Payoff Calculator**. Enter **Extra principal per month** and/or a **One-time lump sum**.
3. Compare **Current pace** with **Accelerated** (Months remaining, Total interest, Payoff date) and the **Balance over time** chart.
4. Use **Pay it off by a target date** → **Target months until payoff** to see the payment you'd need.
5. Scroll to **Amortization schedule** (# / Due / Payment / Principal / Interest / Balance).
6. On **Finance** → **Loan Schedules**, tap **Mark Paid** on the highlighted next installment.
**Example chat prompts:**
- "Show the amortization schedule for my car loan"
- "When will my mortgage be paid off?"
- "What if I pay $200 extra a month on the car loan?"
- "Mark this month's car loan payment as paid"
**Point out on screen:**
- The schedule header: "N periods · total interest $X".
- A warning when the payment doesn't cover the interest: "the balance never falls".
**Gotchas / FAQ:**
- *"No schedule available"?* Set a balance, a rate, and either a monthly payment or a remaining term.
- *Not on the Finance Loan Schedules list?* Only loans with a balance and a term appear there.

---

### 49. Recording/editing/deleting liability payments
**Goal:** Log a payment on a debt, fix a wrong one, or remove a duplicate.
**Where to find it:** Liability page → **Payments** tab → **Payment History** → **Record payment**. Also from **Overview** → **Quick actions** and **Recent payments** → **See all**.
**What it is:** Each payment you record is split into interest and principal automatically, and it lowers the balance. The history keeps the amount, date, principal/interest split, the balance afterwards and any note. For recurring bills, the **Schedule & Calendar** card above it handles paying, skipping or editing individual due dates.
**Step-by-step:**
1. Tap **Record payment** (or a Quick action such as **Pay minimum**). Fill in **Amount**, **Date** and **Notes (optional)** (e.g. "paid via Chase auto-pay"), then tap **Record payment**.
2. The new row shows the amount, date, "P $X" and "I $Y", and "Bal $Z".
3. **To delete:** tap the reverse icon (tooltip "Reverse this payment") on the row. You'll see "Payment reversed".
4. **To edit** an amount, date or note, ask in chat. There's no edit button on the row.
5. **Recurring bills:** in **Schedule & Calendar**, filter **upcoming / completed / missed / skipped / all**. On a date, tap **Pay**, the skip button, or the pencil to reschedule, set the amount, record the **Actual charged** amount, **Add a charge to this month**, or add **Notes**.
**Example chat prompts:**
- "Paid $500 on my car loan"
- "Sent $2,000 extra principal to the mortgage"
- "The mortgage payment on the 1st was $2,650, not $2,600"
- "Remove that duplicate mortgage payment"
- "Undo the last payment on the phone bill"
**Point out on screen:**
- The dialog's note: "We'll split this payment into interest and principal automatically."
- The payment count ("3 payments on record").
**Gotchas / FAQ:**
- *Reverse acts on one tap, with no confirmation step.* [verify in app]
- *Does reversing restore the balance?* It removes the payment record. Check that the balance updates. [verify in app]

---

### 50. Linking loans to collateral assets & co-signers
**Goal:** Connect a loan to the asset it pays for and to the people who share it.
**Where to find it:** Liability page → **Overview** → **Linked assets** (**Link asset**), **Ownership**, and **Linked people** (**Add Person**). From an asset: **Financials** or **Money** tab → **Linked Liabilities**.
**What it is:** Linking a mortgage to your house or an auto loan to your car lets Portol show the asset's net value (value minus debt). Ownership splits a debt by percentage between people, so each person's net worth carries only their share. Other roles, like co-signer or guarantor, record who else is on the loan.
**Step-by-step:**
1. On the liability's **Overview**, tap **Link asset**. Choose from **Choose an asset profile…**, pick a role (**Collateral**, **Secured by**, **Associated**) and tap **Link**.
2. Set the **Ownership %** on the linked asset row if needed. To remove the link, tap the unlink icon (**Unlink asset**).
3. In **Ownership**, use **+ Add owner…**, adjust the sliders or percentages (they must total 100%), tap **Split evenly** if you like, then **Save ownership**.
4. In **Linked people**, tap **Add Person**. Choose the **Person**, a **Role** and an **Ownership %**, then tap **Save**.
5. Open the asset → **Financials** to see the loan under **Linked Liabilities** and in **Net Value**.
**Example chat prompts:**
- "This mortgage is on my house at 123 Maple"
- "The auto loan is for my Civic"
- "My dad co-signed my student loan"
- "This loan is split 50/50 with my wife"
- "Move the appliance financing from the old house to the new one"
**Point out on screen:**
- "Ownership not set — this counts toward you at 100%."
- The total badge turns green at 100% and amber otherwise.
**Gotchas / FAQ:**
- *"Co-signer" isn't in the Add Person roles.* The UI lists Owner, Co-Owner, Beneficiary, Trustee, Manager and Guarantor. Use chat to add a co-signer. [verify in app]
- *Link asset is greyed out.* You have no asset profiles to link yet. Create one first.

---

## Part 5 — Calendar, tasks & wellness (51–60)


### 51. Calendar views & agenda
**Goal:** Move around the calendar in Month, Week, Day and Agenda views and read what's scheduled on any day.
**Where to find it:** Main nav (desktop sidebar or the bar at the bottom on mobile) → **Calendar** (`/calendar`). The page opens on the **Calendar** tab. The other tab is **Recurring & Important**.
**What it is:** One calendar that shows your events, tasks with due dates and reminders together, plus other dated items such as habits and bills. Three tiles at the top count what's coming up. The toolbar switches between four ways of viewing the same items.
**Step-by-step:**
1. Open **Calendar**. Point out the three tiles: **Today**, **This Week**, **Next 30 Days**.
2. Use the **‹ / ›** arrows to move back and forward, and **Today** to jump back to today.
3. Switch views with **Month / Week / Day / Agenda**.
4. In **Month**, tap a day once to select it. Its list appears in the day panel (beside the grid on desktop, below it on mobile). Tap the same day again to open it in **Day** view.
5. When a day has more than two items, tap **+N more** to scroll to that day's list.
6. Filter by type with the pills **All / Events / Tasks**.
7. Tap any item to open its details. Add something to the selected day with **+ Add** in the day panel, or with the **+ Event** button in the toolbar.
**Example chat prompts:**
- "What's on my calendar this week?"
- "What do I have tomorrow?"
- "Doctor appointment Friday at 2pm"
- "Open my calendar"
**Point out on screen:**
- On a phone the calendar opens in **Agenda** view. On desktop it opens in **Month**.
- The colour legend under the month grid: **Event**, **Task**, **Bill**, **Habit**.
- Completed tasks are shown with a ✓ and struck through.
- **Week** view lays the day out by hour, from 7am to 9pm.
- **Agenda** lists everything from today onward, grouped by date.
**Gotchas / FAQ:**
- *"The month is empty."* If a type pill or a person filter is on, the empty grid says **No events match the current filter this month** and offers **Clear filter**.
- *Double-click a day* (desktop) to open **New Event** with that date already filled in.
- *Why don't the tiles match the grid?* They do. Both come from the same data, with the same person filter applied.

---

### 52. Events vs tasks vs reminders (when to use which)
**Goal:** Choose correctly between an event, a task and a timed reminder.
**Where to find it:** **Calendar** (`/calendar`) → **+ Event**. The **Tasks** page is at `/tasks` (reach it from the search palette with "Go to Tasks", or from the Dashboard's **Tasks Due** chip). You can also create any of these from Chat.
**What it is:** Portol has two kinds of scheduled item. An **event** is something that happens and you attend, like a meeting, a flight or a party. A **task** is something you do and then check off. A "reminder" is a task that has a clock time: it appears on the calendar at that hour and sends you a notification.
**Step-by-step:**
1. **Event:** Calendar → **+ Event** → fill in **Title**, **Date**, **Start Time**/**End Time** (or tick **All day event**), plus optional **Location**, **Description** and **Category** → **Create Event**.
2. **Task:** Tasks → **New Task** → fill in **Title \***, **Description**, **Priority**, **Due Date**, **Profile** and **Tags** → **Create**.
3. **Reminder:** ask in chat, e.g. "remind me to call the dentist Friday at 10am". It is saved as a task with a due time.
4. To change a task's time and reminder: Dashboard **Tasks Due** chip → open a task's **Advanced options** → set the time field and the reminder (**No reminder**, **At due time**, **5 min before** … **1 day before**). **[verify in app]**
**Example chat prompts:**
- "Dinner party at Sam's Saturday 7pm" (event)
- "Add a task to renew my registration before Aug 30" (task)
- "Remind me to take my meds at 8am daily" (repeating reminder, saved as a task)
- "Move my dentist reminder to 4pm"
- "I went to the dentist" (marks the event complete)
**Point out on screen:**
- Tasks have a **Mark as done** checkbox in their detail pop-up. Events have **Edit** and **Delete**.
- On the calendar, events are blue and tasks are purple.
**Gotchas / FAQ:**
- *"Where's the Reminders page?"* There isn't a separate one. Reminders are tasks with a time, so look for them on **Tasks** and on the **Calendar**.
- *A clock time doesn't make something an event.* If it's a job you do, it's a task.
- The **New Task** dialog on the Tasks page has no time field. Add the time through chat or through the task's **Advanced options**.

---

### 53. Recurring events & dates (birthdays, anniversaries, weekday picker)
**Goal:** Create repeating events and yearly dates, and edit or skip a single occurrence without changing the whole series.
**Where to find it:** **Calendar** → **Recurring & Important** tab (`/calendar?tab=recurring`) → **+ Recurring date**. You can also set **Repeat** in the event form (**+ Event**).
**What it is:** A recurring item repeats on a schedule, such as daily, on weekdays, on particular days of the week, monthly or yearly. Birthdays and anniversaries repeat every year. The Recurring & Important tab has two views: **Rules** shows each repeating thing once, and **Upcoming dates** shows the individual dates those rules produce.
**Step-by-step:**
1. Tap **+ Recurring date** (or **Add your first** if the list is empty) to open **New recurring date**.
2. Fill in **Title** (e.g. "Our anniversary"), then pick a **Type**: **Anniversary, Birthday, Bill, Renewal, Maintenance, Appointment, Subscription, Custom**.
3. Optionally choose **Linked to** (a person or asset), then set **First date**.
4. Set **Repeats**: **Daily, Every weekday, Weekends, Weekly, Every 2 weeks, Monthly, Yearly, Specific days…**
5. If you chose **Specific days…**, tap the day buttons **S M T W T F S** to pick the days.
6. Optionally set **Ends**, a **Reminder** (**No reminder … 1 month before**) and **Notes**, and turn on **Requires check-off** if you want to tick each occurrence. Then tap **Add**.
7. To change one occurrence of a repeating event, open it on the Calendar → **Edit** → choose **Just this date (…)** or **All occurrences**.
**Example chat prompts:**
- "Mom's birthday is March 14"
- "Our anniversary is June 2, every year"
- "Team standup every Monday, Wednesday and Friday at 9am"
- "Replace the HVAC filter every 3 months"
**Point out on screen:**
- The rule card menu: **Pause/Resume**, **Skip next occurrence**, **Move next date**, **Edit series**, **Edit this & future**, **Archive**.
- Deleting a repeating event offers **Just this date**, **This and following dates** and **The entire series**.
- Category chips across the top (**Birthdays**, **Anniversaries**, …) filter the list.
**Gotchas / FAQ:**
- *"I said Bob's birthday and no profile for Bob was created."* That's on purpose. The birthday is saved as a yearly event, and chat offers **Yes, create profile** or **No, just keep the record**.
- *With **Requires check-off** on*, an occurrence you miss shows as overdue until you mark it done or skip it.

---

### 54. Calendar manager (sources, categories, people filter)
**Goal:** Add and manage every kind of dated item in one panel, filter by person and category, and know what external calendar sync can and can't do.
**Where to find it:** **Calendar** toolbar → **Manager** (gear icon, next to **Agenda**). This opens the **Calendar Manager** side panel. The person filter is the picker at the top-left of the Calendar page. Category chips are on the **Recurring & Important** tab.
**What it is:** The Calendar Manager is a single place to create and edit events, recurring bills and subscriptions, birthdays and tasks. Its **Manage** tab lists all of them with edit and delete buttons. The person filter limits the calendar to chosen people, and this choice affects the Calendar page only.
**Step-by-step:**
1. Open **Manager** → **Create** tab. Choose a section:
   - **Quick add**: a one-line description, e.g. "Pay rent every month on the 1st $2500".
   - **Recurring obligation**: a repeating bill, subscription or similar.
   - **Manual event**: a one-off or repeating event.
   - **Birthday or anniversary**: pick **🎂 Birthday** or **💞 Anniversary**, then **Add (recurs yearly)**.
   - **Task**: fill it in, then **Add task**.
2. Switch to **Manage**. Filter with the chips **All, Recurring, Events, Tasks, Bills, Subs, Loans, Appts, Meds, Maint, Docs, Habits**.
3. Use the pencil (**Edit**) or the bin (**Delete**) on any row.
4. Person filter: open the picker (**Filter by Person**) and choose people. A notice appears: "Showing *Name* only — tasks and events for anyone else are hidden, not deleted". Tap **Show everyone** to clear it.
5. Category chips on **Recurring & Important**: **All, Important, Birthdays, Anniversaries, Bills, Subscriptions, Liabilities, Document Expirations, Tasks, Events, Other**. Only categories that have items are shown.
**Example chat prompts:**
- "Add Netflix $15.49 monthly on the 3rd"
- "Show me only Dana's calendar this week" **[verify in app]** (chat may change the app-wide scope rather than the Calendar's own picker)
- "What's on the calendar for Max next week?"
**Point out on screen:**
- Changing the person filter on the Calendar does **not** change who the rest of the app is showing.
- If a data source fails to load, the Recurring tab shows "Some calendar data couldn't load (…)".
**Gotchas / FAQ:**
- *External calendar sync:* there is a **Sync** button (title "Sync Google Calendar"). It only **imports** Google Calendar events, from one month back to one month ahead, and only when an account is already connected. The app has no button to connect an account. Settings → **Connected Services** shows Google Calendar as **Not connected**, and the Sync toast tells you to go to "Settings → Integrations", which isn't the card's name. Nothing in the app sends Portol events to Google, and there's no Outlook or iCloud sync. **Treat external sync as not available to users. [verify in app]**
- Deleting from **Manage** asks once, in a browser confirmation box.

---

### 55. Tasks: create, complete, bulk-complete, restore, scope filters
**Goal:** Create, complete, reopen, delete, restore and filter tasks.
**Where to find it:** `/tasks`. Reach it from the search palette ("Go to Tasks" / "New task"). The Dashboard's **Tasks Due** chip opens a quick Tasks pop-up instead. **[verify in app]** for other entry points.
**What it is:** The Tasks page lists your to-dos. Tiles at the top show what's overdue, due today, coming up and done today. Your active and completed tasks are in separate lists. When the app is filtered to particular people, the page tells you how many tasks are hidden.
**Step-by-step:**
1. Tap **New Task** → enter **Title \*** (plus optional **Description**, **Priority** Low/Medium/High, **Due Date**, **Profile**, **Tags**) → **Create**.
2. Tick the checkbox to complete a task. On a phone you can swipe left (**✓ Done**) instead.
3. Use the tabs **All / Open / Completed** to switch lists. In **Completed**, untick a task or swipe (**↩ Reopen**) to reopen it.
4. Tap a task's title to edit it. You can change priority inline (**Change priority**) and the date inline (**Add date**).
5. To delete, tap the bin → **Delete "…"?** → **Delete**. Then tap **Undo** in the toast to bring it back. The undo is only available for a short time.
6. Bulk-complete and restoring an older deletion are done in chat. There is no button for either on this page.
**Example chat prompts:**
- "Mark all overdue tasks done"
- "Complete all my tasks"
- "Bring back the passport task I deleted"
- "What tasks are due this week?"
- "I finished the grocery run"
**Point out on screen:**
- The tiles: **Overdue**, **Today**, **Upcoming**, **Done today**.
- Repeating tasks show a summary pill describing the schedule.
- When a scope is active, you'll see "Showing X of Y tasks · filtered by *Name*" with **Clear filter**.
**Gotchas / FAQ:**
- *"Nothing on your list"* only appears when you genuinely have no tasks. If a filter is hiding them, the page says "No tasks match this filter — N tasks are hidden, not deleted."
- *Swiping right (**Snooze**) moves the task's due date to tomorrow.* It changes the actual due date.

---

### 56. Snoozing alerts and tasks
**Goal:** Hide an alert for a while without changing the due date of the bill or document it's about.
**Where to find it:** Dashboard (`/dashboard`) → **Action Required** section **[verify in app]** (which dashboard view shows it), and the document-expiration alerts card (**Snooze** button).
**What it is:** A snooze hides a reminder. It doesn't change the record. When you snooze a bill alert, the bill keeps its real due date everywhere else: the calendar, the bills list and cash flow. Bill snoozes and dismissals sync across all your devices.
**Step-by-step:**
1. In **Action Required**, find a bill row. Tap the clock (tooltip "Hide this reminder for 7 days (due date unchanged)").
2. A toast confirms: "Reminder for '…' hidden for 7 days — The bill's due date is unchanged."
3. Tap **×** (tooltip "Hide until tomorrow") to dismiss any row until tomorrow.
4. On a document-expiration alert, tap **Snooze**. The toast reads "Document snoozed — Hidden from alerts for 30 days."
5. To make an alert go away permanently, act on it: **Pay** the bill or **Complete** the task.
**Example chat prompts:**
- "Dismiss the passport expiration notification"
- "Dismiss all my notifications"
- "Mute bill alerts"
**Point out on screen:**
- Open the Calendar after snoozing a bill. It still shows the original due date.
- Paying or completing something clears its alert by itself. Uploading a newer document of the same kind clears the older one's alert.
**Gotchas / FAQ:**
- *A task's clock button is different.* On a task row it is labelled "Move due date 7 days later" and it **does** reschedule the task. The swipe-right **Snooze** on the Tasks page also moves the date, to tomorrow.
- *Document snoozes are saved only in the browser you snoozed from.* They don't sync across devices the way bill snoozes and dismissals do.
- A snooze ends by itself. The alert comes back after the period you chose if the item still needs action.

---

### 57. Wellness overview & gauges
**Goal:** Read the Wellness tab: the score, today's signals, the weekly summary, labs with range gauges, care and activity.
**Where to find it:** Dashboard hub → **Wellness** tab (`/wellness`, also `/health`). The Dashboard's **Wellness** chip opens it too.
**What it is:** Wellness shows you your own health data. It doesn't ask you to fill anything in. A score out of 100 combines sleep, activity and recovery. Lab and vital readings show a coloured bar for where each value sits against its normal range. When one person is selected in the profile filter, the page shows that person's data.
**Step-by-step:**
1. Open **Wellness**. Look at the **Wellness score** ring (out of 100). The outer ring is the total, and each inner ring is one part that was counted.
2. **Today**: **Sleep**, **Activity** and **Recovery**, each compared with your own 30-day average.
3. **This week**: a short summary. Tap **Ask AI to read this back** for an AI-written version.
4. **Body & vitals** and **Labs**: each row has its value, "Ref …" range, date, a **High/Low/Elevated** label when the value is out of range, and the coloured bar.
5. **Care**, **Activity** (workouts grouped by type over 90 days) and **Sources** (which data types are coming in).
**Example chat prompts:**
- "Slept 7.5 hours last night"
- "Walked 9,000 steps today"
- "How's my health looking this week?"
- "Show my LDL trend"
**Point out on screen:**
- A lab value that changed shows its trend, e.g. "128 → 138".
- If a part has no fresh reading, the score leaves it out and says why, rather than scoring it as zero.
- When a person is selected: "Showing *Name*'s health data".
**Gotchas / FAQ:**
- *How is the score made?* Sleep counts for 40%, Activity 30% and Recovery 30%. The weights are rebalanced over whichever parts have data. Sleep gets full marks at 7–9 hours. Activity reaches 100 at 8,000 steps or 30 active minutes. Recovery uses heart-rate variability (HRV) or resting heart rate.
- *"Connect Apple Health" prompts:* Settings shows **Apple Health** as **Coming Soon**. For now, data comes from what you log (in chat or Trackers) and from lab reports you upload.
- *A lab row with no bar* means that metric has no reference range.

---

### 58. Medications: doses, skips, missed doses, refills, adherence
**Goal:** Log doses, record skipped or missed doses, check adherence and set up refill reminders.
**Where to find it:** Dashboard hub → **Trackers** → open the medication's tracker → **Overview**. Medications are also listed in the **Care** section on **Wellness**. Chat handles skips, missed-dose reports and refills.
**What it is:** Each medication has its own tracker, and every dose you log is one entry. Portol compares the doses you've logged with the doses expected from how often you take it, and shows an adherence percentage. Refill reminders are all-day calendar events placed a few days before each supply runs out.
**Step-by-step:**
1. Open the medication tracker. The badge reads **Not taken yet** or "**N doses today** · Last: …".
2. Tap **Log [dose] [name] dose**. After the first dose it changes to **Log another … dose**. Each tap adds one dose.
3. Read **Adherence**: "X%" and "**X of Y this week**", plus the 7-day strip (✓, 2×, • for today, – for none).
4. Record a skip or a missed dose in chat, e.g. "I skipped tonight's Metformin."
5. Set up refills in chat by giving the pill count, number of refills and start date. The reminders appear on the Calendar.
**Example chat prompts:**
- "I took my Lisinopril"
- "Forgot my Metformin yesterday"
- "What doses did I miss this week?"
- "Show my Lisinopril history"
- "Lisinopril 10mg once daily, 30 pills with 5 refills, started Jan 1"
**Point out on screen:**
- The dose button never locks after use. You can always log another dose.
- The adherence figure shows **—** ("not enough history") until a dose has actually been expected.
- **Care** on Wellness shows "Refills *date*" next to each medication.
**Gotchas / FAQ:**
- *"Unlogged" isn't the same as "missed".* Chat reports doses you didn't log separately from the ones you said you missed or skipped.
- *How the refill date is worked out:* supply = pills ÷ doses per day. The reminder is set 3 days before each fill runs out.
- Each medication or supplement should have its own tracker. Don't combine them under "Supplements".

---

### 59. Blood pressure & heart rate tracking
**Goal:** Log blood pressure and heart rate and understand the category label.
**Where to find it:** Chat (fastest), or Dashboard hub → **Trackers** → **Blood Pressure** / **Heart Rate** tracker → **Log Entry** **[verify in app]** (which button opens the **Log Entry** dialog). Readings also appear on **Wellness** → **Body & vitals**, and resting heart rate feeds **Recovery**.
**What it is:** A blood pressure reading is a pair of numbers, and Portol judges the two together using the standard categories: **Normal, Elevated, Stage 1 high, Stage 2 high, Crisis, Low**. Heart rate has its own **Heart Rate** tracker. If you give a pulse along with a blood pressure reading, it is saved to Heart Rate automatically.
**Step-by-step:**
1. In chat, type "bp 124/78 pulse 59".
2. Two entries are saved: **Blood Pressure** (124/78) and **Heart Rate** (59 bpm).
3. Open **Trackers** → **Blood Pressure**. The card shows the category badge and the previous reading.
4. Use the **Overview / Trends / History** tabs to see the trend and past readings.
5. On **Wellness** → **Body & vitals**, see systolic and diastolic rows with their reference ranges (< 120 and < 80 mmHg) and gauges.
**Example chat prompts:**
- "Blood pressure 118 over 76"
- "bp 132/84 pulse 70"
- "Resting heart rate 58 this morning"
- "Heart rate 165 during my run"
- "Chart my blood pressure this month"
**Point out on screen:**
- The tracker badge and the Wellness rows agree, because both use the same rules.
- The rows can differ from each other: 121/76 reads Elevated for systolic and Normal for diastolic.
**Gotchas / FAQ:**
- *Why didn't my workout heart rate change my resting HR?* A reading you label as taken during exercise ("during my run") is left out of resting heart rate.
- *"Crisis"* means 180 or higher systolic, or 120 or higher diastolic. The app tells you to seek medical attention.
- One Blood Pressure tracker per person. Logging again adds to the same tracker. It never creates a duplicate.

---

### 60. Health documents
**Goal:** Add lab reports and other medical documents so their values and dates appear on Wellness.
**Where to find it:** Chat → paperclip (attach) button to upload. Documents are stored under Dashboard hub → **Documents** (`/linked?tab=documents`). Health documents also appear on **Wellness** in **Care** and **Labs**.
**What it is:** When you upload a lab report, prescription, vaccination record or health insurance card, Portol reads it and stores its details. Values from lab reports appear in **Labs**, with reference ranges and a trend across reports. Portol decides what counts as a health document from the document's type, so a homeowners or auto insurance policy never ends up in your health records.
**Step-by-step:**
1. In **Chat**, tap the paperclip and take a photo of or upload a lab report.
2. Check what was extracted and confirm it **[verify in app]** (wording of the review step).
3. Open **Wellness** → **Labs**. Each value shows "Ref …", the date and a gauge. Values outside the range are flagged.
4. Tap a lab row to open the document it came from.
5. Find the document listed under **Care** on Wellness and under **Documents** in the hub.
**Example chat prompts:**
- "Show my latest blood work"
- "Open my dental insurance card"
- "When does my vision insurance expire?"
- "Link this lab report to Mom"
**Point out on screen:**
- After a second report, the trend appears, e.g. "LDL 128 → 138".
- The Labs header counts values and how many are out of range, e.g. "· 2 out of range".
- An empty Labs section says "Photograph a lab report in chat and every value on it lands here."
**Gotchas / FAQ:**
- *Why is my car insurance not here?* Only health, dental and vision insurance count as health documents.
- *Expiring documents* (e.g. an insurance card) create alerts. Uploading a newer document of the same kind replaces the old alert. You can **Snooze** an alert for 30 days.
- Tapping a document in **Care** opens a `#/documents?doc=…` link. That route isn't registered in the app, so check what it shows. **[verify in app]**

---

## Part 6 — Trackers, habits, documents, artifacts & settings (61–76)


### 61. Creating a smart tracker (from chat)
**Goal:** Create a tracker for anything you want to measure just by telling the AI chat.
**Where to find it:** **Chat** (sidebar or bottom bar). After it is created, find it at **Dashboard → Trackers** chip (`/trackers`).
**What it is:** A tracker is a running log of something you measure, like weight, sleep, water or blood pressure. You don't build it field by field. You describe what you want to track and Portol picks sensible fields and units for you. There is no "New tracker" button: trackers are only created from chat.
**Step-by-step:**
1. Open **Chat**.
2. Type what you want to track, e.g. "Track my blood pressure."
3. Portol replies with an action card for the new tracker. Tap the card to jump to it on the Trackers page.
4. Or log a first value directly ("I weighed 182 lbs today"). If no tracker exists yet, one is created automatically, as long as **Settings → AI & Chat → Auto-Create Trackers** is on.
5. Open **Dashboard → Trackers** to see the new tracker card.
**Example chat prompts:**
- "Track my blood pressure"
- "Create a tracker for my daily water intake in ounces"
- "I want to track my sleep hours and quality"
- "Start a tracker for Max's weight" (Max = a pet profile)
- "Rename my Run tracker to Running"
- "Change the unit on my Weight tracker to kg"
**Point out on screen:**
- On the Trackers page, cards are grouped as **Active Today**, **Needs Attention**, **Recently Logged** and **Logged Earlier**. Trackers with no entries collapse into a **No Data** pile.
- The view toggle switches between card view and a compact list, and remembers your choice.
- When there are no trackers yet, the page says: "No trackers yet. Ask Portol in chat to create one — e.g. 'track my weight'."
**Gotchas / FAQ:**
- *Will saying "weight" again make a second Weight tracker?* No. Each owner gets one tracker per name, so new values go into the tracker you already have. A pet or another person gets their own tracker under the same name.
- *Can I track money with this?* No. Spending is logged as an expense, not a tracker entry.
- *Why can't I find a create button?* Trackers are created from chat only.

---

### 62. Logging, editing & deleting tracker entries
**Goal:** Add, fix and remove entries in any tracker, from the tracker screen or from chat.
**Where to find it:** **Dashboard → Trackers** → tap a tracker card to open its detail window.
**What it is:** Every value you record is an entry. You can log a value by hand from the tracker's window or just say it in chat. Mistakes are easy to fix, and a deleted entry can be undone for a few seconds.
**Step-by-step:**
1. Open a tracker card. The header shows the name, entry count, unit and category.
2. Tap **+ Add**. The **Log Entry: <tracker name>** dialog opens.
3. Use **Quick add** (or **Quick rate** for rating-style trackers), or type into each field. Optionally use **Add a field** and **Notes (optional)**.
4. Tap **Log Entry**.
5. To edit, open the **History** tab and tap an entry's pencil (**Edit entry**). Change values, add or remove fields, then tap **Save**.
6. To delete, tap the trash icon (**Delete entry**). In **Delete this entry?**, tap **Delete**. Tap **Undo** on the toast that follows if you change your mind.
7. Use **Search entries...** in History to find old entries.
**Example chat prompts:**
- "Weight 181.4 this morning"
- "BP 124/78, pulse 59"
- "I actually slept 8 hours not 7"
- "Delete my water entry from today"
- "Undo that"
**Point out on screen:**
- Entries show up right away, before the server confirms them.
- A blood pressure reading with a pulse logs two entries: the pressure goes to Blood Pressure and the pulse goes to Heart Rate.
- The **Tracker actions** (⋯) menu has **Rename** and **Delete Tracker**.
**Gotchas / FAQ:**
- *Can I backdate an entry in the dialog?* The Log Entry dialog records the current time. To backdate, say it in chat ("log 7 hours of sleep for last night"). [verify in app]
- *Is Delete Tracker undoable?* No. It permanently deletes the tracker and all of its entries.

---

### 63. Tracker detail tabs (Overview, Trends, Breakdown, Correlations, Insights)
**Goal:** Read your tracker's charts and analysis and know when each tab shows up.
**Where to find it:** **Dashboard → Trackers** → open a tracker. The tabs sit under the header.
**What it is:** Each tracker window turns your entries into charts and plain-language findings. Tabs appear only once there is enough data to support them, so a new tracker starts with fewer tabs. A **Time frame** selector (**7D / 30D / 90D / 1Y / All**) controls Overview, Trends and Breakdown.
**Step-by-step:**
1. **Overview**: headline numbers such as **Average**, **Days logged**, **Streak** and **Total**, plus **Consistency**, **Highlights** and **Recent entries**. If the tracker has a goal, a goal ring appears here.
2. **Trends** (from 2 data points): the chart over time, a **Metric** picker for multi-field trackers, **Compared with the period before**, the highest and lowest values, and **Coverage**.
3. **Breakdown** (from 2 entries): splits that depend on the tracker, such as **By time of day** (Morning/Afternoon/Evening), **Readings by category** for blood pressure, **How long you slept**, **Your week**, or **Every measure**.
4. **Correlations** (from 3 entries): what moves together with this tracker, including other trackers. Tap a card to see a dot chart.
5. **Insights** (from 3 entries): short findings backed by your numbers.
6. Also on the strip: **History** (every entry) and **Goals** (set a target).
**Point out on screen:**
- Changing the Time frame updates the charts.
- Correlations needs at least 7 days on which both measures were logged. Until then it shows "No relationships to show yet" with progress bars.
- Insights with too little data shows "No insights yet" and a progress meter.
**Gotchas / FAQ:**
- *A tab is missing.* It hasn't unlocked yet. Keep logging.
- *Does a correlation mean one thing causes the other?* No. The screen says so: it only shows that two things moved together on the same days.
- *Medication trackers look different.* They have their own dose-focused Overview and skip the analysis tabs.

---

### 64. Habits: check-ins, time of day, streaks, restore deleted
**Goal:** Create habits, check in, schedule them for a time of day, read your streaks, and recover a habit you deleted.
**Where to find it:** The Habits page (`/habits`): open **Search** (⌘K) → **Go to Habits**, or tap the **Streak** chip on the Dashboard hub to open the **Habits** pop-up.
**What it is:** A habit is something you want to do regularly. Each check-in counts toward today's target, and finishing on consecutive days builds a streak. You can also give a habit a time of day so it groups with your morning or evening routine.
**Step-by-step:**
1. On the Habits page, tap **New Habit**. Type a name in "New habit name...", pick a **Profile**, then tap **Add**.
2. To check in, tap the next **+** circle on the habit card. Tap a filled circle to undo that check-in.
3. Change how often it repeats with the frequency pill: **Daily**, **Weekly** or **Monthly**.
4. Set the time of day in the **Habits** pop-up (Dashboard → **Streak** chip). Tap a habit's **Edit schedule**, choose **Anytime / Morning / Afternoon / Evening / Bedtime**, or set a **Custom time**. Filter the list with **All / Morning / Afternoon / Evening / Night**.
5. To delete, tap the trash icon and confirm **Delete**. Tap **Undo** on the toast (about 8 seconds) to bring it back.
**Example chat prompts:**
- "Create a habit to meditate every morning"
- "I did my meditation"
- "Unmark my workout habit, I didn't actually do it"
- "Move my lisinopril habit to the evening"
- "Bring back my meditation habit"
**Point out on screen:**
- Each habit card shows **Streak**, **Best** (longest run) and a completion % for the selected time frame, plus a **Last 14 weeks** heatmap.
- The page summary shows **Today** progress and **Completion / Streak / Record**, with a **7D / 30D / 90D** selector.
- Creating a habit with an existing name triggers a **Duplicate Habit** warning with **Create Anyway**.
**Gotchas / FAQ:**
- *The delete dialog says history is "permanently removed". Can I still restore?* Yes. Use Undo right away, or later ask chat to "restore my <habit> habit". Deleted habits can be recovered. [verify in app] that check-in history returns with it.
- *Does an unfinished day lower my rate?* No. Today only counts once it's done.

---

### 65. Goals & goal progress
**Goal:** Set measurable goals, update progress, and read pace and status.
**Where to find it:** The Goals page (`/goals`, titled **Goals**). Ways to get there: tap a goal action card in chat; the **Goals** tile in the Dashboard's **Explore** section (if that section is shown, via **Dashboard menu → Customize**); or a tracker's **Goals** tab. [verify in app] for the easiest path for new users.
**What it is:** A goal has a target, a unit and an optional deadline, like "Lose 10 lbs by June". Portol shows overall progress and flags goals that are at risk or overdue. Some goal types fill in their own progress from linked data, such as a weight tracker or a habit streak.
**Step-by-step:**
1. Tap **Add Goal** (or **Set a Goal** when the list is empty).
2. In **Create Goal**, fill in **Title**, **Target**, **Unit**, **Type** (Custom, Fitness Distance, Fitness Frequency, Habit Streak, Savings, Spending Limit, Tracker Target, Weight Gain, Weight Loss) and **Deadline**. Then tap **Create**.
3. Tap a goal to open its sheet. Under **Update Progress**, enter the current value and tap **Save**, or use the quick **+10 / +25…** buttons.
4. Use **Complete**, **Edit** or **Delete** (Delete asks for a second tap).
5. Or tap the circle beside a goal twice to mark it complete.
**Example chat prompts:**
- "I want to lose 10 lbs by June"
- "Set a goal to save $5000 by December"
- "How am I doing on my goals?"
- "Link my weight goal to my Weight tracker"
- "Mark my running goal as done"
**Point out on screen:**
- The header shows **Overall progress** and the counters **Active**, **At risk**, **Overdue** and **Done**.
- Row badges: **OVERDUE**, **AT RISK**, **DONE — MARK COMPLETE**, along with "Nd left" or "Nd late".
- The goal sheet shows a pace chip: **Ahead**, **On track**, **Slightly behind**, **Behind**, **Overdue** or **Complete**.
**Gotchas / FAQ:**
- *Reached 100% but it's not "completed"?* Portol waits for you to confirm. The row says DONE — MARK COMPLETE.
- *Why doesn't my Savings goal update itself?* Savings and Custom goals are updated by hand. Weight, fitness, tracker-target, habit-streak and spending-limit goals update from linked data.

---

### 66. Journal & notes (mood detection, appending)
**Goal:** Write journal entries (guided or free), let Portol detect your mood, add to an existing entry, and save quick notes.
**Where to find it:** Journal (`/dashboard/journal`): **Search** (⌘K) → **Go to Journal**, or **New journal entry**. Notes are created from **Chat** and appear in **Artifacts**.
**What it is:** The journal is your diary. You can use the guided "5 Minute Morning Journal" or write freely. If you don't pick a mood, Portol reads your words and sets one for you. Notes are different: they hold facts you want to look up later, like a gate code or a preference.
**Step-by-step:**
1. Tap **New Entry**. Choose **Guided** or **Free write**.
2. **Free write**: type in the box ("Whatever is on your mind — no length limits."). It autosaves about 2 seconds after you stop typing. Add **Tags** and a **Profile**, then tap **Save Entry**.
3. **Guided**: fill in **How Are You Feeling?**, **I Am Grateful For...**, **How Can I Make Today Amazing?**, **Daily Affirmation** and **Energy Level**, then tap **Save Morning Entry**.
4. Edit or delete entries from the list with the pencil and trash icons. Use **Search entries…** to find old ones.
5. To add to today's entry, say it in chat (see prompts below).
**Example chat prompts:**
- "Journal: today was exhausting but I finally finished the project"
- "Add this to today's journal: dinner with Sam was great"
- "Add to yesterday's entry that I slept badly"
- "Make a note that Robert's gate code is 4821"
- "Note for Sarah: she prefers morning appointments"
- "What was Robert's gate code?"
**Point out on screen:**
- The 7-day mood strip at the top of the page.
- The **Mood over time** chart (**30D / 90D / All**) and **Typical day**.
- Free write shows "Autosaves as you write", then "Saved <time>".
**Gotchas / FAQ:**
- *I didn't choose a mood but one appeared.* Portol detected it from your text. Edit the entry to change it.
- *Where do notes go?* They are saved as notes in **Artifacts**, and on the person's profile if the note is for someone. They are not journal entries. [verify in app] for the exact Artifacts filter notes appear under. A dashboard "Quick Notes" section is [verify in app]: it is not in the current dashboard section list.
- *"Mood 7/10" went to a tracker, not the journal?* That's on purpose. Mood scores are logged to a Mood tracker.

---

### 67. Insights page & weekly review
**Goal:** Check unusual patterns, scan a receipt into an expense, and generate an editable weekly review.
**Where to find it:** Insights (`/insights`): **Search** (⌘K) → **Insights**, **Scan receipt** or **Generate weekly review**.
**What it is:** Insights collects three tools on one page. **Anomalies** flags unusual spending, budget or tracker activity. **Scan Receipt** reads a receipt photo. **Weekly Review** writes a recap of your last 7 days as a document you can edit.
**Step-by-step:**
1. Open Insights. Tap **Refresh** (top right) to re-scan for anomalies.
2. Read the **Anomalies** card. The counters show **Urgent**, **Watch** and **FYI**. Each item shows its category, a "+N% vs usual" figure and a short explanation.
3. Under **Weekly Review**, tap **Generate this week's review**. Portol creates the document and opens it in the editor.
4. Under **Scan Receipt**, tap **Pick a receipt photo**. Check the extracted **Vendor**, **Amount**, **Date**, **Category** and **Line items**, then tap **Save as expense** (or **Dismiss**).
**Point out on screen:**
- When nothing is unusual, the Anomalies card says: "Nothing unusual right now. Spending, budgets, and tracker activity all look normal."
- The weekly review covers tasks, spending, trackers and journal, and appears afterward in **Artifacts**.
- The profile scope (whose data you're viewing) applies to anomalies and to the review.
**Gotchas / FAQ:**
- *Receipt scan says "Couldn't read receipt fully".* Some fields were missing. Review them before saving.
- *Only images work for receipt scan.* PDFs aren't accepted here. Upload those as documents instead.
- *Where's the review later?* It's a document in Artifacts. Open it to edit.

---

### 68. Uploading, viewing & reviewing documents (PDF viewer, re-extract)
**Goal:** Upload a document, review what Portol extracted, view the file, edit fields and re-extract.
**Where to find it:** Upload with the paperclip (**Attach file or image**) in **Chat**, or **Dashboard → Documents** chip → **Upload** (with the **For: Auto-detect** picker). Browse documents under **Documents** or **Artifacts → Documents**.
**What it is:** Upload an ID, insurance card, statement or other paperwork. Portol reads it and pulls out key fields and dates. Before anything is saved to your profiles or calendar, you can review each extracted item.
**Step-by-step:**
1. In Chat, tap the paperclip and choose a file (images, PDF, Word, Excel; max 10MB). Tell Portol who it belongs to if asked. [verify in app] for that prompt's wording.
2. The **Review Document** screen opens. **Document Preview** is on one side, with zoom and full-screen. **Document Info**, **Confidence Score** and **Linked To** (**Link to profile…**) are on the other.
3. In the extracted-data table (**Extracted Field / Value / Confidence / Suggested Destination / Action**), set each row to **Confirm** or **Skip**. Then tap **Confirm All**.
4. Later, open a document from the Documents list to view it. Zoom in, zoom out and rotate the page, rename it by tapping the title, **Download file**, edit or **Delete field**, **Add Field**, and add **Tags**. **Share** offers **Send via Email** or **Send via Text**.
5. To re-read a document, ask in chat (see prompts).
**Example chat prompts:**
- "Show me my passport"
- "Re-extract my car insurance document"
- "Link the registration to my Honda"
- "Rename the Geico PDF to Auto Insurance 2026"
**Point out on screen:**
- Date fields wear status badges: expired (red), expiring within 30 days (yellow), valid (green).
- Multi-page PDFs show page 1 first while the rest load.
**Gotchas / FAQ:**
- *Is there a re-extract button?* No. Re-extraction is done from chat.
- *Deleting a document* gives two choices: **Delete document and its data** or **Delete document only** (the extracted data is kept).

---

### 69. Document alerts & supersession (why a renewed document clears the old alert)
**Goal:** Understand why expiring documents raise alerts, and why uploading the renewed version clears the old alert.
**Where to find it:** The **bell** (top bar). Also the date badges on a document's fields (**Dashboard → Documents** → open a document).
**What it is:** When a document has an expiration, renewal or end date, Portol warns you as the date approaches and after it passes. When you upload the newer version, such as next year's registration, Portol sees that the old one has been replaced and stops warning about it. You don't have to dismiss anything. The old document stays as history.
**Step-by-step:**
1. Upload a document with an expiration date (see tutorial 68).
2. Within 30 days of the date, the bell shows something like "Expiring soon: <document name>". After the date, it shows "Expired: <document name>".
3. Upload the renewed document of the same kind, for the same person or thing, with a later date.
4. Open the bell again: the old alert is gone. The new document is only flagged when its own date comes near.
**Point out on screen:**
- Severity: within 7 days shows under **Attention**. Earlier, within 30 days, it shows under **Info**. An expired legal or insurance record shows under **Critical**.
- The old document still lists its original date on its own page.
**Gotchas / FAQ:**
- *The old alert didn't clear.* Portol only treats the new document as a replacement when all of these match: the same document type (not "other"), the same kind of date (expiration vs. expiration), a later date, the same subject (the same vehicle or policy, or for a passport, the same person), and similar names. A home policy never clears an auto policy.
- *Can I just dismiss it?* Yes, with the X in the bell. A dismissal covers that one date only, so a corrected or future date can alert again.
- *Did deleting the old document do this?* No. You don't need to delete history. The newer document is what resolves the alert.

---

### 70. Artifacts: notes, checklists, markdown, code, charts, diagrams
**Goal:** Have the AI create notes, checklists, reports, code, charts and diagrams, then find, pin, tick off and delete them.
**Where to find it:** **Artifacts** (sidebar or bottom bar, `/artifacts`). Create them from **Chat**.
**What it is:** Artifacts is your library: uploaded files plus everything made in the app, such as AI reports, checklists, notes, code snippets, charts and diagrams. You ask for one in chat and it's saved here, linked to the right profile.
**Step-by-step:**
1. In Chat, ask for something, e.g. "Make a packing checklist for Denver."
2. Open **Artifacts**. The top counters are **Files**, **Notes & reports** and **Showing**.
3. Filter with **All**, **Documents**, **AI Outputs** or **Scans**. Use **Search artifacts...** or the **#tag** chips.
4. Tap a card to open it. Checklist boxes can be ticked right there. Markdown, code, charts and diagrams render inside the window.
5. Use the pin icon (**Pin/Unpin**) to keep an item on the **Pinned** shelf. Use **Delete**, then confirm.
**Example chat prompts:**
- "Make a grocery checklist: milk, eggs, bread"
- "Check off milk on my grocery list"
- "Write a markdown summary of my spending this month"
- "Create a diagram of my morning routine"
- "Duplicate my packing list"
- "Pin my grocery list"
**Point out on screen:**
- Owner chips on each card show every profile an artifact belongs to.
- With filters active and nothing matching, the page says "No items match these filters" and offers **Clear filters**. That is not the same as having no artifacts.
- Documents and sheets open in the full editor instead of the pop-up.
**Gotchas / FAQ:**
- *Where are journal entries?* On the Journal page, not in Artifacts.
- *Delete is permanent.* "This permanently removes the file and any history."

---

### 71. The editor & linked spreadsheets
**Goal:** Create and edit Word-style documents and spreadsheets, and view a profile's linked items as a sheet.
**Where to find it:** **Search** (⌘K) → **New document** or **New spreadsheet**; the **Quick create** button → **Doc** or **Sheet**; or the chat composer's **Create document or spreadsheet** → **Document** / **Spreadsheet**. Routes: `/editor/new/doc`, `/editor/new/sheet`.
**What it is:** Portol has a built-in document editor and spreadsheet. Docs support headings, lists, AI writing help and @mentions of your records. Sheets support formulas, multiple tabs and charts. On profile pages, linked items such as assets, documents and subscriptions can switch to a spreadsheet-style view.
**Step-by-step:**
1. Open a new doc. Click the title ("Click to rename") to name it.
2. Type **/** to open commands: Heading 1–3, Bullet list, Numbered list, Quote, Code block, Divider, plus **AI: Improve writing**, **AI: Summarize**, **AI: Continue writing**, **AI: Make shorter**, **AI: Make longer** and **AI: Fix grammar & spelling**.
3. Type **@Name** to mention a record. **Show linked entities** opens a sidebar listing what you mentioned.
4. **Template** inserts a starter, e.g. Meeting notes, Weekly review, Project plan, Monthly budget or Workout log.
5. Tap **Save** (or ⌘S). After the first save, changes autosave.
6. **Download** gives **Download as PDF** or **Download as Word** for docs, and an Excel file for sheets. **Print**, **Copy** and **Delete** are also in the toolbar.
7. On a profile page, flip a linked section's **List / Sheet** toggle to see a grid view.
**Point out on screen:**
- Sheets accept formulas.
- **Insert chart from range** (A1 notation, **First row is headers**, Bar/Line/Area/Pie) saves a chart artifact. [verify in app] for where this is opened in the new spreadsheet UI.
- On mobile, the toolbar collapses into **More**.
**Gotchas / FAQ:**
- *Nothing autosaved?* Autosave starts only after you press Save once.
- *Can I edit in Sheet view on a profile?* No. It's a read-only table. Tap a row to open the item.

---

### 72. Sharing via link (create & revoke)
**Goal:** Share a read-only copy of a document or sheet with anyone, and turn the link off later.
**Where to find it:** Open a doc or sheet in the editor → **Share** (desktop toolbar or mobile **More** menu).
**What it is:** A public link lets someone view a read-only copy of your document or spreadsheet without signing in. You can revoke it at any time and the link stops working.
**Step-by-step:**
1. Open the doc or sheet and tap **Share**. If it has never been saved, it saves first.
2. The **Share this document** (or **Share this sheet**) dialog says "Sharing is off."
3. Tap **Generate link**.
4. Under **Public link**, tap **Copy** (it changes to **Copied**) or **Open in new tab**.
5. To stop sharing, open **Share** again and tap **Revoke link**. A "Share link revoked" toast confirms it.
**Point out on screen:**
- The shared page is read-only and footed "Shared via Portol."
- After revoking, the old link shows "This link isn't available".
- The link looks like `portol.me/#/share/<code>`.
**Gotchas / FAQ:**
- *Can I share a tracker, journal or uploaded document by link?* Public links are made from the editor (docs and sheets). For uploaded documents, the document viewer's **Share** menu offers **Send via Email** or **Send via Text** instead.
- *Does the viewer see my edits?* They see the saved version. [verify in app] whether later edits appear on the same link.
- *Is it private?* Anyone with the link can view it. Revoke it when you're done.

---

### 73. The notification bell (read, dismiss, custom notifications)
**Goal:** Read, open and dismiss notifications, and create your own from chat.
**Where to find it:** The **bell** icon (**Notifications**) in the top bar on every page.
**What it is:** The bell collects what needs your attention: expiring documents, overdue or due-today tasks, upcoming bills, habits at risk, streak milestones, reminders, and notifications you asked for. A red badge shows how many are waiting.
**Step-by-step:**
1. Tap the bell. The panel title is **Notifications (N)**.
2. Items are grouped as **Critical** (red), **Attention** (amber) and **Info** (blue).
3. Tap an item to go straight to the record it's about. Opening it also clears it from the list.
4. Tap **X** (**Dismiss notification**) to clear one, or **Dismiss all** to clear the list.
5. With nothing left, it reads "All clear! No notifications."
**Example chat prompts:**
- "Notify me about the insurance renewal"
- "Create an urgent notification that rent is due Friday"
- "Mark all my notifications as read"
- "Dismiss the bill notifications"
- "Dismiss all my notifications"
**Point out on screen:**
- The badge number always matches the number of items in the panel.
- Dismissals sync across devices and tabs.
- The list follows the current profile scope (whose data you're viewing).
**Gotchas / FAQ:**
- *A dismissed alert came back.* A dismissal covers one specific date. If the date changes, or the next occurrence comes due, it's a new notification.
- *"Mark as read" from chat didn't affect a document alert.* Only notifications you created yourself can be marked read. Others are dismissed.
- *An alert disappeared on its own.* The underlying item was resolved, e.g. a renewed document replaced the old one (see tutorial 69).

---

### 74. Notification preferences
**Goal:** Control which notifications you get.
**Where to find it:** **Settings → Notifications** card. Muting categories is done in **Chat**.
**What it is:** The Settings card has two switches. To silence specific kinds of alerts in the bell, for example all Info items or all bill alerts, ask the AI and it saves a mute preference. You can unmute everything at any time.
**Step-by-step:**
1. Open **Settings** (sidebar bottom, or **Account menu → Settings**).
2. In **Notifications** ("Control how Portol notifies you."), toggle **Enable Notifications** ("Receive in-app notifications for reminders and updates").
3. Toggle **Email Notifications** ("Receive email alerts for important events").
4. To mute categories, go to Chat and say e.g. "mute info notifications".
5. To undo, say "unmute everything".
**Example chat prompts:**
- "Mute info notifications"
- "Stop showing bill alerts"
- "Stop showing streak alerts"
- "Unmute everything"
**Point out on screen:**
- The switches save immediately. There is no Save button.
- After muting, the bell's count drops to match.
**Gotchas / FAQ:**
- *What can be muted?* By severity (critical, warning, info) or by type: document expiring, task overdue, task due today, bill due, habit at risk, streak milestone, reminder, custom.
- *Do the two switches change what the bell shows or send email?* They save your preference. [verify in app] for their current effect: no code path reading them was found.
- *Muting vs. dismissing:* dismissing clears one item. Muting hides a whole category until you unmute it.

---

### 75. Settings tour (all sections)
**Goal:** Know what every Settings section does.
**Where to find it:** **Settings** at the bottom of the desktop sidebar, or **Account menu** (avatar, top right) → **Settings** (`/settings`). Header: "Account, appearance, data and privacy."
**What it is:** One page holds your account, look and feel, AI behavior, notifications, data tools, privacy information, the ChatGPT import, connected services and app info.
**Step-by-step:**
1. **Account**: your email, member-since date and sign-in method; **Your Data** counts (Profiles, Active Tasks, Trackers, Documents); **Change Password** (Google sign-ins show "Password managed by Google"); **Sign Out**.
2. **Appearance**: **Mode** (Light/Dark/System), **Accent color** (Cyan, Blue, Violet, Emerald, Rose, Amber, Slate) and **Custom hue**.
3. **AI & Chat**: **Chat Model** (Sonnet 4.6 (powerful) / Haiku 4.5 (faster)); **Document Extraction** model; switches for **Fast-Path Commands**, **Auto-Expense from Documents**, **Smart Data Routing** and **Auto-Create Trackers**; **Enhanced Item Lookup** (Automatic / Ask when uncertain / Off).
4. **Notifications**: **Enable Notifications** and **Email Notifications**.
5. **Data Management**: **Export Backup**, **Restore from Backup**, **Import Bank Statement**, **Clear Cache**.
6. **Privacy & Security**: how sign-in, data and files are stored; **Delete All Data**.
7. **Import from ChatGPT**: **Refresh from ChatGPT** and **Import history**.
8. **Connected Services**: **Google Calendar** (**Sync now** when connected), **Finance** (**Connect Financial Account**), **Apple Health** (**Coming Soon**).
9. **About Portol**: Version, Platform, AI Engine and Hosting.
**Point out on screen:**
- An **Install Portol** card may appear, offering to add the app to your home screen.
- AI switches take effect right away.
**Gotchas / FAQ:**
- *Turned off Auto-Create Trackers and now logging fails?* Create the tracker first in chat ("track my X"), then log to it.
- *Google Calendar shows "Not connected".* [verify in app] for how to connect. Settings only shows the sync button once you're connected.

---

### 76. Exporting & managing your data
**Goal:** Back up, restore, import, download and, if you need to, delete your data.
**Where to find it:** **Settings → Data Management** and **Settings → Privacy & Security**. Also **Dashboard menu** → **Export Data** / **Import Backup**. [verify in app] for where that menu button appears.
**What it is:** You can download everything as one backup file, restore from it later, bring in bank transactions from a CSV, or import finances prepared in ChatGPT. Single items can be downloaded too: documents, docs (PDF/Word) and sheets (Excel). Deleting all data is protected by a typed confirmation.
**Step-by-step:**
1. **Export Backup** → **Export**. This downloads `portol-backup-<date>.json`, and the time of your last export appears under it.
2. **Restore from Backup** → **Import**. Choose a Portol `.json` backup. You'll see "Import complete" when it finishes.
3. **Import Bank Statement** → **Upload CSV** creates expense entries.
4. **Clear Cache** → **Clear** refreshes all data from the server. Nothing is deleted.
5. **Import from ChatGPT** → **Refresh from ChatGPT** → **Copy prompt** → **Open ChatGPT** → **Next** → paste the answer → **Validate & preview** → **Import N items**.
6. **Privacy & Security → Delete All Data → Delete**. Type **DELETE**, then tap **I understand, delete everything**.
**Point out on screen:**
- The export toast lists counts ("Exported N tasks, …").
- The delete dialog lists everything it removes. Your profile is kept.
- **Import history** under the ChatGPT import shows past imports, with undone ones marked "Undone".
**Gotchas / FAQ:**
- *Is Delete All Data reversible?* No. Export a backup first.
- *Does Clear Cache delete anything?* No, it only reloads data.
- *Can I export one document?* Yes. Open it and use **Download file**. In the editor, use **Download**.
