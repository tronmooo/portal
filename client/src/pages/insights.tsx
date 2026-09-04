// Insights page — surfaces anomalies, runs receipt OCR, and triggers weekly
// review generation. Lives at /insights so the dashboard layout is untouched.

import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { invalidateDomains } from "@/lib/cache-bus";
import { getUserToday } from "@shared/timezone";
import { getProfileFilter, subscribeProfileFilter } from "@/lib/profileFilter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ArrowLeft, AlertTriangle, TrendingUp, Activity,
  FileText, Camera, Sparkles, Loader2, RefreshCw, Wallet,
} from "lucide-react";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { getActiveTimezone } from "@/lib/timezone";

// AI-derived content is purple across the app (Executive insights, the wellness
// AI card, the finance alerts panel).
const INSIGHTS_ACCENT = "280 75% 62%";

type Anomaly = {
  id: string;
  severity: "low" | "medium" | "high";
  category: "spending" | "tracker" | "habit" | "budget" | "income";
  title: string;
  detail: string;
  amount?: number;
  vsBaseline?: number;
};

type Receipt = {
  vendor: string | null;
  amount: number | null;
  date: string | null;
  category: string | null;
  items?: Array<{ name: string; price: number }>;
};

// Map our receipt category strings to the server's allowed expense categories.
const CATEGORY_MAP: Record<string, string> = {
  groceries: "food",
  dining: "food",
  fuel: "transport",
  shopping: "shopping",
  transport: "transport",
  utilities: "utilities",
  health: "health",
  entertainment: "entertainment",
  services: "general",
  other: "general",
};

function severityColor(sev: string) {
  if (sev === "high") return "text-red-600 dark:text-red-400 border-red-500/30 bg-red-500/10";
  if (sev === "medium") return "text-orange-600 dark:text-orange-400 border-orange-500/30 bg-orange-500/10";
  return "text-blue-600 dark:text-blue-400 border-blue-500/30 bg-blue-500/10";
}

function categoryIcon(cat: string) {
  if (cat === "spending" || cat === "budget") return TrendingUp;
  if (cat === "tracker" || cat === "habit") return Activity;
  return AlertTriangle;
}

