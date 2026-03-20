import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AnimatePresence, motion } from "framer-motion";
import {
  MessageSquare,
  Users,
  BarChart3,
  LayoutDashboard,
  Upload,
  Brain,
  Target,
  Sparkles,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface OnboardingStatus {
  completed: boolean;
  hasProfiles: boolean;
  hasTrackers: boolean;
  hasTasks: boolean;
  profileCount: number;
  trackerCount: number;
  taskCount: number;
}

const TOTAL_STEPS = 3;

const slideVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? 80 : -80,
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
  },
  exit: (direction: number) => ({
    x: direction > 0 ? -80 : 80,
    opacity: 0,
  }),
};

const slideTransition = {
  x: { type: "spring", stiffness: 300, damping: 30 },
  opacity: { duration: 0.2 },
};

function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2 justify-center" data-testid="onboarding-progress">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`h-2 rounded-full transition-all duration-300 ${
            i === current
              ? "w-6 bg-primary"
              : i < current
                ? "w-2 bg-primary/50"
                : "w-2 bg-muted-foreground/25"
          }`}
        />
      ))}
    </div>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  const features = [
    {
      icon: MessageSquare,
      title: "AI Chat",
      desc: "Talk to your AI assistant to manage everything",
    },
    {
      icon: Users,
      title: "Profiles",
      desc: "Track people, pets, vehicles, properties",
    },
    {
      icon: BarChart3,
      title: "Trackers",
      desc: "Monitor health, fitness, finances & more",
    },
    {
      icon: LayoutDashboard,
      title: "Dashboard",
      desc: "See your entire life at a glance",
    },
  ];

  return (
    <div className="flex flex-col items-center text-center" data-testid="onboarding-step-welcome">
      <div className="mb-2">
        <Sparkles className="h-10 w-10 text-primary mx-auto" />
      </div>
      <h2 className="text-xl font-bold text-foreground" data-testid="text-welcome-title">
        Welcome to LifeOS
      </h2>
      <p className="text-sm text-muted-foreground mt-1" data-testid="text-welcome-subtitle">
        Your AI-powered personal life management system
      </p>
      <p className="text-sm text-muted-foreground mt-3 max-w-md leading-relaxed">
        LifeOS helps you track everything in your life — health, finances, tasks,
        habits, relationships, and more. Let&apos;s get you set up.
      </p>

      <div className="grid grid-cols-2 gap-3 mt-6 w-full">
        {features.map((f) => (
          <div
            key={f.title}
            className="flex flex-col items-center gap-2 p-4 rounded-lg border border-border bg-muted/40 dark:bg-muted/20"
            data-testid={`card-feature-${f.title.toLowerCase().replace(/\s/g, "-")}`}
          >
            <f.icon className="h-5 w-5 text-primary" />
            <span className="text-sm font-medium text-foreground">{f.title}</span>
            <span className="text-xs text-muted-foreground leading-snug">{f.desc}</span>
          </div>
        ))}
      </div>

      <Button
        className="mt-6 w-full"
        onClick={onNext}
        data-testid="button-get-started"
      >
        Let&apos;s Get Started
      </Button>
    </div>
  );
}

function ProfileStep({
  onNext,
  onSkip,
}: {
  onNext: () => void;
  onSkip: () => void;
}) {
  const [name, setName] = useState("");
  const [profileType, setProfileType] = useState("person");
  const [notes, setNotes] = useState("");

  const createProfile = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/profiles", {
        name,
        type: profileType,
        notes: notes || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profiles"] });
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding-status"] });
      onNext();
    },
  });

  return (
    <div className="flex flex-col" data-testid="onboarding-step-profile">
      <div className="text-center mb-5">
        <Users className="h-10 w-10 text-primary mx-auto mb-2" />
        <h2 className="text-xl font-bold text-foreground" data-testid="text-profile-title">
          About You
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Create your first profile to get started
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="onboarding-name">Name</Label>
          <Input
            id="onboarding-name"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="input-profile-name"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="onboarding-type">Profile Type</Label>
          <Select value={profileType} onValueChange={setProfileType}>
            <SelectTrigger id="onboarding-type" data-testid="select-profile-type">
              <SelectValue placeholder="Select a type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="person">Person</SelectItem>
              <SelectItem value="pet">Pet</SelectItem>
              <SelectItem value="vehicle">Vehicle</SelectItem>
              <SelectItem value="property">Property</SelectItem>
              <SelectItem value="asset">Asset</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="onboarding-notes">Notes (optional)</Label>
          <Textarea
            id="onboarding-notes"
            placeholder="Any details you'd like to add..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            data-testid="input-profile-notes"
          />
        </div>
      </div>

      <Button
        className="mt-6 w-full"
        onClick={() => createProfile.mutate()}
        disabled={!name.trim() || createProfile.isPending}
        data-testid="button-create-profile"
      >
        {createProfile.isPending ? "Creating..." : "Create Profile"}
      </Button>

      {createProfile.isError && (
        <p className="text-sm text-destructive mt-2 text-center" data-testid="text-profile-error">
          Failed to create profile. Please try again.
        </p>
      )}

      <button
        type="button"
        className="mt-3 text-sm text-muted-foreground hover:text-foreground transition-colors mx-auto"
        onClick={onSkip}
        data-testid="button-skip-profile"
      >
        Skip for now
      </button>
    </div>
  );
}

function TipsStep({ onFinish }: { onFinish: () => void }) {
  const tips = [
    {
      icon: Upload,
      text: "Upload documents in Chat — AI extracts data automatically",
    },
    {
      icon: LayoutDashboard,
      text: "Use the Dashboard to see everything at a glance",
    },
    {
      icon: Target,
      text: "Create trackers for health, fitness, or anything you want to measure",
    },
    {
      icon: Brain,
      text: "Ask the AI anything — it can create profiles, tasks, expenses, and more",
    },
  ];

  const completeMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/onboarding/complete");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding-status"] });
      onFinish();
    },
  });

  return (
    <div className="flex flex-col items-center text-center" data-testid="onboarding-step-tips">
      <Sparkles className="h-10 w-10 text-primary mb-2" />
      <h2 className="text-xl font-bold text-foreground" data-testid="text-tips-title">
        You&apos;re All Set!
      </h2>
      <p className="text-sm text-muted-foreground mt-1 mb-5">
        Here are some tips to get the most out of LifeOS
      </p>

      <div className="space-y-3 w-full text-left">
        {tips.map((tip, i) => (
          <div
            key={i}
            className="flex items-start gap-3 p-3 rounded-lg border border-border bg-muted/40 dark:bg-muted/20"
            data-testid={`card-tip-${i}`}
          >
            <tip.icon className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <span className="text-sm text-foreground leading-snug">{tip.text}</span>
          </div>
        ))}
      </div>

      <Button
        className="mt-6 w-full"
        onClick={() => completeMutation.mutate()}
        disabled={completeMutation.isPending}
        data-testid="button-go-to-dashboard"
      >
        {completeMutation.isPending ? "Finishing..." : "Go to Dashboard"}
      </Button>
    </div>
  );
}

export function OnboardingWizard() {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [, setLocation] = useLocation();

  const { data: status, isLoading } = useQuery<OnboardingStatus>({
    queryKey: ["/api/onboarding-status"],
    staleTime: 60000,
  });

  // Don't show if loading, errored, or already completed
  if (isLoading || !status || status.completed) {
    return null;
  }

  const goNext = () => {
    setDirection(1);
    setStep((s) => Math.min(s + 1, TOTAL_STEPS - 1));
  };

  const handleFinish = () => {
    setLocation("/dashboard");
  };

  return (
    <Dialog open modal>
      <DialogContent
        className="sm:max-w-lg max-h-[90vh] overflow-y-auto"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        // Hide the default close button by intercepting it
        onInteractOutside={(e) => e.preventDefault()}
        data-testid="dialog-onboarding"
      >
        {/* Accessible title & description for screen readers */}
        <DialogTitle className="sr-only">Onboarding Wizard</DialogTitle>
        <DialogDescription className="sr-only">
          Set up your LifeOS account step by step
        </DialogDescription>

        <div className="pt-1">
          <ProgressDots current={step} total={TOTAL_STEPS} />
        </div>

        <div className="relative min-h-[360px] flex items-start">
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={step}
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={slideTransition}
              className="w-full"
            >
              {step === 0 && <WelcomeStep onNext={goNext} />}
              {step === 1 && <ProfileStep onNext={goNext} onSkip={goNext} />}
              {step === 2 && <TipsStep onFinish={handleFinish} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </DialogContent>
    </Dialog>
  );
}
