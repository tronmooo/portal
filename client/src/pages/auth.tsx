import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertCircle, Loader2, Shield, CheckCircle2 } from "lucide-react";

export default function AuthPage() {
  const { signIn, signUp } = useAuth();
  const [tab, setTab] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSent, setForgotSent] = useState(false);

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
    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }
    setLoading(true);
    const result = await signUp(email, password);
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Logo / Brand */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 mb-2">
            <Shield className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">LifeOS</h1>
          <p className="text-sm text-muted-foreground">Your personal life management system</p>
        </div>

        <Card className="border-border/50">
          <CardHeader className="pb-4">
            <Tabs value={tab} onValueChange={(v) => { setTab(v as any); setError(""); }}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="signin" data-testid="tab-signin">Sign In</TabsTrigger>
                <TabsTrigger value="signup" data-testid="tab-signup">Create Account</TabsTrigger>
              </TabsList>

              <TabsContent value="signin" className="mt-4">
                <CardTitle className="text-lg">Welcome back</CardTitle>
                <CardDescription>Sign in to access your data</CardDescription>
              </TabsContent>
              <TabsContent value="signup" className="mt-4">
                <CardTitle className="text-lg">Get started</CardTitle>
                <CardDescription>Create your LifeOS account</CardDescription>
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

            {tab === "signin" && !forgotMode ? (
              <form onSubmit={handleSignIn} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="signin-email">Email</Label>
                  <Input
                    id="signin-email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    data-testid="input-signin-email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signin-password">Password</Label>
                  <Input
                    id="signin-password"
                    type="password"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    data-testid="input-signin-password"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading} data-testid="button-signin">
                  {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Sign In
                </Button>
                <button
                  type="button"
                  className="w-full text-xs text-muted-foreground hover:text-primary transition-colors"
                  onClick={() => { setForgotMode(true); setError(""); setForgotEmail(email); setForgotSent(false); }}
                  data-testid="link-forgot-password"
                >
                  Forgot password?
                </button>
              </form>
            ) : tab === "signin" && forgotMode ? (
              forgotSent ? (
                <div className="text-center py-4 space-y-3">
                  <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto" />
                  <p className="text-sm font-medium">Check your email</p>
                  <p className="text-xs text-muted-foreground">We sent a password reset link to <span className="font-medium">{forgotEmail}</span></p>
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => { setForgotMode(false); setForgotSent(false); }}
                    data-testid="link-back-to-signin"
                  >
                    Back to sign in
                  </button>
                </div>
              ) : (
                <form onSubmit={handleForgotPassword} className="space-y-4">
                  <p className="text-xs text-muted-foreground">Enter your email and we'll send you a link to reset your password.</p>
                  <div className="space-y-2">
                    <Label htmlFor="forgot-email">Email</Label>
                    <Input
                      id="forgot-email"
                      type="email"
                      placeholder="you@example.com"
                      value={forgotEmail}
                      onChange={(e) => setForgotEmail(e.target.value)}
                      required
                      autoFocus
                      data-testid="input-forgot-email"
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={loading || !forgotEmail} data-testid="button-forgot-submit">
                    {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                    Send Reset Link
                  </Button>
                  <button
                    type="button"
                    className="w-full text-xs text-muted-foreground hover:text-primary transition-colors"
                    onClick={() => { setForgotMode(false); setError(""); }}
                    data-testid="link-back-to-signin-2"
                  >
                    Back to sign in
                  </button>
                </form>
              )
            ) : (
              <form onSubmit={handleSignUp} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="signup-email">Email</Label>
                  <Input
                    id="signup-email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    data-testid="input-signup-email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-password">Password</Label>
                  <Input
                    id="signup-password"
                    type="password"
                    placeholder="At least 6 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    data-testid="input-signup-password"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-confirm">Confirm Password</Label>
                  <Input
                    id="signup-confirm"
                    type="password"
                    placeholder="Re-enter your password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    data-testid="input-signup-confirm"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading} data-testid="button-signup">
                  {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                  Create Account
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <p className="text-xs text-center text-muted-foreground">
          Your data is secured with row-level security. Only you can access your information.
        </p>
      </div>
    </div>
  );
}