export default function InsightsPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [scanning, setScanning] = useState(false);

  // Scope insights/anomalies/weekly-review to the active profile filter (single
  // source of truth). Without this the Reports surfaces leaked every profile's
  // data regardless of the selected scope.
  const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  useEffect(() => subscribeProfileFilter((s) => { setFilterMode(s.mode); setFilterIds([...s.selectedIds]); }), []);
  const profileParam = filterMode === "selected" && filterIds.length > 0 ? `?profileIds=${filterIds.join(",")}` : "";

  const { data: anomData, isLoading: anomLoading, refetch: refetchAnom } = useQuery<{ anomalies: Anomaly[] }>({
    queryKey: ["/api/anomalies", filterMode, ...filterIds],
    queryFn: () => apiRequest("GET", `/api/anomalies${profileParam}`).then(r => r.json()),
  });
  const anomalies: Anomaly[] = anomData?.anomalies || [];

  const reviewMut = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/weekly-review/generate", {
        profileIds: filterMode === "selected" && filterIds.length > 0 ? filterIds : undefined,
      });
      return r.json();
    },
    onSuccess: (data: { artifactId: string; title: string }) => {
      qc.invalidateQueries({ queryKey: ["/api/artifacts"] });
      toast({ title: "Weekly review created", description: data.title });
      setLocation(`/editor/${data.artifactId}`);
    },
    onError: (err: any) => {
      toast({ title: "Failed to generate review", description: err?.message || String(err), variant: "destructive" });
    },
  });

  const expenseMut = useMutation({
    mutationFn: async (r: Receipt) => {
      if (!r.amount || !r.vendor) throw new Error("Missing amount or vendor");
      const mappedCat = CATEGORY_MAP[(r.category || "other").toLowerCase()] || "general";
      const body = {
        amount: r.amount,
        description: r.vendor,
        vendor: r.vendor,
        category: mappedCat,
        date: r.date || getUserToday(getActiveTimezone()),
      };
      const res = await apiRequest("POST", "/api/expenses", body);
      return res.json();
    },
    onSuccess: () => {
      // Cache bus: an expense also moves budgets, cashflow and the bootstrap
      // seed, and other open tabs need to hear about it (ARCHITECTURE §6).
      void invalidateDomains("expenses");
      toast({ title: "Expense added" });
      setReceipt(null);
    },
    onError: (err: any) => {
      toast({ title: "Failed to save expense", description: err?.message, variant: "destructive" });
    },
  });

  const handleFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast({ title: "Please pick an image", variant: "destructive" });
      return;
    }
    setScanning(true);
    try {
      const reader = new FileReader();
      const base64: string = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const res = await apiRequest("POST", "/api/receipt-extract", {
        fileData: base64,
        mimeType: file.type,
      });
      const json: Receipt = await res.json();
      setReceipt(json);
      if (!json.amount || !json.vendor) {
        toast({ title: "Couldn't read receipt fully", description: "Some fields are missing — review and edit before saving." });
      }
    } catch (err: any) {
      toast({ title: "Receipt scan failed", description: err?.message || String(err), variant: "destructive" });
    } finally {
      setScanning(false);
    }
  };

  return (
    <PageContainer width="4xl">
      <PageHeader
        title="Insights"
        subtitle="Anomalies, weekly reviews, and receipt scanning"
        icon={Sparkles}
        accent={INSIGHTS_ACCENT}
        onBack={() => setLocation("/dashboard")}
        actions={
          <Button variant="ghost" size="sm" onClick={() => refetchAnom()} disabled={anomLoading}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${anomLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      <div className="space-y-6">
        {/* Quick actions row */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" /> Weekly Review
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-3">
                Generate a personalized recap of your last 7 days — tasks, spending, trackers, and journal in one doc you can edit freely.
              </p>
              <Button onClick={() => reviewMut.mutate()} disabled={reviewMut.isPending} data-testid="button-generate-review">
                {reviewMut.isPending ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generating…</>
                ) : (
                  <><Sparkles className="h-4 w-4 mr-2" /> Generate this week's review</>
                )}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Camera className="h-4 w-4" /> Scan Receipt
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-3">
                Take a photo or upload a receipt — vendor, amount, date, and category are extracted automatically.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                  e.target.value = "";
                }}
                data-testid="input-receipt-file"
              />
              <Button onClick={() => fileInputRef.current?.click()} disabled={scanning} data-testid="button-scan-receipt">
                {scanning ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Scanning…</>
                ) : (
                  <><Camera className="h-4 w-4 mr-2" /> Pick a receipt photo</>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Receipt result */}
        {receipt && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Receipt extracted</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Vendor</div>
                  <input
                    className="w-full px-2 py-1 rounded border bg-background"
                    value={receipt.vendor || ""}
                    onChange={(e) => setReceipt({ ...receipt, vendor: e.target.value })}
                  />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Amount</div>
                  <input
                    type="number"
                    step="0.01"
                    className="w-full px-2 py-1 rounded border bg-background"
                    value={receipt.amount ?? ""}
                    onChange={(e) => setReceipt({ ...receipt, amount: e.target.value === "" ? null : Number(e.target.value) })}
                  />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Date</div>
                  <input
                    type="date"
                    className="w-full px-2 py-1 rounded border bg-background"
                    value={receipt.date || ""}
                    onChange={(e) => setReceipt({ ...receipt, date: e.target.value })}
                  />
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Category</div>
                  <select
                    className="w-full px-2 py-1 rounded border bg-background"
                    value={receipt.category || "other"}
                    onChange={(e) => setReceipt({ ...receipt, category: e.target.value })}
                  >
                    {Object.keys(CATEGORY_MAP).map(cat => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>
                </div>
              </div>
              {receipt.items && receipt.items.length > 0 && (
                <div className="mb-4">
                  <div className="text-xs text-muted-foreground mb-1">Line items</div>
                  <ul className="text-sm space-y-1">
                    {receipt.items.slice(0, 8).map((item, i) => (
                      <li key={i} className="flex justify-between border-b pb-1">
                        <span>{item.name}</span>
                        <span className="font-mono">${item.price.toFixed(2)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex gap-2">
                <Button onClick={() => expenseMut.mutate(receipt)} disabled={!receipt.amount || !receipt.vendor || expenseMut.isPending} data-testid="button-save-expense">
                  {expenseMut.isPending ? (
                    <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…</>
                  ) : (
                    <><Wallet className="h-4 w-4 mr-2" /> Save as expense</>
                  )}
                </Button>
                <Button variant="ghost" onClick={() => setReceipt(null)}>Dismiss</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Anomalies */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> Anomalies
              {anomalies.length > 0 && (
                <span className="text-xs font-normal text-muted-foreground">({anomalies.length})</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {anomLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Scanning…
              </div>
            ) : anomalies.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center">
                Nothing unusual right now. Spending, budgets, and tracker activity all look normal.
              </div>
            ) : (
              <div className="space-y-2">
                {anomalies.map((a) => {
                  const Icon = categoryIcon(a.category);
                  return (
                    <div
                      key={a.id}
                      className={`rounded-lg border px-3 py-2 ${severityColor(a.severity)}`}
                      data-testid={`anomaly-${a.id}`}
                    >
                      <div className="flex items-start gap-2">
                        <Icon className="h-4 w-4 mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                          <div className="font-medium text-sm">{a.title}</div>
                          <div className="text-xs opacity-80">{a.detail}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
