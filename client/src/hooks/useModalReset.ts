import { useEffect, useCallback, useRef } from "react";

/**
 * Hook that resets form state whenever a modal/dialog closes.
 * Pass the open state and a reset callback — the callback fires when open transitions to false.
 *
 * Usage:
 *   const [open, setOpen] = useState(false);
 *   useModalReset(open, () => {
 *     setFormData({ name: "", amount: "" });
 *     setErrors({});
 *   });
 */
export function useModalReset(open: boolean, resetFn: () => void) {
  const prevOpen = useRef(open);

  useEffect(() => {
    // Fire reset when transitioning from open -> closed
    if (prevOpen.current && !open) {
      resetFn();
    }
    prevOpen.current = open;
  }, [open, resetFn]);
}

/**
 * Creates a stable onOpenChange handler that resets state on close.
 * Returns [onOpenChange, setOpen] where onOpenChange can be passed directly to Dialog.
 *
 * Usage:
 *   const [open, setOpen] = useState(false);
 *   const handleOpenChange = useDialogReset(setOpen, () => {
 *     setEditItem(null);
 *     setFormData({});
 *   });
 *   <Dialog open={open} onOpenChange={handleOpenChange}>
 */
export function useDialogReset(
  setOpen: (open: boolean) => void,
  resetFn: () => void
) {
  return useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        resetFn();
      }
    },
    [setOpen, resetFn]
  );
}
