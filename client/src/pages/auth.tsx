import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertCircle, Loader2, Shield, CheckCircle2,
  MessageSquare, LayoutDashboard, Users, FileText,
  Activity, Calendar, ChevronRight, Sparkles,
  DollarSign, Heart, Car, PawPrint, ChevronDown,
} from "lucide-react";

// ── Feature data ────────────────────────────────────────────
const FEATURES = [
  {
    icon: MessageSquare,
    title: "Chat & Create",
    desc: "Just say it. Portol creates profiles, logs expenses, tracks habits — all from natural language.",
    color: "text-blue-400",
    bg: "bg-blue-500/10",
    examples: ['"I spent $45 on groceries"', '"Create a profile for Mom"'],
  },
  {
    icon: LayoutDashboard,
    title: "Dashboard",
    desc: "See your whole life at a glance — spending, health, habits, tasks, net worth.",
    color: "text-emerald-400",
    bg: "bg-emerald-500/10",
    examples: ["Real-time KPIs", "Drill into any number"],
  },
  {
    icon: Users,
    title: "Profiles",
    desc: "Organize by people, pets, vehicles, subscriptions. Each gets its own dashboard.",
    color: "text-purple-400",
    bg: "bg-purple-500/10",
    examples: ["People, pets, cars", "Linked finances & docs"],
  },
  {
    icon: FileText,
    title: "Documents",
    desc: "Upload receipts, IDs, prescriptions. AI extracts data and files them automatically.",
    color: "text-amber-400",
    bg: "bg-amber-500/10",
    examples: ["Photo → extracted data", "Auto-linked to profiles"],
  },
  {
    icon: Activity,
    title: "Trackers",
    desc: "Blood pressure, weight, running, sleep — track anything with automatic charts.",
    color: "text-rose-400",
    bg: "bg-rose-500/10",
    examples: ['"Log BP 125/82"', "Charts & trends"],
  },
  {
    icon: Calendar,
    title: "Calendar",
    desc: "Events, tasks, bill due dates, birthdays — everything synced in one calendar.",
    color: "text-cyan-400",
    bg: "bg-cyan-500/10",
    examples: ["Auto-generated events", "Recurring bills"],
  },
];

const EXAMPLE_COMMANDS = [
  { cmd: '"I spent $12 on lunch at Chipotle"', tag: "Expense" },
  { cmd: '"Track my weight at 175 lbs"', tag: "Tracker" },
  { cmd: '"Create a profile for Mom"', tag: "Profile" },
  { cmd: '"Add my 2022 Tesla Model 3"', tag: "Vehicle" },
  { cmd: '"I pay $15/month for Netflix"', tag: "Subscription" },
  { cmd: '"Schedule dentist for March 20"', tag: "Event" },
  { cmd: '"Rex had a vet visit — $120"', tag: "Expense" },
  { cmd: '"Log blood pressure 125/82"', tag: "Health" },
];

