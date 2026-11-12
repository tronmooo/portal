// "Would you also like to create a profile for Bob?" — the OPTIONAL offer
// shown under a chat reply that mentioned a person with no profile.
//
// User spec 2026-11-12 (shared/profile-intent.ts): a name is data, not
// permission to create a profile. The record the user asked for is already
// saved; this card only offers more. "Yes" sends an explicit request in the
// user's own words ("Create a profile for Bob"), the one thing that may create
// a person. "No" just closes the card: nothing is written, no placeholder
// profile, and the server never offers the same name again.
import {
  type ProfileSuggestion, profileSuggestionYesText,
} from "@shared/profile-intent";

export function ProfileSuggestionCard({ suggestion, onYes, onNo }: {
  suggestion: ProfileSuggestion;
  onYes: (text: string) => void;
  onNo: () => void;
}) {
  const what = suggestion.type === "pet" ? "a pet profile"
    : suggestion.type === "medical" ? "a provider profile" : "a profile";
  return (
    <div className="bubble px-3 py-2.5 space-y-2" role="group"
      aria-label={`Optional: create ${what} for ${suggestion.name}`}
      data-testid={`profile-suggestion-${suggestion.name}`}>
      <p className="micro-label text-muted-foreground">Optional</p>
      <p className="text-[13px]">Would you also like to create {what} for <span className="font-semibold">{suggestion.name}</span>?</p>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => onYes(profileSuggestionYesText(suggestion))}
          className="bubble-row pressable px-2.5 py-1.5 text-[12px] font-semibold"
          data-testid="profile-suggestion-yes">
          Yes, create profile
        </button>
        <button type="button" onClick={onNo}
          className="bubble-row pressable px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground"
          data-testid="profile-suggestion-no">
          No, just keep the {suggestion.type === "pet" ? "entry" : "record"}
        </button>
      </div>
    </div>
  );
}
