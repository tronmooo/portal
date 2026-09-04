import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  currencySymbol, getActiveCurrency, setActiveCurrency, clearStoredCurrency, isValidCurrency,
} from "../client/src/lib/currency";
import {
  getActiveTimezone, setActiveTimezone, clearStoredTimezone, isValidTimezone,
  isFollowingDeviceTimezone, todayInActiveTimezone,
} from "../client/src/lib/timezone";
import {
  MAX_IMAGE_BYTES, MAX_DOCUMENT_BYTES, formatBytes, tooLargeMessage, uploadLimitHint,
} from "../shared/upload-limits";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("currency is one setting, not eighty-five literals", () => {
  afterEach(() => clearStoredCurrency());

  it("defaults to dollars, so nothing changes for an account that never touches it", () => {
    expect(getActiveCurrency()).toBe("USD");
    expect(currencySymbol()).toBe("$");
  });

  it("changes the symbol every formatter uses", () => {
    setActiveCurrency("GBP");
    expect(currencySymbol()).toBe("£");
    setActiveCurrency("EUR");
    expect(currencySymbol()).toBe("€");
  });

  it("refuses a value that would poison every amount in the app", () => {
    expect(isValidCurrency("NOTACODE")).toBe(false);
    expect(isValidCurrency("")).toBe(false);
    setActiveCurrency("GBP");
    setActiveCurrency("NOTACODE"); // falls back rather than corrupting
    expect(getActiveCurrency()).toBe("USD");
  });

  it("leaves no hardcoded dollar sign in the canonical formatters", () => {
    const src = read("client/src/lib/format.ts");
    const helpers = src.slice(src.indexOf("export function formatMoney"));
    expect(helpers).not.toMatch(/"-?\$"/);
    expect(helpers).toMatch(/currencySymbol\(\)/);
  });
});

describe("timezone is the account's answer, not the device's", () => {
  afterEach(() => clearStoredTimezone());

  it("follows the device until told otherwise", () => {
    expect(isFollowingDeviceTimezone()).toBe(true);
    expect(getActiveTimezone()).toBeTruthy();
  });

  it("honours an explicit choice", () => {
    setActiveTimezone("Asia/Tokyo");
    expect(getActiveTimezone()).toBe("Asia/Tokyo");
    expect(isFollowingDeviceTimezone()).toBe(false);
  });

  it("goes back to the device when the choice is cleared", () => {
    setActiveTimezone("Asia/Tokyo");
    setActiveTimezone(null);
    expect(isFollowingDeviceTimezone()).toBe(true);
  });

  it("rejects a zone the runtime does not know", () => {
    expect(isValidTimezone("Mars/Olympus_Mons")).toBe(false);
    setActiveTimezone("Mars/Olympus_Mons");
    expect(isFollowingDeviceTimezone()).toBe(true);
  });

  it("computes 'today' in the chosen zone, in the shape a date column uses", () => {
    // 2026-09-04T23:30Z is already the 5th in Tokyo and still the 4th in LA —
    // the difference the app used to get wrong by reading only the device.
    const at = new Date("2026-09-04T23:30:00Z");
    setActiveTimezone("Asia/Tokyo");
    expect(todayInActiveTimezone(at)).toBe("2026-09-05");
    setActiveTimezone("America/Los_Angeles");
    expect(todayInActiveTimezone(at)).toBe("2026-09-04");
  });
});

describe("dates are formatted one way across the app", () => {
  it("has no call site left on the browser's locale", () => {
    for (const p of [
      "client/src/pages/dashboard.tsx",
      "client/src/pages/finance.tsx",
      "client/src/pages/profile-detail.tsx",
      "client/src/pages/liability-detail.tsx",
      "client/src/components/dashboard/ExecutiveBriefing.tsx",
    ]) {
      // `toLocaleDateString(undefined, …)` means "whatever this browser is set
      // to", so the same date read differently on different screens.
      expect(read(p)).not.toMatch(/toLocale(Date|Time)?String\(undefined/);
    }
  });
});

describe("upload limits are one number, stated before the file is picked", () => {
  it("says the size AND the limit when it refuses", () => {
    const msg = tooLargeMessage(12 * 1024 * 1024, MAX_DOCUMENT_BYTES);
    expect(msg).toContain("12 MB");
    expect(msg).toContain("10 MB");
  });

  it("formats a limit the way a person would say it", () => {
    expect(formatBytes(8 * 1024 * 1024)).toBe("8 MB");
    expect(formatBytes(512 * 1024)).toBe("512 KB");
    expect(uploadLimitHint(MAX_IMAGE_BYTES)).toBe("Up to 8 MB");
  });

  it("leaves no surface enforcing a ceiling of its own", () => {
    for (const p of [
      "client/src/components/SmartFillTrigger.tsx",
      "client/src/pages/liability-detail.tsx",
      "client/src/pages/profile-info.tsx",
      "client/src/pages/chat.tsx",
    ]) {
      const src = read(p);
      expect(src).not.toMatch(/size > \d+ \* 1024 \* 1024/);
      expect(src).toMatch(/MAX_(IMAGE|DOCUMENT)_BYTES/);
    }
  });
});

describe("a list is not silently cut short", () => {
  it("stops opting the profile tabs into a cap the routes do not apply", () => {
    // Both routes are full-by-default and only page when a caller asks; asking
    // for limit=500 lost everything past the 500th row with nothing on screen
    // to say so.
    const src = read("client/src/pages/profile-detail.tsx");
    expect(src).not.toMatch(/\/api\/documents\?profileId=\$\{[^}]*\}&limit=/);
    expect(src).not.toMatch(/\/api\/events\?profileIds=\$\{[^}]*\}&limit=/);
  });

  it("says so where a cap is genuinely intended", () => {
    const src = read("client/src/components/OwnershipEditor.tsx");
    expect(src).toMatch(/most recent changes/);
  });
});
