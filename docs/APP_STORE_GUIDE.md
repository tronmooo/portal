# Portol — App Store Submission Guide

## Prerequisites (on your Mac)

1. **Apple Developer Account** — enroll at [developer.apple.com](https://developer.apple.com) ($99/year)
2. **Xcode** — install latest from Mac App Store, then:
   ```bash
   xcode-select --install
   sudo gem install cocoapods
   ```
3. **Node.js 18+** — already installed if you've been developing

## Step 1: Clone & Install

```bash
git clone https://github.com/tronmooo/portal.git portol
cd portol
npm install
```

## Step 2: Initialize iOS Project

```bash
npx cap add ios
```

This creates an `ios/` folder with a full Xcode project.

## Step 3: Build the Web App

```bash
npx tsx script/build-vercel.ts
```

## Step 4: Sync Web Build to iOS

```bash
npx cap sync ios
```

## Step 5: Open in Xcode

```bash
npx cap open ios
```

## Step 6: Configure in Xcode

1. **Select your Team** — Xcode > Signing & Capabilities > Team (your Apple Developer account)
2. **Bundle Identifier** — should be `me.portol.app`
3. **Display Name** — "Portol"
4. **Deployment Target** — iOS 16.0 or higher
5. **App Icons** — drag your 1024x1024 app icon into Assets.xcassets > AppIcon

### Required Capabilities:
- No special capabilities needed (no push notifications, no camera, no location)

### Info.plist Keys to Add:
```xml
<key>ITSAppUsesNonExemptEncryption</key>
<false/>
```
(This tells Apple you don't use custom encryption — just HTTPS)

## Step 7: Test on Your iPhone

1. Connect your iPhone via USB
2. In Xcode, select your phone as the build target
3. Click the Play button (⌘R)
4. Trust the developer certificate on your phone: Settings > General > VPN & Device Management

## Step 8: Archive & Upload

1. In Xcode: Product > Archive
2. Once archived, click "Distribute App"
3. Select "App Store Connect"
4. Follow the wizard to upload

## Step 9: App Store Connect

Go to [App Store Connect](https://appstoreconnect.apple.com):

1. **New App** — click the + button
2. Fill in:
   - **Name**: Portol
   - **Subtitle**: AI-powered life command center
   - **Bundle ID**: me.portol.app
   - **SKU**: portol-app-001
   - **Primary Language**: English (U.S.)
3. **Category**: Productivity (primary), Lifestyle (secondary)
4. **Privacy Policy URL**: https://portol.me/#/privacy
5. **Description**:

```
Portol is your AI-powered life command center. Talk naturally and Portol organizes everything — finances, health, tasks, habits, documents, and more.

FEATURES:
• AI Chat — Just say "I spent $45 on groceries" or "Track my blood pressure at 120/80" and Portol handles it
• Dashboard — See your whole life at a glance with real-time KPIs
• Profiles — Organize by people, pets, vehicles, subscriptions
• Documents — Upload receipts and IDs, AI extracts data automatically
• Trackers — Blood pressure, weight, running, sleep — track anything
• Calendar — Events, tasks, bills, birthdays in one place
• Finance — Expenses, income, net worth, cash flow

Your data is secured with row-level security. Only you can access your information.
```

6. **Keywords**: life management, ai assistant, expense tracker, habit tracker, health tracker, personal finance, productivity, task manager, document scanner, family organizer

7. **Screenshots** — Take screenshots on an iPhone 15 Pro Max (6.7") and iPhone SE (4.7"):
   - Login page with tutorial
   - Dashboard
   - Chat with example
   - Profile detail
   - Calendar
   - Trackers

8. **App Privacy** — Data types collected:
   - Contact Info (email) — Used for App Functionality
   - Health & Fitness (if tracking health) — Used for App Functionality
   - Financial Info (expenses) — Used for App Functionality
   - User Content (documents, notes) — Used for App Functionality
   - Data NOT linked to identity: None
   - Data NOT used to track: All categories

## Step 10: Submit for Review

1. Select the build you uploaded
2. Answer the review questions:
   - "Does your app use IDFA?" — No
   - "Does your app use encryption?" — No (just HTTPS)
3. Submit for review

Apple typically reviews within 24-48 hours.

## Updating the App

After making changes:
```bash
cd portol
npx tsx script/build-vercel.ts
npx cap sync ios
npx cap open ios
# Then Archive > Distribute in Xcode
```

## Important Notes

- The Capacitor config points to `https://portol.me` as the server URL. The iOS app is essentially a native wrapper around your web app. All API calls go to your Vercel deployment.
- For Google Sign-In to work in the iOS app, you may need to add a URL scheme for the Google OAuth redirect. Add `me.portol.app` as a URL scheme in Xcode > Info > URL Types.
- The first version of the app should pass review since it has real functionality, a privacy policy, and doesn't violate any App Store guidelines.
