import type { MouseEvent } from "react";

/**
 * Wraps an onClick handler so the event doesn't bubble up to parent clickable elements.
 * Use on EVERY button/link inside a clickable card/row.
 *
 * Usage: <Button onClick={stopProp(() => handleDelete(id))} />
 */
export function stopProp<E extends MouseEvent>(handler?: (e: E) => void) {
  return (e: E) => {
    e.stopPropagation();
    handler?.(e);
  };
}

/**
 * Same as stopProp but also calls preventDefault (useful for links inside clickable containers).
 */
export function stopPropAndDefault<E extends MouseEvent>(handler?: (e: E) => void) {
  return (e: E) => {
    e.stopPropagation();
    e.preventDefault();
    handler?.(e);
  };
}
