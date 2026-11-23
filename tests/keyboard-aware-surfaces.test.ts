// Keyboard-aware surfaces (owner, 2026-11-23: "there's no save button … I
// need to be able to see it. There's just stuff like that throughout my
// entire app."). On a phone the on-screen keyboard shrinks what is VISIBLE
// but not the layout viewport, so every `position: fixed` surface kept its
// full height: footers and Save buttons sat under the keyboard and headers
// were pushed off the top. One module publishes the visible area
// (client/src/lib/visual-viewport.ts) and one block of CSS keeps every
// dialog, sheet and workspace inside it.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { installVisualViewportVars, viewportVars, KEYBOARD_MIN_PX } from "../client/src/lib/visual-viewport";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const css = read("client/src/index.css");
/** The body of the one rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`index.css has no rule "${selector}"`);
  return css.slice(at + selector.length + 2, css.indexOf("}", at));
}

describe("what the phone shows (the pure rule)", () => {
  it("no keyboard: the whole window, nothing covered", () => {
    expect(viewportVars({ height: 667, width: 375, offsetTop: 0 }, 667, 667)).toEqual({ vvh: 667, top: 0, kb: 0, keyboard: false });
  });
  it("iOS keyboard up: the visible height shrinks, the layout height does not", () => {
    expect(viewportVars({ height: 380, width: 375, offsetTop: 0 }, 667, 667)).toEqual({ vvh: 380, top: 0, kb: 287, keyboard: true });
  });
  it("…and when the browser pans to the caret, the visible area starts lower", () => {
    expect(viewportVars({ height: 380, width: 375, offsetTop: 120 }, 667, 667)).toEqual({ vvh: 380, top: 120, kb: 167, keyboard: true });
  });
  it("a browser toolbar sliding in is not a keyboard", () => {
    expect(viewportVars({ height: 667 - (KEYBOARD_MIN_PX - 40), width: 375, offsetTop: 0 }, 667, 667).keyboard).toBe(false);
  });
});

describe("publishing it to CSS", () => {
  function fakeWindow() {
    const listeners: Record<string, (() => void)[]> = {};
    const style = new Map<string, string>();
    const attrs = new Map<string, string>();
    const vv = {
      height: 667, width: 375, offsetTop: 0,
      addEventListener: (t: string, f: () => void) => { (listeners[t] ||= []).push(f); },
      removeEventListener: (t: string, f: () => void) => { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
    };
    const win: any = {
      visualViewport: vv, innerHeight: 667,
      document: { documentElement: {
        clientHeight: 667,
        style: { setProperty: (k: string, v: string) => { style.set(k, v); } },
        setAttribute: (k: string, v: string) => { attrs.set(k, v); },
        removeAttribute: (k: string) => { attrs.delete(k); },
      } },
    };
    return { win, vv, style, attrs, fire: (t: string) => (listeners[t] || []).forEach((f) => f()), listeners };
  }

  it("writes the variables at once and follows the keyboard up and down", () => {
    const w = fakeWindow();
    const stop = installVisualViewportVars(w.win);
    expect(w.style.get("--vvh")).toBe("667px");
    expect(w.attrs.has("data-keyboard")).toBe(false);
    w.vv.height = 380; w.fire("resize");
    expect([w.style.get("--vvh"), w.style.get("--kb"), w.attrs.get("data-keyboard")]).toEqual(["380px", "287px", "open"]);
    w.vv.offsetTop = 100; w.fire("scroll");
    expect(w.style.get("--vv-top")).toBe("100px");
    w.vv.height = 667; w.vv.offsetTop = 0; w.fire("resize");
    expect(w.attrs.has("data-keyboard")).toBe(false);
    stop();
    expect(w.listeners.resize).toEqual([]);
  });

  it("a rotation is a new window, not a keyboard", () => {
    const w = fakeWindow();
    installVisualViewportVars(w.win);
    w.vv.width = 667; w.vv.height = 375; w.win.document.documentElement.clientHeight = 375; w.fire("resize");
    expect(w.attrs.has("data-keyboard")).toBe(false);
  });

  it("a browser with no visual viewport is left alone", () => {
    expect(() => installVisualViewportVars({ document: { documentElement: {} } } as any)()).not.toThrow();
  });
});

describe("every fixed surface uses it", () => {
  it("the app installs the publisher once, at start", () => {
    expect(read("client/src/main.tsx")).toMatch(/installVisualViewportVars\(\);/);
  });

  it("a full-screen workspace is exactly as tall as what shows", () => {
    const r = rule("html[data-keyboard] .workspace-surface");
    expect(r).toMatch(/top:\s*var\(--vv-top/);
    expect(r).toMatch(/height:\s*var\(--vvh/);
    expect(r).toMatch(/bottom:\s*auto/);
  });

  it("a dialog is centred in what shows and no taller than it", () => {
    const r = rule('html[data-keyboard] [data-surface="dialog"]');
    expect(r).toMatch(/top:\s*calc\(var\(--vv-top[^;]*var\(--vvh/);
    expect(r).toMatch(/max-height:\s*calc\(var\(--vvh/);
  });

  it("a bottom sheet sits on the keyboard; a side sheet spans what shows", () => {
    expect(rule('html[data-keyboard] [data-surface="sheet-bottom"]')).toMatch(/bottom:\s*var\(--kb/);
    expect(rule('html[data-keyboard] [data-surface="sheet-side"]')).toMatch(/height:\s*var\(--vvh/);
  });

  it("the shared dialog, alert, sheet and drawer components carry the marker", () => {
    expect(read("client/src/components/ui/dialog.tsx")).toContain('data-surface="dialog"');
    expect(read("client/src/components/ui/alert-dialog.tsx")).toContain('data-surface="dialog"');
    expect(read("client/src/components/ui/sheet.tsx")).toMatch(/data-surface=\{side === "bottom" \? "sheet-bottom"/);
    expect(read("client/src/components/ui/drawer.tsx")).toContain('data-surface="sheet-bottom"');
  });

  it("no dialog repositions itself past the shared rule", () => {
    // The rule assumes the shared centred position. A DialogContent that sets
    // its own top/bottom would be moved by it: give it its own data-surface.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith(".tsx")) continue;
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/<DialogContent\b[^>]*className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
          if (/(^|\s)(top-|bottom-|inset-|translate-y-)/.test(m[1] || m[2] || "")) offenders.push(`${p.replace(root + "/", "")}: ${(m[1] || m[2]).slice(0, 80)}`);
        }
      }
    };
    walk(join(root, "client/src"));
    expect(offenders).toEqual([]);
  });

  it("there is one visual-viewport listener in the app", () => {
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.(ts|tsx)$/.test(p)) continue;
        if (/visualViewport\b[^\n]*addEventListener|visualViewport\.addEventListener/.test(readFileSync(p, "utf8"))) users.push(p.replace(root + "/", ""));
      }
    };
    walk(join(root, "client/src"));
    expect(users).toEqual([]); // lib/visual-viewport.ts listens through `vv`, the name it gives the viewport
    expect(read("client/src/lib/visual-viewport.ts")).toMatch(/vv\.addEventListener\("resize"/);
  });
});

describe("a Save button a phone can see", () => {
  const editor = read("client/src/pages/editor.tsx");
  it("the document editor's phone bar has a Save button with its name on it", () => {
    const at = editor.indexOf('data-testid="button-mobile-save"');
    expect(at).toBeGreaterThan(0);
    expect(editor.slice(at, at + 260)).toMatch(/\n\s*Save\n/);
    // …and no button that says one thing and saves.
    expect(editor).not.toContain('data-testid="button-mobile-insert"');
  });
  it("the desktop Save keeps its name at every width", () => {
    const at = editor.indexOf('data-testid="button-editor-save"');
    expect(editor.slice(at, at + 260)).not.toContain("hidden sm:inline");
  });
  it("the phone formatting row can be scrolled to its last button", () => {
    const at = editor.indexOf('data-testid="toolbar-doc-mobile"');
    expect(editor.slice(at - 420, at)).toContain("overflow-x-auto");
  });
  it("Notes and Journal hand the shell a Save", () => {
    expect(read("client/src/pages/workspace-notes.tsx")).toMatch(/save=\{\{ state: [^}]*onSave: saveAsked \}\}/);
    expect(read("client/src/pages/workspace-journal.tsx")).toMatch(/save=\{\{ state, onSave: saveAsked \}\}/);
  });
  it("a small shared button still gives a finger a full-size target", () => {
    expect(read("client/src/components/ui/button.tsx")).toMatch(/sm: "[^"]*touch-hit/);
  });
});
