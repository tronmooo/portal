import { useEffect } from "react";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

export default function TermsPage() {
  useEffect(() => { document.title = "Terms of Service — Portol"; }, []);
  return (
    <div className="min-h-screen bg-background overflow-y-auto p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <Link href="/"><button className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Back</button></Link>
        <h1 className="text-2xl font-bold">Terms of Service</h1>
        <p className="text-sm text-muted-foreground">Last updated: April 3, 2026</p>

        <div className="prose prose-invert prose-sm max-w-none space-y-4 text-sm text-muted-foreground">
          <h2 className="text-foreground text-base font-semibold">1. Acceptance of Terms</h2>
          <p>By accessing or using Portol ("the Service"), you agree to be bound by these Terms of Service. If you do not agree, do not use the Service.</p>

          <h2 className="text-foreground text-base font-semibold">2. Description of Service</h2>
          <p>Portol is an AI-powered personal life management application. It allows you to track finances, health metrics, tasks, habits, documents, and profiles through natural language and traditional UI interactions.</p>

          <h2 className="text-foreground text-base font-semibold">3. User Accounts</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>You must provide accurate information when creating an account</li>
            <li>You are responsible for maintaining the security of your account credentials</li>
            <li>You must be at least 13 years old to use the Service</li>
          </ul>

          <h2 className="text-foreground text-base font-semibold">4. User Content</h2>
          <p>You retain ownership of all data and content you create in Portol. You grant Portol a limited license to store, process, and display your content solely to provide the Service to you.</p>

          <h2 className="text-foreground text-base font-semibold">5. AI Features</h2>
          <p>Portol uses AI (Anthropic Claude) to process your natural language commands. While we strive for accuracy, AI-generated responses and data processing may contain errors. You should verify important information independently. Portol is not a substitute for professional financial, medical, or legal advice.</p>

          <h2 className="text-foreground text-base font-semibold">6. Acceptable Use</h2>
          <p>You agree not to:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Use the Service for any illegal purpose</li>
            <li>Attempt to access other users' data</li>
            <li>Interfere with the Service's operation</li>
            <li>Reverse engineer the Service</li>
          </ul>

          <h2 className="text-foreground text-base font-semibold">7. Limitation of Liability</h2>
          <p>Portol is provided "as is" without warranties of any kind. We are not liable for any data loss, inaccuracies in AI processing, or decisions made based on information in the app. Use the Service at your own risk.</p>

          <h2 className="text-foreground text-base font-semibold">8. Termination</h2>
          <p>We reserve the right to terminate accounts that violate these terms. You may delete your account at any time.</p>

          <h2 className="text-foreground text-base font-semibold">9. Changes to Terms</h2>
          <p>We may update these terms. Continued use after changes constitutes acceptance.</p>

          <h2 className="text-foreground text-base font-semibold">10. Contact</h2>
          <p>Questions: <a href="mailto:tronmooo@gmail.com" className="text-primary hover:underline">tronmooo@gmail.com</a></p>
        </div>
      </div>
    </div>
  );
}
