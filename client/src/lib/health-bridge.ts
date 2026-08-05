// client/src/lib/health-bridge.ts
// =============================================================================
// Runtime bridge to native health data (Apple HealthKit / Android Health
// Connect).
// =============================================================================
//
// No health plugin is installed yet and the repo has no ios/ or android/
// project, so today every path here degrades to an honest "not available"
// state. That is the point: the Settings card reads its status from this
// module, so the moment the native app ships with a health plugin the rows
// start working with no change to the UI.
//
// Detection follows the pattern already used for the microphone in
// components/chat/ChatComposer.tsx:39-50 — probe window.Capacitor at runtime,
// then dynamic-import the plugin through a variable so Rollup cannot try to
// resolve a package that isn't in package.json and fail the build.
//
// Worth recording, because it looks like a blocker and isn't: capacitor.config
// points the app at https://portol.me rather than bundling the web build.
// Capacitor still injects the native bridge into the remote page, so plugins
// work normally — remote-URL mode does not rule out HealthKit.
//
// Info.plist strings and the privacy manifest are already staged
// (capacitor.config.ts, ios-assets/PrivacyInfo.xcprivacy). What is NOT decided
// is the plugin, because neither candidate is clearly right and neither can be
// tested from here — see docs/APP_STORE_GUIDE.md § HealthKit for the full
// comparison:
//
//   capacitor-health              Capacitor 8, iOS + Android, maintained — but
//                                 queryAggregated only accepts 'steps' |
//                                 'active-calories' | 'mindfulness'. Cannot
//                                 read sleep or weight at all.
//   @perfood/capacitor-healthkit  iOS only, peer-deps on Capacitor 4 (four
//                                 majors behind), but reads ~16 of our 20
//                                 metrics including sleep, weight, blood
//                                 pressure and resting heart rate.
//
// This module therefore probes for EITHER and adapts, rather than committing
// to one. Whoever picks should delete the branch they don't use.
// =============================================================================

import { HEALTH_METRIC_IDS, type DailyRow } from "@shared/health-metrics";

/** Packages probed at runtime, in preference order. Neither is a dependency. */
const HEALTH_PLUGIN_MODULES = ["capacitor-health", "@perfood/capacitor-healthkit"];

/** Names a native plugin may register under on window.Capacitor.Plugins. */
const HEALTH_PLUGIN_GLOBALS = ["Health", "CapacitorHealthkit", "HealthKit"];

export type HealthPlatform = "ios" | "android" | "web";

export type HealthUnavailableReason =
  | "web"              // running in a browser, not the native shell
  | "plugin-missing"   // native shell, but built before health support shipped
  | "unsupported-os"   // platform we don't have an app for yet
  | "denied";          // user declined the permission prompt

export type HealthCapability =
  | { available: true; platform: HealthPlatform }
  | { available: false; platform: HealthPlatform; reason: HealthUnavailableReason; message: string };

function capacitor(): any {
  return typeof window === "undefined" ? undefined : (window as any).Capacitor;
}

function platformOf(): HealthPlatform {
  const p = capacitor()?.getPlatform?.();
  return p === "ios" || p === "android" ? p : "web";
}

/**
 * Find the health plugin, or undefined when the app was built without one.
 *
 * The global lookup comes FIRST and matters more than it looks. Portol's native
 * shell loads the web app from https://portol.me rather than bundling it, so
 * the plugin's npm wrapper is generally NOT in the JS that runs on the device —
 * but Capacitor registers every native plugin on window.Capacitor.Plugins
 * regardless. That global is the reliable handle here; the dynamic import is
 * only a fallback for a locally bundled build.
 */
async function loadPlugin(): Promise<any | undefined> {
  const plugins = capacitor()?.Plugins;
  if (plugins) {
    for (const name of HEALTH_PLUGIN_GLOBALS) {
      if (plugins[name]) return plugins[name];
    }
  }
  for (const modPath of HEALTH_PLUGIN_MODULES) {
    try {
      // Indirect import: a literal import() would make Rollup resolve the
      // package at build time, which fails because it isn't installed.
      const mod = await (Function("p", "return import(p)"))(modPath);
      const plugin = mod?.Health ?? mod?.CapacitorHealthkit ?? mod?.default ?? mod;
      if (plugin) return plugin;
    } catch {
      // Not this one — try the next.
    }
  }
  return undefined;
}

/**
 * What can this device actually do right now? Every message is written to be
 * shown to the user verbatim — a status line that says "not available" without
 * saying what to do about it is the thing this replaces.
 */
