import { createContext, useContext, useEffect, useState, useCallback } from "react";

type Mode = "light" | "dark" | "system";

// Each preset stores HSL values for --primary and --accent (matches tailwind.config.ts).
// These map directly to the CSS variables used throughout the app.
export const COLOR_PRESETS: Array<{
  id: string;
  label: string;
  // tailwind/shadcn HSL strings (no `hsl()` wrapper) — e.g. "186 100% 42%"
  primary: string;
  accent: string;
  hue: number; // approx hue for the slider sync
}> = [
  { id: "cyan",    label: "Cyan",    primary: "186 100% 42%", accent: "186 100% 50%", hue: 186 },
  { id: "blue",    label: "Blue",    primary: "217  91% 60%", accent: "217 91% 70%",  hue: 217 },
  { id: "violet",  label: "Violet",  primary: "262  83% 65%", accent: "262 83% 75%",  hue: 262 },
  { id: "emerald", label: "Emerald", primary: "152  76% 42%", accent: "152 76% 52%",  hue: 152 },
  { id: "rose",    label: "Rose",    primary: "346  77% 58%", accent: "346 77% 68%",  hue: 346 },
  { id: "amber",   label: "Amber",   primary: " 38  92% 52%", accent: " 38 92% 62%",  hue:  38 },
  { id: "slate",   label: "Slate",   primary: "215  20% 55%", accent: "215 20% 65%",  hue: 215 },
];

const STORAGE_MODE   = "portol.theme.mode";
const STORAGE_PRIMARY = "portol.theme.primary"; // HSL string
const STORAGE_ACCENT  = "portol.theme.accent";

type Ctx = {
  // Light/dark/system
  mode: Mode;
  resolvedMode: "light" | "dark";
  setMode: (m: Mode) => void;
  toggle: () => void;
  // Color theming
  primary: string;     // HSL string, e.g. "186 100% 42%"
  accent: string;
  setPalette: (primary: string, accent: string) => void;
  setPreset: (id: string) => void;
  setHue: (hue: number) => void;
};

const ThemeContext = createContext<Ctx>({
  mode: "system",
  resolvedMode: "dark",
  setMode: () => {},
  toggle: () => {},
  primary: COLOR_PRESETS[0].primary,
  accent: COLOR_PRESETS[0].accent,
  setPalette: () => {},
  setPreset: () => {},
  setHue: () => {},
});

function getSystemMode(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<Mode>(() => {
    return (localStorage.getItem(STORAGE_MODE) as Mode) || "system";
  });
  const [resolvedMode, setResolvedMode] = useState<"light" | "dark">(() =>
    (localStorage.getItem(STORAGE_MODE) as Mode) === "light" ? "light"
    : (localStorage.getItem(STORAGE_MODE) as Mode) === "dark"  ? "dark"
    : getSystemMode()
  );
  const [primary, setPrimary] = useState<string>(() =>
    localStorage.getItem(STORAGE_PRIMARY) || COLOR_PRESETS[0].primary
  );
  const [accent, setAccent] = useState<string>(() =>
    localStorage.getItem(STORAGE_ACCENT) || COLOR_PRESETS[0].accent
  );

  // Apply mode to <html>
  useEffect(() => {
    const apply = () => {
      const m: "light" | "dark" = mode === "system" ? getSystemMode() : mode;
      document.documentElement.classList.toggle("dark", m === "dark");
      setResolvedMode(m);
    };
    apply();
    localStorage.setItem(STORAGE_MODE, mode);
    if (mode !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => apply();
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [mode]);

  // Apply primary/accent CSS variables to :root
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--primary", primary);
    root.style.setProperty("--accent", accent);
    // Also set ring (shadcn pattern) so focus rings match the theme
    root.style.setProperty("--ring", primary);
    localStorage.setItem(STORAGE_PRIMARY, primary);
    localStorage.setItem(STORAGE_ACCENT, accent);
  }, [primary, accent]);

  const setMode = useCallback((m: Mode) => setModeState(m), []);
  const toggle = useCallback(() => {
    setModeState((m) => {
      const current: "light" | "dark" =
        m === "system" ? getSystemMode() : m;
      return current === "dark" ? "light" : "dark";
    });
  }, []);

  const setPalette = useCallback((p: string, a: string) => {
    setPrimary(p);
    setAccent(a);
  }, []);

  const setPreset = useCallback((id: string) => {
    const preset = COLOR_PRESETS.find((p) => p.id === id) || COLOR_PRESETS[0];
    setPrimary(preset.primary);
    setAccent(preset.accent);
  }, []);

  const setHue = useCallback((hue: number) => {
    const h = Math.max(0, Math.min(360, Math.round(hue)));
    // Use saturation/lightness similar to the cyan default
    setPrimary(`${h} 85% 50%`);
    setAccent(`${h} 85% 60%`);
  }, []);

  return (
    <ThemeContext.Provider value={{ mode, resolvedMode, setMode, toggle, primary, accent, setPalette, setPreset, setHue }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
