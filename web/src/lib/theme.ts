/**
 * Theme preference: follow the system (default), or force Paper or Ink.
 *
 * The choice is a per-browser display preference, so it is kept in
 * localStorage under one fixed key and holds only "light" or "dark". It is
 * applied as data-theme on <html>, which the CSS tokens in styles.css read.
 * Storage can be unavailable (private mode, blocked site data); the app then
 * simply follows the system.
 */

import { useCallback, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";

const KEY = "syncro.theme";

function read(): ThemePreference {
  try {
    // eslint-disable-next-line no-restricted-globals -- display preference only; never tokens or data
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function apply(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
}

/** Applies the saved preference; call once before the first render. */
export function applySavedTheme(): void {
  apply(read());
}

export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(read);
  const update = useCallback((next: ThemePreference) => {
    try {
      // eslint-disable-next-line no-restricted-globals -- display preference only; never tokens or data
      if (next === "system") localStorage.removeItem(KEY);
      // eslint-disable-next-line no-restricted-globals -- display preference only; never tokens or data
      else localStorage.setItem(KEY, next);
    } catch {
      // The choice still applies for this page view.
    }
    apply(next);
    setPreference(next);
  }, []);
  return [preference, update];
}
