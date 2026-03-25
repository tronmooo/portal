import CalendarView from "@/components/CalendarView";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";

export default function CalendarPage() {
  return (
    <div className="h-full overflow-y-auto" data-testid="calendar-page">
      <div className="p-4 md:p-6">
        <div className="flex items-center gap-3 mb-4">
          <Link href="/">
            <button className="inline-flex items-center justify-center rounded-md w-8 h-8 hover:bg-muted transition-colors" data-testid="button-back">
              <ArrowLeft className="w-4 h-4" />
            </button>
          </Link>
          <h1 className="text-xl font-semibold">Calendar</h1>
        </div>
      </div>
      <CalendarView />
    </div>
  );
}
