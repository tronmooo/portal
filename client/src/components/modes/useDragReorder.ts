// Drag to reorder a vertical list by a handle — finger or mouse.
//
// The handle owns its drag (T1): it carries data-swipe-ignore and
// `touch-action: none`, so dragging it never turns into the shell's sideways
// "next tab" swipe or a page scroll. While dragging, the list shows the new
// order; `onCommit` runs ONCE on release, and only when the order changed.
//
// The move and release are followed on the WINDOW, not by pointer capture on
// the handle: the handle's own row moves in the DOM as the list reorders, and
// a moved element loses its capture (seen in a real browser: the drag stopped
// after one step).
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export function useDragReorder(ids: string[], onCommit: (ids: string[]) => void) {
  const [live, setLive] = useState<string[] | null>(null);
  const liveRef = useRef<string[] | null>(null);
  const dragging = useRef<string | null>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const detach = useRef<(() => void) | null>(null);
  useEffect(() => () => detach.current?.(), []);

  const set = (next: string[] | null) => { liveRef.current = next; setLive(next); };

  const move = (clientY: number) => {
    const id0 = dragging.current;
    const cur = liveRef.current;
    if (!id0 || !cur) return;
    // Where it lands: after every OTHER item whose middle is above the pointer.
    const others = cur.filter((k) => k !== id0);
    let to = 0;
    for (const k of others) {
      const r = els.current.get(k)?.getBoundingClientRect();
      if (r && clientY > r.top + r.height / 2) to++;
    }
    if (cur.indexOf(id0) === to) return;
    const next = others.slice();
    next.splice(to, 0, id0);
    set(next);
  };
  const end = () => {
    detach.current?.();
    detach.current = null;
    const final = liveRef.current;
    dragging.current = null;
    set(null);
    if (final && final.join("\u0000") !== idsRef.current.join("\u0000")) commitRef.current(final);
  };

  const itemRef = useCallback((id: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(id, el); else els.current.delete(id);
  }, []);

  const handleProps = (id: string) => ({
    "data-swipe-ignore": true,
    "aria-label": "Drag to reorder",
    style: { touchAction: "none" as const, cursor: "grab" },
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      e.preventDefault();
      detach.current?.();
      dragging.current = id;
      set(idsRef.current.slice());
      const onMove = (ev: PointerEvent) => { ev.preventDefault(); move(ev.clientY); };
      const onUp = () => end();
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      detach.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
    },
  });

  return { order: live ?? ids, dragging: live ? dragging.current : null, itemRef, handleProps };
}
