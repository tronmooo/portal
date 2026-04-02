import { useState, useEffect, useCallback } from "react";

/**
 * Like useState but persists to localStorage.
 * Falls back to defaultValue if nothing stored.
 */
export function usePersistedState<T>(key: string, defaultValue: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch { /* quota exceeded, ignore */ }
  }, [key, value]);

  const setter = useCallback((next: T | ((prev: T) => T)) => {
    setValue(next);
  }, []);

  return [value, setter];
}
