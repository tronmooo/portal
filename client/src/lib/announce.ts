/** Announce a message to screen readers via ARIA live region */
export function announce(message: string) {
  const el = document.getElementById("sr-announcements");
  if (el) {
    el.textContent = "";
    requestAnimationFrame(() => { el.textContent = message; });
  }
}
