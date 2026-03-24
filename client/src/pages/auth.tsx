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

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Logo / Brand */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 mb-2">
            <Shield className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Portol</h1>
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

            {/* Google Sign-In Button — shown on both tabs */}
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
                    <span className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">Or continue with email</span>
                  </div>
                </div>
              </>
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
