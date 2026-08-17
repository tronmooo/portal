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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { warmProfileDetail } from "@/lib/scope-prefetch";

const loadProfileDetail = () => import("@/pages/profile-detail");
const ProfileDetailPage = lazy(loadProfileDetail);

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

  const qc = useQueryClient();

  // ── PERF: break the open-a-profile request waterfall (§8/§9/§22) ───────────
  // This dispatcher used to be a strictly SERIAL chain before any content could
  // paint:
  //
  //   click → GET /api/profiles/lite → load the lazy detail chunk
  //         → GET /api/profile-bootstrap/:id → render
  //
  // Three round-trips deep, each able to land on its own cold serverless
  // instance. None of the three actually depends on the one before it: the
  // chunk and the profile's data are needed for every non-person profile
  // regardless of what `lite` says, and `lite` only answers "is this a
  // person?".
  //
  // So all three now start together on mount. Nothing here is speculative for
  // the common case — the overwhelming majority of /profiles/:id opens are
  // non-person (assets, liabilities, vehicles, accounts…), and warmProfileDetail
  // is already the app's own idempotent, throttled warm helper.
  useEffect(() => {
    if (!id) return;
    void loadProfileDetail();
    warmProfileDetail(id);
  }, [id]);

  const { data: profiles, isLoading } = useQuery<any[]>({
    queryKey: ["/api/profiles", "lite"],
    queryFn: async () => (await apiRequest("GET", "/api/profiles/lite")).json(),
    staleTime: 30_000,
  });

  // Answer "person or not?" from the full profile list when it is already in
  // cache (the dashboard bootstrap seeds `["/api/profiles"]` on every app open,
  // and navigating here from Assets/Liabilities guarantees it). That removes
  // the `lite` fetch from the critical path entirely on the common navigation,
  // instead of blocking the whole page on it. The `lite` query still runs and
  // still wins once it lands — this is a faster path to the same answer, not a
  // different answer.
  const cachedProfiles = qc.getQueryData<any[]>(["/api/profiles"]);
  const profile = (profiles || []).find((p: any) => p.id === id)
    || (cachedProfiles || []).find((p: any) => p.id === id);
  const isPerson = !!profile && PERSON_TYPES.has(profile.type);
  // Only block on `lite` when nothing has told us the type yet.
  const resolvingType = isLoading && !profile;

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
  if ((singularMatch && !pluralMatch) || resolvingType || (isPerson && !wantsTab)) return <Loader />;

  // Non-person profile — keep the per-type detail page.
  return (
    <Suspense fallback={<Loader />}>
      <ProfileDetailPage />
    </Suspense>
  );
}
