// shared/chat-progress.ts — what the thread says while the assistant works.
//
// A 26-second turn used to show a row of bouncing dots and a spinner on the
// Send button; nothing said what was happening or that anything still was
// (QA 2026-09-18 F-46). The label here is the ONE rule for that placeholder:
// the running tool when there is one ("Adding expense…"), otherwise a phase
// that moves with the clock, so a long turn visibly keeps going.
//
// Also home to the resend guard (F-45): the composer clears synchronously on
// submit, and the send path refuses a message identical to the one it just
// dispatched, so a draft the box failed to drop can never go out twice.

export interface RunningTool { tool: string; label?: string }

/** "create_expense" → "Adding expense", "log_tracker_entry" → "Logging tracker entry". */
export function humanizeToolName(tool: string): string {
  const words = String(tool || "").replace(/[_-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Working";
  const VERBS: Record<string, string> = {
    create: "Adding", add: "Adding", log: "Logging", record: "Logging",
    update: "Updating", edit: "Updating", set: "Updating", patch: "Updating",
    delete: "Removing", remove: "Removing", archive: "Archiving",
    get: "Looking up", list: "Looking up", find: "Looking up", search: "Searching", lookup: "Looking up", read: "Reading",
    mark: "Marking", complete: "Completing", pay: "Recording payment for",
  };
  const [first, ...rest] = words;
  const verb = VERBS[first.toLowerCase()];
  if (!verb) return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase())).join(" ");
  return rest.length ? `${verb} ${rest.join(" ").toLowerCase()}` : verb;
}

export interface ChatProgressInput {
  /** Milliseconds since the message was sent. */
  elapsedMs: number;
  /** Tools the server has started and not yet finished, oldest first. */
  runningTools?: readonly RunningTool[];
  /** True while an attachment is being uploaded and read. */
  uploading?: boolean;
}

/** The status line for the thinking placeholder. Never empty. */
export function chatProgressLabel(input: ChatProgressInput): string {
  if (input.uploading) return "Uploading & reading your document…";
  const tools = input.runningTools || [];
  if (tools.length > 0) {
    const t = tools[tools.length - 1];
    const name = humanizeToolName(t.tool);
    const label = String(t.label || "").trim();
    return label && label !== t.tool ? `${name}: ${label}…` : `${name}…`;
  }
  const s = Math.floor(Math.max(0, input.elapsedMs) / 1000);
  if (s < 3) return "Thinking…";
  if (s < 10) return "Working on it…";
  if (s < 30) return `Still working… ${s}s`;
  return `Still working — complex requests take longer · ${s}s`;
}

/** Elapsed seconds as the bubble shows them: nothing under 3s, then "12s". */
export function elapsedBadge(elapsedMs: number): string {
  const s = Math.floor(Math.max(0, elapsedMs) / 1000);
  return s >= 3 ? `${s}s` : "";
}

export interface LastSend { text: string; at: number }

/** A second send of the same text this soon after the first is a duplicate, not a message. */
export const RESEND_WINDOW_MS = 1500;

/**
 * True when `text` is the message that was just sent and the previous send is
 * still in flight or finished within RESEND_WINDOW_MS — the tap that follows a
 * composer which failed to clear.
 */
export function isDuplicateResend(last: LastSend | null | undefined, text: string, now: number, inFlight: boolean): boolean {
  if (!last) return false;
  if (last.text.trim() !== text.trim()) return false;
  if (inFlight) return true;
  return now - last.at < RESEND_WINDOW_MS;
}
