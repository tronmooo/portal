// Pre-paint theme bootstrap — eliminates the light->dark flash (FOUC) that
// happens when the theme class is only applied after React mounts.
//
// MUST be loaded from <head> in client/index.html, BEFORE the app bundle:
//   <script src="/theme-init.js"></script>
// (External file on purpose: index.html's CSP forbids inline scripts.)
//
// Keep the localStorage keys and the resolution logic in sync with
// client/src/components/theme-provider.tsx (STORAGE_MODE / STORAGE_PRIMARY /
// STORAGE_ACCENT). The provider re-applies the same values on mount, so this
// script only affects the first paint.
(function () {
  try {
    var root = document.documentElement;
    var mode = localStorage.getItem("portol.theme.mode"); // "light" | "dark" | "system" | null
    var dark =
      mode === "dark" ||
      (mode !== "light" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.toggle("dark", dark);
    root.setAttribute("data-theme", dark ? "dark" : "light");
    root.style.colorScheme = dark ? "dark" : "light";

    // Custom palette (HSL strings like "186 100% 42%") — also applied
    // pre-paint so accent-colored chrome doesn't flash the default teal.
    var primary = localStorage.getItem("portol.theme.primary");
    var accent = localStorage.getItem("portol.theme.accent");
    if (primary) {
      root.style.setProperty("--primary", primary);
      root.style.setProperty("--ring", primary);
    }
    if (accent) root.style.setProperty("--accent", accent);
  } catch (e) {
    /* localStorage/matchMedia unavailable — fall back to default theme */
  }
})();
