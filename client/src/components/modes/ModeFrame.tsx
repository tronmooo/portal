// The full-screen frame of the AI Modes screens (W1): on <body>, the app
// behind it covered and inert, the header (icon, title, X at the upper
// right — W11) outside the scroll, the frame following the visual viewport so
// the keyboard never hides the input.
import { useState, type ReactNode } from "react";
import {
  UnsavedLeaveBar, WorkspaceCloseButton, type WorkspaceCloseResult, WorkspaceKeyboardProvider, WorkspacePortal, leaveWorkspace, useFullScreenWorkspace, useVisualViewportBox, viewportBoxStyle,
} from "@/components/workspace/WorkspaceShell";

export function ModeFrame({ icon, title, sub, actions, tabs, children, testId, onClose = leaveWorkspace }: {
  icon: ReactNode; title: ReactNode; sub?: ReactNode; actions?: ReactNode; tabs?: ReactNode; children: ReactNode; testId: string;
  /** The X: save what is pending, then leave. Answering false keeps the screen open with a warning (W2). */
  onClose?: () => WorkspaceCloseResult | Promise<WorkspaceCloseResult>;
}) {
  useFullScreenWorkspace();
  const [warn, setWarn] = useState(false);
  const box = useVisualViewportBox();
  return (
    <WorkspacePortal>
      <WorkspaceKeyboardProvider value={box.keyboardOpen}>
        <section className="workspace-surface fixed inset-0 z-40 flex flex-col bg-background overflow-hidden" style={viewportBoxStyle(box)} data-testid={testId}
          data-keyboard={box.keyboardOpen ? "1" : undefined}>
          <header className="flex items-center gap-2 px-2 border-b border-border bg-card shrink-0 min-w-0" style={{ minHeight: 52, paddingTop: "env(safe-area-inset-top, 0px)" }} data-testid="workspace-header">
            {icon}
            <div className="flex-1 min-w-0 leading-tight">
              <div className="text-sm font-bold truncate">{title}</div>
              {sub && <div className="text-[11px] text-muted-foreground truncate">{sub}</div>}
            </div>
            {actions}
            <WorkspaceCloseButton onClose={onClose} onSaveFailed={() => setWarn(true)} />
          </header>
          {warn && <UnsavedLeaveBar onStay={() => setWarn(false)} onLeave={() => { setWarn(false); leaveWorkspace(); }} />}
          {tabs}
          <div className="flex-1 min-h-0 min-w-0 flex flex-col">{children}</div>
        </section>
      </WorkspaceKeyboardProvider>
    </WorkspacePortal>
  );
}