export async function getHealthCapability(): Promise<HealthCapability> {
  const cap = capacitor();
  if (!cap?.isNativePlatform?.()) {
    return {
      available: false,
      platform: "web",
      reason: "web",
      message: "Open Portol on your iPhone to connect Apple Health.",
    };
  }

  const platform = platformOf();
  if (platform === "android") {
    return {
      available: false,
      platform,
      reason: "unsupported-os",
      message: "Health Connect needs the Portol Android app, which isn't released yet.",
    };
  }

  const plugin = await loadPlugin();
  if (!plugin) {
    return {
      available: false,
      platform,
      reason: "plugin-missing",
      message: "Update the Portol app to connect Apple Health.",
    };
  }

  return { available: true, platform };
}

/**
 * capacitor-health's permission vocabulary. Its HealthPermission union is a
 * closed set of `READ_…` / `WRITE_…` names, not our metric ids, so the request
 * has to be translated. We ask only for reads.
 */
const CAPACITOR_HEALTH_PERMISSIONS: Record<string, string> = {
  steps: "READ_STEPS",
  active_energy: "READ_ACTIVE_CALORIES",
  mindful_minutes: "READ_MINDFULNESS",
  distance_walked: "READ_DISTANCE",
  heart_rate: "READ_HEART_RATE",
  exercise_minutes: "READ_WORKOUTS",
};

/**
 * Ask for read access to the metrics we import. Returns false when the user
 * declines — the caller should surface that, not retry.
 *
 * On iOS the plugin cannot actually tell granted from denied (Apple does not
 * expose it), so a `true` here means "the prompt was shown", not "we have
 * access". A subsequent empty query is the real signal.
 */
export async function requestHealthAuthorization(
  metricIds: string[] = HEALTH_METRIC_IDS,
): Promise<boolean> {
  const plugin = await loadPlugin();
  if (!plugin) return false;

  const permissions = Array.from(new Set(
    metricIds.map((m) => CAPACITOR_HEALTH_PERMISSIONS[m]).filter(Boolean),
  ));
  if (permissions.length === 0) return false;

  try {
    if (typeof plugin.requestHealthPermissions === "function") {
      const result = await plugin.requestHealthPermissions({ permissions });
      // PermissionResponse is { permissions: [{ [name]: boolean }] }; treat an
      // explicit all-false as a refusal and anything else as proceed.
      const entries: any[] = result?.permissions ?? [];
      if (entries.length > 0) {
        const anyGranted = entries.some((e) => Object.values(e || {}).some(Boolean));
        return anyGranted;
      }
      return true;
    }
    if (typeof plugin.requestAuthorization === "function") {
      await plugin.requestAuthorization({ read: metricIds, write: [] });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Registry metric id → the dataType string `capacitor-health.queryAggregated`
 * accepts. That plugin's type signature is literally
 * `'steps' | 'active-calories' | 'mindfulness'`, so this map is short by
 * necessity, not by omission — everything absent from it genuinely cannot be
 * read through that plugin, sleep and weight included. Users get those through
 * the file import instead.
 */
const CAPACITOR_HEALTH_DATATYPES: Record<string, string> = {
  steps: "steps",
  active_energy: "active-calories",
  mindful_minutes: "mindfulness",
};

/**
 * Pull daily aggregates for a date range, already in the shape the import
 * endpoint accepts. Returns [] when the plugin is absent, so callers never need
 * a separate availability check first.
 *
 * UNVERIFIED — this has never executed. No plugin is installed and there is no
 * ios/ project to run one in. The shape follows capacitor-health's documented
 * API (queryAggregated → { aggregatedData: [{ startDate, endDate, value }] }),
 * read from its type definitions rather than guessed, but "matches the .d.ts"
 * is not "works on a device". Re-check against a real build before trusting it.
 */
export async function queryDailyAggregates(
  metricIds: string[],
  fromDay: string,
  toDay: string,
): Promise<DailyRow[]> {
  const plugin = await loadPlugin();
  if (!plugin) return [];

  if (typeof plugin.queryAggregated !== "function") return [];

  const rows: DailyRow[] = [];
  for (const metric of metricIds) {
    const dataType = CAPACITOR_HEALTH_DATATYPES[metric];
    if (!dataType) continue; // Not readable through this plugin — skip quietly.
    try {
      const res = await plugin.queryAggregated({
        dataType,
        startDate: fromDay,
        endDate: toDay,
        bucket: "day",
      });
      for (const item of res?.aggregatedData ?? []) {
        const day = String(item.startDate || "").slice(0, 10);
        const value = Number(item.value);
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(value)) {
          rows.push({ metric, day, value });
        }
      }
    } catch {
      // One unsupported metric must not sink the whole sync — HealthKit
      // rejects reads for types the user never recorded.
    }
  }
  return rows;
}

/** Metrics a native sync can actually deliver today, for honest UI copy. */
export const NATIVE_SYNCABLE_METRICS = Object.keys(CAPACITOR_HEALTH_DATATYPES);
