// ── Record details: client queries and writes ───────────────────────────────
// Every read sits under the ["/api/details", …] prefix, which the "details"
// cache domain invalidates (client/src/lib/cache-bus.ts), so a value set in
// chat or on another device reaches every open panel and the report.
//
// Writes go through apiRequest (Rule 2) and the response — the server's
// re-read of the record — is written into that record's cache at once, so
// the panel never shows the pre-save value while a refetch is in flight.
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import type {
  DetailDefinition, DetailEntityType, DetailFlag, DetailOp, DetailReportShape, RecordDetailsPayloadShape,
} from "./record-details-types";

export type { RecordDetailsPayloadShape, DetailReportShape } from "./record-details-types";

export const detailsKey = (entityType: DetailEntityType, entityId: string) => ["/api/details", entityType, entityId] as const;
export const DEFINITIONS_KEY = ["/api/details", "definitions"] as const;
export const FLAGS_KEY = ["/api/details", "flags"] as const;
export const reportKey = (definition: string, op?: string, value?: string) => ["/api/details", "report", definition, op || "", value || ""] as const;

async function getJson<T>(url: string): Promise<T> {
  const res = await apiRequest("GET", url);
  return res.json() as Promise<T>;
}

/** "400: Condition must be one of …" → "Condition must be one of …". */
export function detailErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return msg.replace(/^\d{3}:\s*/, "") || "Something went wrong";
}

export function useRecordDetails(entityType: DetailEntityType, entityId: string | undefined, opts: Partial<UseQueryOptions<RecordDetailsPayloadShape>> = {}) {
  return useQuery<RecordDetailsPayloadShape>({
    queryKey: detailsKey(entityType, entityId || ""),
    queryFn: () => getJson(`/api/details/${entityType}/${encodeURIComponent(entityId || "")}`),
    enabled: !!entityId,
    staleTime: 30_000,
    ...opts,
  });
}

export function useDetailDefinitions() {
  return useQuery<{ definitions: DetailDefinition[]; usage: Record<string, number> }>({
    queryKey: DEFINITIONS_KEY,
    queryFn: () => getJson("/api/details/definitions"),
    staleTime: 30_000,
  });
}

export function useDetailFlags() {
  return useQuery<{ flags: Array<{ entityType: DetailEntityType; entityId: string; name: string; href: string; flag: DetailFlag }> }>({
    queryKey: FLAGS_KEY,
    queryFn: () => getJson("/api/details/flags"),
    staleTime: 30_000,
  });
}

export function useDetailReport(definition: string | undefined, op?: DetailOp | "", value?: string) {
  const params = new URLSearchParams();
  if (definition) params.set("definition", definition);
  if (op) params.set("op", op);
  if (op && value !== undefined && value !== "") params.set("value", value);
  return useQuery<DetailReportShape>({
    queryKey: reportKey(definition || "", op || "", value || ""),
    queryFn: () => getJson(`/api/details/report?${params.toString()}`),
    enabled: !!definition,
    staleTime: 15_000,
  });
}

function storePayload(payload: RecordDetailsPayloadShape) {
  queryClient.setQueryData(detailsKey(payload.entityType, payload.entityId), payload);
  // The report, the flags and the catalog's usage counts read this record too.
  // (A no-op when the response's write manifest already refreshed "details".)
  void invalidateDomains("details");
}

export async function setDetailValue(entityType: DetailEntityType, entityId: string, definitionId: string, value: unknown) {
  const res = await apiRequest("PUT", `/api/details/${entityType}/${encodeURIComponent(entityId)}/${encodeURIComponent(definitionId)}`, { value });
  const payload = (await res.json()) as RecordDetailsPayloadShape;
  storePayload(payload);
  return payload;
}

export async function clearDetailValue(entityType: DetailEntityType, entityId: string, definitionId: string) {
  const res = await apiRequest("DELETE", `/api/details/${entityType}/${encodeURIComponent(entityId)}/${encodeURIComponent(definitionId)}`);
  const payload = (await res.json()) as RecordDetailsPayloadShape;
  storePayload(payload);
  return payload;
}

/** Name a characteristic (new or existing) and set its value in one step. */
export async function defineAndSetDetail(
  entityType: DetailEntityType, entityId: string,
  definition: Partial<DetailDefinition> & { label: string }, value: unknown,
) {
  const res = await apiRequest("POST", `/api/details/${entityType}/${encodeURIComponent(entityId)}`, { definition, value });
  const payload = (await res.json()) as RecordDetailsPayloadShape & { definition: DetailDefinition; createdDefinition: boolean };
  storePayload(payload);
  return payload;
}

export async function saveDefinition(id: string | null, input: Record<string, unknown>): Promise<DetailDefinition> {
  const res = id
    ? await apiRequest("PATCH", `/api/details/definitions/${encodeURIComponent(id)}`, input)
    : await apiRequest("POST", "/api/details/definitions", input);
  const saved = ((await res.json()) as { definition: DetailDefinition }).definition;
  // A rename, a new option or a new rule changes every record's panel and flags.
  void invalidateDomains("details");
  return saved;
}

export async function deleteDefinition(id: string): Promise<{ removedValues: number }> {
  const res = await apiRequest("DELETE", `/api/details/definitions/${encodeURIComponent(id)}`);
  const out = await res.json();
  void invalidateDomains("details");
  return out;
}
