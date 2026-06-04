import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { MultiProfileFilter } from "@/components/MultiProfileFilter";
import { getProfileFilter } from "@/lib/profileFilter";
import { GoalsSection } from "@/pages/dashboard";

export default function GoalsPage() {
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  const [filterMode, setFilterMode] = useState(() => getProfileFilter().mode);

  // When "everyone", pass no ids so GoalsSection shows every profile's goals.
  const ids = filterMode === "everyone" ? [] : filterIds;

  return (
    <div className="p-4 md:p-6 space-y-6 overflow-y-auto h-full pb-24" data-testid="page-goals">
      <div className="flex items-center gap-3 mb-4">
        <Link href="/dashboard">
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors"
            aria-label="Back"
            data-testid="button-back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Link>
        <h1 className="text-lg font-semibold">Goals</h1>
        <div className="ml-auto">
          <MultiProfileFilter
            onChange={({ mode, selectedIds }) => { setFilterMode(mode); setFilterIds(selectedIds); }}
            compact
          />
        </div>
      </div>

      <GoalsSection profileIds={ids} />
    </div>
  );
}
