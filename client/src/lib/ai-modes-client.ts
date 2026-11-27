// The person's custom AI Modes (shared/ai-modes.ts), on the client.
//
// One list, read from GET /api/workspace/modes. Every change is a server
// route that applies it to the STORED row (Rule 6) and answers with the whole
// list, which is written straight into the cache — never a client
// read-modify-write of the array. A failed read is an error with a retry,
// never "no modes" (Rule 7).
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { parseAiModes, type AiMode } from "@shared/ai-modes";

export const AI_MODES_KEY = ["/api/workspace/modes"] as const;

export function useAiModes() {
  const qc = useQueryClient();
  const query = useQuery<AiMode[]>({
    queryKey: AI_MODES_KEY,
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/workspace/modes");
      const j = await r.json();
      if (!j || !Array.isArray(j.modes)) throw new Error("Unexpected response");
      return parseAiModes(j.modes);
    },
    staleTime: 60_000,
  });
  /** Run one change; the server's list replaces the cached one. Returns the mode it names, if any. */
  const run = useCallback(async (method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<AiMode | null> => {
    const r = await apiRequest(method, `/api/workspace/modes${path}`, body);
    const j = await r.json();
    if (!j || !Array.isArray(j.modes)) throw new Error("Your AI modes were not changed.");
    qc.setQueryData(AI_MODES_KEY, parseAiModes(j.modes));
    return j.mode ? (parseAiModes([j.mode])[0] ?? null) : null;
  }, [qc]);
  return {
    modes: query.data,
    loading: query.isLoading,
    failed: query.isError && query.data === undefined,
    retry: () => query.refetch(),
    create: (mode: AiMode) => run("POST", "", { mode }),
    update: (id: string, patch: Partial<AiMode>) => run("PATCH", `/${id}`, { patch }),
    duplicate: (id: string) => run("POST", `/${id}/duplicate`),
    remove: (id: string) => run("DELETE", `/${id}`),
    reorder: (ids: string[]) => run("POST", "/order", { ids }),
  };
}

export const modeRoute = (id: string) => `/workspace/mode/${id}`;
export const MODES_ROUTE = "/workspace/modes";
