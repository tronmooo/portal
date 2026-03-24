import CalendarView from "@/components/CalendarView";

export default function CalendarPage() {
  return (
    <div className="h-full overflow-y-auto" data-testid="calendar-page">
      <CalendarView />
    </div>
  );
}
