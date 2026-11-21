// Response shapes of /api/details/* (server/record-details.ts), re-stated over
// the shared types so client code never imports from server/.
import type {
  DetailDefinition, DetailEntityType, DetailFlag, DetailHistoryEntry, DetailOp, DetailTemplate, DetailValue,
} from "@shared/record-details";

export type { DetailDefinition, DetailEntityType, DetailFlag, DetailOp, DetailTemplate, DetailValue } from "@shared/record-details";

export interface DetailRowShape {
  definition: DetailDefinition;
  value: DetailValue | null;
  display: string;
  updatedAt: string | null;
  history: DetailHistoryEntry[];
  stale: boolean;
  flags: DetailFlag[];
}

export interface RecordDetailsPayloadShape {
  entityType: DetailEntityType;
  entityId: string;
  name: string;
  scopeTokens: string[];
  defaultScope: string;
  rows: DetailRowShape[];
  available: DetailDefinition[];
  suggestions: DetailTemplate[];
  flags: DetailFlag[];
}

export interface DetailReportRowShape {
  entityType: DetailEntityType;
  entityId: string;
  name: string;
  href: string;
  scope: string;
  value: DetailValue | null;
  display: string;
  updatedAt: string | null;
  flags: DetailFlag[];
}

export interface DetailReportShape {
  definition: DetailDefinition;
  filter: { op: DetailOp; value?: unknown; label: string } | null;
  total: number;
  rows: DetailReportRowShape[];
  distribution: Array<{ value: string; count: number }>;
}
