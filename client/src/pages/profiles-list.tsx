// ── /profiles/list — the profiles index ──────────────────────────────────────
// The hub switcher only surfaces people, and /profiles resolves to the Self
// profile's Info tab, so there was no page that simply listed everything you
// own and everyone you track. /profiles/list used to 404. It reads the same
// lite endpoint the switcher and route dispatcher share, so it costs nothing
// extra once any of them has loaded.
import { useState, useMemo, useEffect } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Search, Users } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { BubbleSkeletonGrid } from "@/components/ui/skeleton";
import { warmProfileDetail, prefetchProfileDetailChunkWhenIdle } from "@/lib/scope-prefetch";

interface LiteProfile {
  id: string;
  name: string;
  type: string;
  avatar?: string | null;
}

// Groups are rendered in this order; anything with an unlisted type falls into
// "Other" so a new profile type can never vanish from the index.
const GROUP_ORDER: { key: string; label: string; types: string[] }[] = [
  { key: "people", label: "People", types: ["self", "person"] },
  { key: "pets", label: "Pets", types: ["pet"] },
  { key: "property", label: "Property & Vehicles", types: ["property", "vehicle"] },
  { key: "assets", label: "Assets & Accounts", types: ["asset", "account", "investment", "business"] },
  { key: "money", label: "Liabilities & Subscriptions", types: ["loan", "liability", "subscription", "insurance"] },
  { key: "services", label: "Services", types: ["medical"] },
];

const TYPE_OF_GROUP = new Map<string, string>(
  GROUP_ORDER.flatMap(g => g.types.map(t => [t, g.key] as [string, string])),
);

export default function ProfilesListPage() {
  const [search, setSearch] = useState("");

  useEffect(() => { document.title = "Profiles — Portol"; }, []);
  // Every card here opens the lazy detail chunk — warm it while idle so the
  // tap only pays for the fetch. (Phones get no hover warmup.)
  useEffect(() => { prefetchProfileDetailChunkWhenIdle(); }, []);

  const fullProfilesCache = queryClient.getQueryData<LiteProfile[]>(["/api/profiles"]);
  const { data: profiles, isLoading } = useQuery<LiteProfile[]>({
    queryKey: ["/api/profiles", "lite"],
    queryFn: async () => (await apiRequest("GET", "/api/profiles/lite")).json(),
    initialData: fullProfilesCache,
    staleTime: 30_000,
  });

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = (profiles || []).filter(p => !q || p.name?.toLowerCase().includes(q));
    const byGroup = new Map<string, LiteProfile[]>();
    for (const p of matches) {
      const key = TYPE_OF_GROUP.get(p.type) ?? "other";
      const bucket = byGroup.get(key);
      if (bucket) bucket.push(p); else byGroup.set(key, [p]);
    }
    const ordered = [...GROUP_ORDER, { key: "other", label: "Other", types: [] }];
    return ordered
      .map(g => ({ ...g, items: (byGroup.get(g.key) ?? []).sort((a, b) => a.name.localeCompare(b.name)) }))
      .filter(g => g.items.length > 0);
  }, [profiles, search]);

  const total = profiles?.length ?? 0;

  return (
    <PageContainer testId="page-profiles-list">
      <PageHeader
        title="Profiles"
        subtitle={`${total} ${total === 1 ? "profile" : "profiles"}`}
        icon={Users}
        accent="213 90% 62%"
        actions={
        <div className="relative sm:w-56">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search profiles"
            aria-label="Search profiles"
            className="pl-8 h-9"
            data-testid="input-profiles-search"
          />
        </div>
        }
      />

      {isLoading && <BubbleSkeletonGrid count={4} rows={1} height={92} />}

      {!isLoading && groups.length === 0 && (
        <p className="text-sm text-muted-foreground py-8 text-center">
          {total === 0 ? "No profiles yet." : `No profiles match "${search}".`}
        </p>
      )}

      <div className="space-y-6">
        {groups.map(group => (
          <section key={group.key} data-testid={`profiles-group-${group.key}`}>
            <h2 className="micro-label text-muted-foreground mb-2">
              {group.label}
            </h2>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map(p => (
                <Link key={p.id} href={`/profiles/${p.id}`}>
                  <Card
                    className="p-3 flex items-center gap-3 hover:bg-accent/50 transition-colors cursor-pointer"
                    data-testid={`profile-card-${p.id}`}
                    onMouseEnter={() => warmProfileDetail(p.id)}
                    onTouchStart={() => warmProfileDetail(p.id)}
                  >
                    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold shrink-0 overflow-hidden">
                      {p.avatar
                        ? <img src={p.avatar} alt="" className="h-full w-full object-cover" />
                        : (p.name?.charAt(0).toUpperCase() || "?")}
                    </div>
                    <span className="text-sm font-medium truncate flex-1">{p.name}</span>
                    <Badge variant="secondary" className="text-[11px] h-5 capitalize shrink-0">{p.type}</Badge>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </PageContainer>
  );
}
