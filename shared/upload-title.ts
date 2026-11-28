// The name an uploaded document is filed under.
//
// The upload classifier titles a document from its content ("Lease" for a
// lease PDF) — useful when it could read it. When it could not, it answered
// "Unreadable Document", and that replaced the name the person gave the file
// (production, 2026-11-28: every unreadable upload was filed as "Unreadable
// Document", indistinguishable from the next). A title that says nothing about
// the document, or one the classifier is unsure of, keeps the file's own name.
const PLACEHOLDER_TITLE = /^(?:an?\s+)?(?:unreadable|unknown|unidentified|untitled|unnamed|blank|empty|illegible|corrupt(?:ed)?|unrecognized|unclear|generic|no)?\s*(?:document|file|image|photo|picture|scan|upload|attachment|page|pdf|text)?\s*(?:\(?(?:unreadable|unknown|blank)\)?)?$/i;
const SAYS_NOTHING = /\b(?:unreadable|illegible|unknown document|untitled|cannot be read|could not be read|unable to read|no (?:readable )?content|blank (?:page|image|document))\b/i;

export const MIN_TITLE_CONFIDENCE = 0.3;

export function uploadTitle(modelLabel: unknown, fileName: string, confidence: number): string {
  const label = String(modelLabel ?? "").trim();
  if (!label) return fileName;
  if (!(confidence >= MIN_TITLE_CONFIDENCE)) return fileName;
  if (PLACEHOLDER_TITLE.test(label) || SAYS_NOTHING.test(label)) return fileName;
  return label.slice(0, 80);
}
