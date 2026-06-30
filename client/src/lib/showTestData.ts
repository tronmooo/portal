// Tiny localStorage-backed preference: should synthetic test/QA rows be shown
// on the dashboard? Default OFF — `isTestDataRow` matches are hidden from normal
// views so a real account isn't polluted by suite-generated data (point 11).
// Mirrors the profileFilter store shape (event + useSyncExternalStore hook).
import { useSyncExternalStore } from "react";

const KEY = "portol_show_test_data";
const EVENT = "portol:show-test-data-change";

function read(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

let _state = read();

export function getShowTestData(): boolean {
  return _state;
}

export function setShowTestData(v: boolean): void {
  _state = v;
  try { localStorage.setItem(KEY, v ? "1" : "0"); } catch {}
  try { window.dispatchEvent(new CustomEvent(EVENT)); } catch {}
}

export function toggleShowTestData(): void {
  setShowTestData(!_state);
}

function subscribe(cb: () => void): () => void {
  const handler = () => { _state = read(); cb(); };
  window.addEventListener(EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

/** Reactive hook — re-renders when the toggle flips anywhere in the app. */
export function useShowTestData(): boolean {
  return useSyncExternalStore(subscribe, getShowTestData, () => false);
}
