import { useEffect } from "react";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

export default function PrivacyPage() {
  useEffect(() => { document.title = "Privacy Policy — Portol"; }, []);
  return (
    <div className="min-h-screen bg-background overflow-y-auto p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <Link href="/"><button className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Back</button></Link>
        <h1 className="text-2xl font-bold">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground">Last updated: April 3, 2026</p>

        <div className="prose prose-invert prose-sm max-w-none space-y-4 text-sm text-muted-foreground">
          <h2 className="text-foreground text-base font-semibold">1. Information We Collect</h2>
          <p>Portol collects the following information when you use our service:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong className="text-foreground">Account information:</strong> Email address and authentication credentials when you sign up.</li>
            <li><strong className="text-foreground">User-generated content:</strong> Profiles, expenses, tasks, habits, trackers, documents, calendar events, and other data you create within the app.</li>
            <li><strong className="text-foreground">Uploaded files:</strong> Documents and images you upload for AI extraction and storage.</li>
            <li><strong className="text-foreground">Usage data:</strong> Basic error reporting to improve app stability.</li>
          </ul>

          <h2 className="text-foreground text-base font-semibold">2. How We Use Your Information</h2>
          <p>Your data is used exclusively to provide the Portol service:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Storing and organizing your personal life data as you direct</li>
            <li>Processing natural language commands via AI to create and manage your records</li>
            <li>Generating dashboards, charts, and insights from your data</li>
            <li>Extracting information from uploaded documents</li>
          </ul>

          <h2 className="text-foreground text-base font-semibold">3. Data Storage & Security</h2>
          <p>Your data is stored in Supabase (cloud infrastructure) with row-level security (RLS) enabled. This means:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Only you can access your data — other users cannot see your records</li>
            <li>All data is transmitted over HTTPS encryption</li>
            <li>Authentication is handled via Supabase Auth with secure token management</li>
          </ul>

          <h2 className="text-foreground text-base font-semibold">4. AI Processing</h2>
          <p>When you use the chat feature, your messages are sent to Anthropic's Claude API for natural language processing. Anthropic does not retain your data for training purposes. Your conversation context is processed in memory and not permanently stored by the AI provider.</p>

          <h2 className="text-foreground text-base font-semibold">5. Third-Party Services</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong className="text-foreground">Supabase:</strong> Database and authentication</li>
            <li><strong className="text-foreground">Anthropic:</strong> AI chat processing</li>
            <li><strong className="text-foreground">Google:</strong> OAuth sign-in (optional)</li>
            <li><strong className="text-foreground">Vercel:</strong> Application hosting</li>
          </ul>

          <h2 className="text-foreground text-base font-semibold">6. Data Retention & Deletion</h2>
          <p>Your data is retained as long as your account is active. You can delete individual records at any time. To delete your entire account and all associated data, contact us at the email below.</p>

          <h2 className="text-foreground text-base font-semibold">7. Your Rights</h2>
          <p>You have the right to:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Access all your data (via the Export feature in Settings)</li>
            <li>Delete any or all of your data</li>
            <li>Request a copy of your data</li>
            <li>Close your account</li>
          </ul>

          <h2 className="text-foreground text-base font-semibold">8. Children's Privacy</h2>
          <p>Portol is not intended for children under 13. We do not knowingly collect data from children.</p>

          <h2 className="text-foreground text-base font-semibold">9. Changes to This Policy</h2>
          <p>We may update this policy from time to time. Continued use of Portol after changes constitutes acceptance.</p>

          <h2 className="text-foreground text-base font-semibold">10. Contact</h2>
          <p>For privacy questions: <a href="mailto:tronmooo@gmail.com" className="text-primary hover:underline">tronmooo@gmail.com</a></p>
        </div>
      </div>
    </div>
  );
}
