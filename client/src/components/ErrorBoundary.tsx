import { Component, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

// ─── Error Fallback Card ─────────────────────────────────────────────────────

function ErrorFallbackCard({ name, onReset }: { name: string; onReset?: () => void }) {
  return (
    <div
      data-testid={`error-fallback-${name}`}
      className="flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3"
    >
      <AlertTriangle className="h-4 w-4 text-destructive/70 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-destructive/80" data-testid={`error-message-${name}`}>
          Something went wrong in {name}
        </p>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          This section encountered an error.
        </p>
      </div>
      {onReset && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1 text-destructive/70 hover:text-destructive shrink-0"
          onClick={onReset}
          data-testid={`btn-retry-${name}`}
        >
          <RotateCcw className="h-3 w-3" />
          Retry
        </Button>
      )}
    </div>
  );
}

// ─── Error Boundary (class component — React requirement) ────────────────────

interface ErrorBoundaryProps {
  children: ReactNode;
  sectionName: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundaryInner extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error(
      `[ErrorBoundary] ${this.props.sectionName} crashed:`,
      error,
      errorInfo
    );
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined });
  };

  render() {
    if (this.state.hasError) {
      return (
        <ErrorFallbackCard
          name={this.props.sectionName}
          onReset={this.handleReset}
        />
      );
    }
    return this.props.children;
  }
}

// ─── Convenience wrapper ─────────────────────────────────────────────────────

export function SectionErrorBoundary({
  children,
  name,
}: {
  children: ReactNode;
  name: string;
}) {
  return (
    <ErrorBoundaryInner sectionName={name}>
      {children}
    </ErrorBoundaryInner>
  );
}

export { ErrorBoundaryInner, ErrorFallbackCard };
