// client/src/hooks/useProfileDocuments.ts
//
// THE profile's documents, for every surface that shows or counts them.
//
// The Info tab's "Documents 3" and the Documents tab's list of 2 (2026-09-17)
// came from two sources read by two rules: Info counted the server embed
// (`profile.relatedDocuments`), the tab read the live `/api/documents` list
// and filtered it by link. This hook is the one place both read from — the
// same query, the same union with the embed, the same rule
// (shared/document-scope), so the number IS the length of the list.
//
// PERF: profile-scoped fetch (the existing ?profileId= filter) rather than
// the global list; prefix invalidations on ["/api/documents"] still match.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { documentsForProfile } from "@shared/document-scope";

/** The query key both tabs share, so one fetch serves both. */
export const profileDocumentsQueryKey = (profileId: string) =>
  ["/api/documents", profileId, "profile-scoped"] as const;

export function useProfileDocuments<T extends { id: string; linkedProfiles?: ReadonlyArray<string> | null }>(
  profileId: string | undefined,
  embedded?: ReadonlyArray<T> | null,
): T[] {
  const { data: listed } = useQuery<T[]>({
    queryKey: profileDocumentsQueryKey(profileId ?? ""),
    queryFn: async () =>
      (await apiRequest("GET", `/api/documents?profileId=${encodeURIComponent(profileId ?? "")}&limit=500`)).json(),
    enabled: !!profileId,
  });
  return useMemo(() => {
    if (!profileId) return [];
    // The embed is a courtesy union: a document the paged list missed still
    // shows. The list, arriving second, wins on a shared id — see
    // documentsForProfile.
    const rows: Array<T | null | undefined> = [
      ...(Array.isArray(embedded) ? embedded : []),
      ...(Array.isArray(listed) ? listed : []),
    ];
    return documentsForProfile(rows, profileId);
  }, [embedded, listed, profileId]);
}
