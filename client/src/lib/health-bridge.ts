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
// To actually enable this later:
//   1. npm i capacitor-health          (one API over HealthKit + Health Connect)
//   2. capacitor.config.ts → ios.infoPlist: NSHealthShareUsageDescription
//      (and NSHealthUpdateUsageDescription only if we ever write back)
//   3. Xcode → Signing & Capabilities → HealthKit
//      (entitlement com.apple.developer.healthkit)
// =============================================================================

import { HEALTH_METRIC_IDS, type DailyRow } from "@shared/health-metrics";

/** Package probed at runtime. Not a dependency — see the note above. */
const HEALTH_PLUGIN_MODULE = "capacitor-health";

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

/** Load the health plugin, or undefined when it isn't in the build. */
async function loadPlugin(): Promise<any | undefined> {
  try {
    // Indirect import: a literal import() would make Rollup resolve the package
    // at build time, which fails because it is deliberately not installed.
    const mod = await (Function("p", "return import(p)"))(HEALTH_PLUGIN_MODULE);
    return mod?.Health ?? mod?.default ?? mod;
  } catch {
    return undefined;
  }
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
 * Ask for read access to the metrics we import. Returns false when the user
 * declines — the caller should surface that, not retry.
 */
export async function requestHealthAuthorization(
  metricIds: string[] = HEALTH_METRIC_IDS,
): Promise<boolean> {
  const plugin = await loadPlugin();
  if (!plugin) return false;
  try {
    const result = await plugin.requestHealthPermissions?.({ permissions: metricIds })
      ?? await plugin.requestAuthorization?.({ read: metricIds });
    // Plugins disagree on the success shape; treat anything not explicitly
    // false or "denied" as granted, and let the query fail loudly otherwise.
    if (result === false) return false;
    if (result && typeof result === "object" && "granted" in result) return !!result.granted;
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull daily aggregates for a date range, already in the shape the import
 * endpoint accepts. Returns [] when the plugin is absent so callers never need
 * a separate availability check before this.
 *
 * UNVERIFIED against a real plugin — nothing here has executed, because no
 * health plugin is installed and there is no ios/ project to run it in. In
 * particular the `dataType` values are passed as our own registry metric ids;
 * a plugin will almost certainly want its own vocabulary, in which case map
 * through HEALTHKIT_TYPE_MAP / HEALTH_CONNECT_TYPE_MAP (shared/health-metrics)
 * at this boundary. Treat this function as the shape of the integration rather
 * than a working one, and re-check it when the plugin lands.
 */
export async function queryDailyAggregates(
  metricIds: string[],
  fromDay: string,
  toDay: string,
): Promise<DailyRow[]> {
  const plugin = await loadPlugin();
  if (!plugin) return [];

  const rows: DailyRow[] = [];
  for (const metric of metricIds) {
    try {
      const res = await plugin.queryAggregated?.({
        dataType: metric,
        startDate: fromDay,
        endDate: toDay,
        bucket: "day",
      });
      for (const item of res?.aggregatedData ?? []) {
        const day = String(item.date || item.startDate || "").slice(0, 10);
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
