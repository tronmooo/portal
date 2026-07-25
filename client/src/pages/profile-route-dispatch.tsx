// ── /profiles/:id dispatcher ─────────────────────────────────────────────────
// People (self/person/pet) no longer have a dedicated giant profile page — they
// live as a dashboard (the hub, scoped via the switcher) with their data in the
// Info tab. So for a person we set the dashboard scope to them and redirect to
// their Info tab. Every OTHER profile type (asset, liability, subscription,
// loan, vehicle, insurance, …) still needs its per-type detail view, so we
// render the existing ProfileDetailPage for them.
//
// The 13k-line detail chunk stays lazy — we only pull it in for the non-person
// branch, never for people.
import { lazy, Suspense, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

const ProfileDetailPage = lazy(() => import("@/pages/profile-detail"));

const PERSON_TYPES = new Set(["self", "person", "pet"]);

function Loader() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="w-6 h-6 animate-spin text-primary" />
    </div>
  );
}

export default function ProfileRouteDispatch() {
  const [pluralMatch, pluralParams] = useRoute("/profiles/:id");
  const [singularMatch, singularParams] = useRoute("/profile/:id");
  const [tabMatch, tabParams] = useRoute("/profiles/:id/:tab");
  const id = (pluralParams as { id?: string } | null)?.id
    || (singularParams as { id?: string } | null)?.id
    || (tabParams as { id?: string } | null)?.id
    || "";
  // An explicit tab deep-link (/profiles/:id/finance) asks for the deep detail
  // page. Only the bare /profiles/:id shorthand redirects a person to their
  // lightweight Info page.
  const wantsTab = tabMatch && (tabParams as { tab?: string } | null)?.tab !== "info";
  const [, navigate] = useLocation();

  const { data: profiles, isLoading } = useQuery<any[]>({
    queryKey: ["/api/profiles", "lite"],
    queryFn: async () => (await apiRequest("GET", "/api/profiles/lite")).json(),
    staleTime: 30_000,
  });

  const profile = (profiles || []).find((p: any) => p.id === id);
  const isPerson = !!profile && PERSON_TYPES.has(profile.type);

  useEffect(() => {
    if (!id) return;
    // Normalize the legacy singular alias to the plural path, then re-dispatch.
    if (singularMatch && !pluralMatch) { navigate(`/profiles/${id}`, { replace: true }); return; }
    // Redirect to the person's Info tab WITHOUT touching the global dashboard
    // scope — the Info page loads this person by id on its own, and silently
    // repointing the whole dashboard/finance/trackers scope to whoever you last
    // opened made the dashboard "stick" to a sparse profile and look empty.
    // Scope only changes via the explicit hub switcher now.
    if (isPerson && profile && !wantsTab) {
      navigate(`/profiles/${profile.id}/info`, { replace: true });
    }
  }, [id, singularMatch, pluralMatch, isPerson, wantsTab, profile?.id]);

  // Show a loader while resolving the type, while redirecting a person, or while
  // normalizing the legacy alias.
  if ((singularMatch && !pluralMatch) || isLoading || (isPerson && !wantsTab)) return <Loader />;

  // Non-person profile — keep the per-type detail page.
  return (
    <Suspense fallback={<Loader />}>
      <ProfileDetailPage />
    </Suspense>
  );
}
