import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { setActiveTimezone } from "@/lib/timezone";
import { setActiveCurrency } from "@/lib/currency";

/**
 * Applies the account's stored timezone and currency to this device.
 *
 * Both settings are mirrored to localStorage the moment they are changed, so
 * the first render after a reload is already correct — this is what makes them
 * follow the ACCOUNT rather than the browser: sign in somewhere new and the
 * zone your records are kept in, and the symbol your money is shown in, come
 * with you instead of being whatever that machine happens to be set to.
 *
 * Renders nothing.
 */
export function RegionalPreferences() {
  const { data: tzPref } = useQuery<{ value: string | null }>({
    queryKey: ["/api/preferences/timezone"],
    queryFn: () => apiRequest("GET", "/api/preferences/timezone").then((r) => r.json()),
    staleTime: 5 * 60_000,
  });
  const { data: currencyPref } = useQuery<{ value: string | null }>({
    queryKey: ["/api/preferences/currency"],
    queryFn: () => apiRequest("GET", "/api/preferences/currency").then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    // The server also writes this key itself, from the X-Timezone header, at
    // most once an hour — that is how a cron knows a Tokyo user's "today". So
    // an unset preference means "follow the device", and a set one is either
    // the user's explicit choice or the device zone they were last seen in;
    // either way it is the right zone to apply.
    const tz = tzPref?.value;
    if (typeof tz === "string" && tz.trim()) setActiveTimezone(tz.trim());
  }, [tzPref?.value]);

  useEffect(() => {
    const code = currencyPref?.value;
    if (typeof code === "string" && code.trim()) setActiveCurrency(code.trim());
  }, [currencyPref?.value]);

  return null;
}
