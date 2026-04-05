import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center py-8 text-center"
      role="status"
      data-testid="empty-state"
    >
      <Icon className="h-8 w-8 text-muted-foreground/50 mb-2" />
      <p className="text-sm font-medium text-muted-foreground" data-testid="empty-state-title">
        {title}
      </p>
      <p className="text-xs text-muted-foreground/70 mt-1" data-testid="empty-state-description">
        {description}
      </p>
    </div>
  );
}