// ── Onboarding Section ──────────────────────────────────────
function OnboardingSection({ onScrollToLogin }: { onScrollToLogin: () => void }) {
  return (
    <div className="space-y-8">
      {/* Divider */}
      <div className="text-center">
        <p className="text-sm font-medium text-foreground">What can Portol do?</p>
        <p className="text-xs text-muted-foreground mt-1">
          Talk naturally. Portol organizes everything.
        </p>
      </div>

      {/* Feature Cards — horizontal scroll */}
      <div>
        <div className="flex items-center gap-2 mb-3 px-1">
          <Sparkles className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">What Portol Does</h2>
        </div>
        <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-2 -mx-1 px-1" style={{ scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}>
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="snap-start shrink-0 w-[240px] rounded-xl border border-border/40 bg-card p-4 space-y-2.5"
            >
              <div className={`inline-flex items-center justify-center w-9 h-9 rounded-lg ${f.bg}`}>
                <f.icon className={`h-4.5 w-4.5 ${f.color}`} />
              </div>
              <h3 className="text-sm font-semibold text-foreground">{f.title}</h3>
              <p className="text-xs text-muted-foreground leading-relaxed">{f.desc}</p>
              <div className="space-y-1">
                {f.examples.map((ex, i) => (
                  <p key={i} className="text-xs-loose text-primary/80 font-mono">{ex}</p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Example Commands */}
      <div>
        <div className="flex items-center gap-2 mb-3 px-1">
          <MessageSquare className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Try Saying</h2>
        </div>
        <div className="grid grid-cols-1 gap-1.5">
          {EXAMPLE_COMMANDS.map((ex, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-border/30 bg-card/50 px-3 py-2">
              <span className="text-xs font-mono text-foreground/90 flex-1">{ex.cmd}</span>
              <span className="text-xs font-medium text-primary/70 bg-primary/10 px-1.5 py-0.5 rounded shrink-0">{ex.tag}</span>
            </div>
          ))}
        </div>
      </div>

      {/* How It Works */}
      <div className="rounded-xl border border-border/40 bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">How It Works</h2>
        {[
          { step: "1", text: "Sign in with Google or email" },
          { step: "2", text: "Start chatting — tell Portol about your life" },
          { step: "3", text: "Everything auto-organizes into dashboards, profiles & trackers" },
        ].map((s) => (
          <div key={s.step} className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
              <span className="text-xs font-bold text-primary">{s.step}</span>
            </div>
            <p className="text-xs text-muted-foreground">{s.text}</p>
          </div>
        ))}
      </div>

      {/* CTA to scroll back to login */}
      <Button
        className="w-full gap-2"
        size="lg"
        onClick={onScrollToLogin}
      >
        Sign In Now <ChevronDown className="h-4 w-4 rotate-180" />
      </Button>
    </div>
  );
}

// ── Main Auth Page ──────────────────────────────────────────
export default function AuthPage() {
  useEffect(() => { document.title = "Portol — AI Life Command Center"; }, []);
  const { signIn, signUp, signInWithGoogle } = useAuth();
  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSent, setForgotSent] = useState(false);
  const loginRef = useRef<HTMLDivElement>(null);

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const result = await signIn(email, password);
    if (result.error) setError(result.error);
    setLoading(false);
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setLoading(true);
    const result = await signUp(email, password);
    if (result.error) setError(result.error);
    setLoading(false);
  }

  async function handleGoogleSignIn() {
    setError("");
    setLoading(true);
    const result = await signInWithGoogle();
    if (result.error) setError(result.error);
    setLoading(false);
  }

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/auth/forgot-password", { email: forgotEmail });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setForgotSent(true);
      }
    } catch {
      setError("Failed to send reset email. Please try again.");
    }
    setLoading(false);
  }

  const scrollToLogin = () => {
    loginRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="min-h-screen bg-background overflow-y-auto" style={{ WebkitOverflowScrolling: "touch" }}>
      <div className="w-full max-w-md mx-auto px-4 py-8 space-y-6">

        {/* Logo / Brand */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 mb-1">
            <Shield className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Portol</h1>
          <p className="text-sm text-muted-foreground">Your AI-powered life command center</p>
        </div>

        {/* Login Card — FIRST */}
        <div ref={loginRef}>
          <Card className="border-border/50">
            <CardHeader className="pb-4">
              <Tabs value={tab} onValueChange={(v) => { setTab(v as any); setError(""); }}>
                <TabsList className="grid w-full grid-cols-2 bg-muted/60">
                  <TabsTrigger value="signin" data-testid="tab-signin" className="data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:font-semibold">Sign In</TabsTrigger>
                  <TabsTrigger value="signup" data-testid="tab-signup" className="data-[state=active]:bg-background data-[state=active]:shadow-sm data-[state=active]:font-semibold">Create Account</TabsTrigger>
                </TabsList>

                <TabsContent value="signin" className="mt-4">
                  <CardTitle className="text-lg">Welcome back</CardTitle>
                  <CardDescription>Sign in to access your data</CardDescription>
                </TabsContent>
                <TabsContent value="signup" className="mt-4">
                  <CardTitle className="text-lg">Get started</CardTitle>
                  <CardDescription>Create your Portol account</CardDescription>
                </TabsContent>
              </Tabs>
            </CardHeader>
            <CardContent>
              {error && (
                <div className="flex items-center gap-2 p-3 mb-4 text-sm text-destructive bg-destructive/10 rounded-lg" data-testid="text-auth-error">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {error}
                </div>
              )}

              {/* Google Sign-In Button */}
              {!forgotMode && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full flex items-center justify-center gap-2"
                    onClick={handleGoogleSignIn}
                    disabled={loading}
                    data-testid="button-google-signin"
                  >
                    <svg viewBox="0 0 24 24" className="w-5 h-5">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                    Continue with Google
                  </Button>

                  <div className="relative my-4">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t border-border/80" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-card px-3 text-xs font-medium text-muted-foreground/80 uppercase tracking-wider">or continue with email</span>
                    </div>
                  </div>
                </>
              )}

              {tab === "signin" && !forgotMode ? (
                <form onSubmit={handleSignIn} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="signin-email">Email</Label>
                    <Input id="signin-email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="input-signin-email" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signin-password">Password</Label>
                    <Input id="signin-password" type="password" placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} required data-testid="input-signin-password" />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading} data-testid="button-signin">
                    {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                    Sign In
                  </Button>
                  <button type="button" className="w-full text-xs text-muted-foreground/90 hover:text-primary transition-colors underline-offset-4 hover:underline" onClick={() => { setForgotMode(true); setError(""); setForgotEmail(email); setForgotSent(false); }} data-testid="link-forgot-password">
                    Forgot password?
                  </button>
                </form>
              ) : tab === "signin" && forgotMode ? (
                forgotSent ? (
                  <div className="text-center py-4 space-y-3">
                    <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto" />
                    <p className="text-sm font-medium">Check your email</p>
                    <p className="text-xs text-muted-foreground">We sent a password reset link to <span className="font-medium">{forgotEmail}</span></p>
                    <button type="button" className="text-xs text-primary hover:underline" onClick={() => { setForgotMode(false); setForgotSent(false); }} data-testid="link-back-to-signin">Back to sign in</button>
                  </div>
                ) : (
                  <form onSubmit={handleForgotPassword} className="space-y-4">
                    <p className="text-xs text-muted-foreground">Enter your email and we'll send you a link to reset your password.</p>
                    <div className="space-y-2">
                      <Label htmlFor="forgot-email">Email</Label>
                      <Input id="forgot-email" type="email" placeholder="you@example.com" value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} required autoFocus data-testid="input-forgot-email" />
                    </div>
                    <Button type="submit" className="w-full" disabled={loading || !forgotEmail} data-testid="button-forgot-submit">
                      {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                      Send Reset Link
                    </Button>
                    <button type="button" className="w-full text-xs text-muted-foreground hover:text-primary transition-colors" onClick={() => { setForgotMode(false); setError(""); }} data-testid="link-back-to-signin-2">Back to sign in</button>
                  </form>
                )
              ) : (
                <form onSubmit={handleSignUp} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="signup-email">Email</Label>
                    <Input id="signup-email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="input-signup-email" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signup-password">Password</Label>
                    <Input id="signup-password" type="password" placeholder="At least 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} data-testid="input-signup-password" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signup-confirm">Confirm Password</Label>
                    <Input id="signup-confirm" type="password" placeholder="Re-enter your password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required data-testid="input-signup-confirm" />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading} data-testid="button-signup">
                    {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                    Create Account
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </div>

        <p className="text-xs text-center text-muted-foreground">
          Your data is secured with row-level security. Only you can access your information.
        </p>

        {/* Onboarding Tutorial — BELOW login */}
        <OnboardingSection onScrollToLogin={scrollToLogin} />
      </div>
    </div>
  );
}
