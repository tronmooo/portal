# Portol — Complete App Store Submission Guide

Everything you need to get Portol into the iOS App Store using Capacitor.

---

## Prerequisites (One-Time Setup on Your Mac)

### 1. Apple Developer Account
- Go to [developer.apple.com](https://developer.apple.com/programs/) and enroll ($99/year)
- Accept all agreements in [App Store Connect](https://appstoreconnect.apple.com)
- Note your Team ID (found in Membership section)

### 2. Install Xcode + Tools
```bash
# Install Xcode from Mac App Store (latest stable — 16.x)
# Then run:
xcode-select --install
sudo gem install cocoapods
```

### 3. Node.js
Make sure you have Node.js 18+ installed. If not: `brew install node`

---

## Step-by-Step: Build → Xcode → App Store

### Step 1: Clone and install

```bash
git clone https://github.com/tronmooo/portal.git portol
cd portol
npm install
```

### Step 2: Build the web app

```bash
npx tsx script/build-vercel.ts
```

This creates `dist/public/` with the compiled frontend.

### Step 3: Add the iOS platform

```bash
npx cap add ios
```

This creates an `ios/` folder with a full Xcode project. You only run this once.

### Step 4: Sync web build into the iOS project

```bash
npx cap sync ios
```

This copies your `dist/public/` files into the native iOS project and installs CocoaPods dependencies.

### Step 5: Open in Xcode

```bash
npx cap open ios
```

This opens the `ios/App/App.xcworkspace` file in Xcode.

---

## Xcode Configuration

### Signing & Capabilities
1. In the left sidebar, click **App** (the blue icon at the top)
2. Go to **Signing & Capabilities** tab
3. Check **Automatically manage signing**
4. Select your **Team** (your Apple Developer account)
5. **Bundle Identifier** should be: `me.portol.app`

### General Settings
- **Display Name**: Portol
- **Bundle Identifier**: me.portol.app
- **Version**: 1.0.0
- **Build**: 1
- **Deployment Target**: iOS 16.0
- **Device Orientation**: Portrait only (uncheck Landscape Left and Landscape Right)

### Info.plist
Click on `App/App/Info.plist` and add these keys:

| Key | Type | Value |
|-----|------|-------|
| `ITSAppUsesNonExemptEncryption` | Boolean | NO |
| `NSAppTransportSecurity` → `NSAllowsArbitraryLoads` | Boolean | YES |

The first key tells Apple you don't use custom encryption (just HTTPS).
The second ensures the WebView can load your Vercel server.

### App Icons
1. In Xcode, open `App/App/Assets.xcassets`
2. Click on **AppIcon**
3. You need a **1024x1024** PNG app icon
4. Drag it onto the "All Sizes" slot (Xcode 15+ auto-generates all sizes)

> If you don't have a 1024x1024 icon yet, create one at [appicon.co](https://www.appicon.co/) — upload any square image and it generates all sizes.

---

## Test on Your iPhone

1. Connect your iPhone to your Mac via USB/Lightning cable
2. In Xcode's top toolbar, select your phone as the build target (next to the Play button)
3. Click **Play** (⌘R) to build and run
4. On your iPhone: Settings → General → VPN & Device Management → trust your developer certificate
5. The app should open and show the Portol login screen

### Things to verify:
- [ ] Login page shows the onboarding tutorial
- [ ] Google Sign-In works
- [ ] Email/password sign-in works  
- [ ] All pages load (Dashboard, Chat, Profiles, Calendar, etc.)
- [ ] Bottom navigation bar doesn't overlap with iPhone home indicator
- [ ] Status bar text is visible (white on dark background)
- [ ] Keyboard pushes content up correctly in chat

---

## Archive and Upload to App Store

### 1. Archive
1. In Xcode's target selector, change from your iPhone to **Any iOS Device (arm64)**
2. Go to **Product → Archive**
3. Wait for the build to complete (1-2 minutes)
4. The Organizer window opens automatically

### 2. Distribute
1. In the Organizer, select your archive
2. Click **Distribute App**
3. Select **App Store Connect**
4. Click **Next** through the options (defaults are fine)
5. Click **Upload**
6. Wait for upload to complete

---

## App Store Connect Setup

Go to [appstoreconnect.apple.com](https://appstoreconnect.apple.com):

### Create New App
1. Click **My Apps** → **+** → **New App**
2. Fill in:
   - **Platform**: iOS
   - **Name**: Portol
   - **Primary Language**: English (U.S.)
   - **Bundle ID**: me.portol.app
   - **SKU**: portol-001

### App Information
- **Subtitle**: AI-powered life command center
- **Category**: Productivity (primary), Lifestyle (secondary)
- **Content Rights**: Does not contain third-party content
- **Age Rating**: 4+ (no objectionable content)

### Pricing
- **Price**: Free (or choose your price)
- **Availability**: All territories

### Privacy
- **Privacy Policy URL**: `https://portol.me/#/privacy`

### App Privacy (Data Collection)
When asked "Does your app collect data?", select **Yes** and declare:

| Data Type | Usage | Linked to Identity |
|-----------|-------|--------------------|
| Email Address | App Functionality | Yes |
| Other Financial Info | App Functionality | Yes |
| Health & Fitness | App Functionality | Yes |
| Other User Content | App Functionality | Yes |

- **Data NOT used to track users**: Select this for all types

### Description
```
Portol is your AI-powered life command center. Talk naturally and Portol organizes everything — finances, health, tasks, habits, documents, and more.

FEATURES:

• AI Chat — Say "I spent $45 on groceries" or "Track my blood pressure at 120/80" and Portol handles it automatically
• Smart Dashboard — See spending, health, habits, tasks, and net worth at a glance
• Profiles — Organize people, pets, vehicles, and subscriptions with their own dashboards
• Document AI — Upload receipts, IDs, and prescriptions. AI extracts and files data automatically
• Health Trackers — Blood pressure, weight, running, sleep — track anything with charts
• Calendar — Events, tasks, bill due dates, and birthdays synced in one view
• Finance — Expenses, income, obligations, and net worth tracking

PRIVACY & SECURITY:
• Row-level security — only you can access your data
• Data encrypted in transit (HTTPS)
• No ads, no data selling
```

### Keywords (100 characters max)
```
life management,ai assistant,expense tracker,habit tracker,health,productivity,finance,organizer
```

### Screenshots
You need screenshots for:
- **6.7" (iPhone 15 Pro Max)**: At least 3, up to 10
- **6.5" (iPhone 14 Plus)**: Optional but recommended
- **5.5" (iPhone 8 Plus)**: Required if supporting older devices

Take these screenshots by running the app on the Simulator in Xcode:
1. Login page (showing onboarding tutorial)
2. Dashboard (with KPIs populated)
3. Chat (showing a conversation with AI)
4. A profile detail page
5. Calendar view
6. Trackers page

To screenshot the Simulator: **⌘S** (saves to Desktop)

### Select Build
1. After uploading from Xcode, wait ~15 minutes for processing
2. In App Store Connect, go to your app version
3. Under "Build", click **+** and select the build you uploaded

### Submit for Review
1. Fill in all required fields (marked with red indicators)
2. Under "App Review Information":
   - **Contact**: Your name, email, phone
   - **Demo Account**: `tron@aol.com` / `password` (for Apple reviewers to test)
   - **Notes**: "Portol is an AI-powered personal life management app. Sign in with the demo account to see pre-populated data."
3. Click **Submit for Review**

---

## After Submission

- Apple typically reviews within **24-48 hours**
- You'll get an email when approved (or if changes are needed)
- Common rejection reasons and fixes:
  - "Crashes on launch" → Test on a real device first
  - "Incomplete information" → Fill all required fields in App Store Connect
  - "Guideline 4.2 - Minimum Functionality" → Portol has substantial features, this shouldn't apply
  - "Requires login" → Provide the demo account in review notes

---

## Updating the App Later

After making code changes:

```bash
cd portol
git pull                          # get latest code
npx tsx script/build-vercel.ts    # rebuild web app
npx cap sync ios                  # sync to iOS project
npx cap open ios                  # open Xcode
# In Xcode: bump Build number, then Product → Archive → Distribute
```

Since the app loads from `https://portol.me`, most web updates go live instantly without a new App Store build. You only need a new build if you change:
- Native iOS config (Info.plist, Capacitor plugins)
- App icon or splash screen
- Capacitor version

---

## Architecture Note

The iOS app is a **native WKWebView wrapper** around your Vercel-deployed web app at `portol.me`. This means:
- Web code changes deploy instantly via Vercel (no App Store review needed)
- The native shell provides: proper status bar, safe areas, keyboard handling, app icon, splash screen
- Google OAuth works because `portol.me` is in the allowed navigation list
- All API calls go to your Vercel serverless functions as usual
