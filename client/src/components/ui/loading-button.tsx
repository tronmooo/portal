import { Button, type ButtonProps } from "./button";
import { Loader2 } from "lucide-react";

interface LoadingButtonProps extends ButtonProps {
  loading?: boolean;
}

export function LoadingButton({ loading, disabled, children, ...props }: LoadingButtonProps) {
  return (
    <Button disabled={disabled || loading} {...props}>
      {loading && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
      {children}
    </Button>
  );
}
