// Check off / skip / restore ONE occurrence of a recurring event.
//
// The server applies the change to the event's tags AS STORED
// (POST /api/events/:id/occurrence), instead of every surface rebuilding the
// whole tag array from its own cached copy and PATCHing it back — which lost
// whichever of two near-simultaneous marks landed first (Rule 7).
import { apiRequest } from "./queryClient";

export type OccurrenceState = "done" | "skip" | "clear";

export function setEventOccurrence(eventId: string, date: string, state: OccurrenceState): Promise<Response> {
  return apiRequest("POST", `/api/events/${eventId}/occurrence`, { date: String(date).slice(0, 10), state });
}

/** Pause/resume or archive/unarchive a recurring series, applied server-side to the stored tags. */
export function setEventSeriesFlag(eventId: string, flag: "paused" | "archived", on: boolean): Promise<Response> {
  return apiRequest("POST", `/api/events/${eventId}/series-flag`, { flag, on });
}
