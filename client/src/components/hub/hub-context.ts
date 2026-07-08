import { createContext, useContext } from "react";

// True when the current route renders inside the unified hub shell (KPI strip
// + profile switcher + tab chips mounted by App.tsx). Pages read this to hide
// their now-duplicate chrome (own headers, back links, MultiProfileFilter)
// while staying fully functional when visited standalone (context defaults to
// false, e.g. in tests or if a page is ever routed outside the hub).
export const HubChromeContext = createContext<boolean>(false);

export function useHubChrome(): boolean {
  return useContext(HubChromeContext);
}
