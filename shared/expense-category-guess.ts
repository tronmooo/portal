// ─── Expense category from its words ─────────────────────────────────────────
// ONE keyword → category classifier. It used to live inline in the chat's
// create_expense handler only, so "Dinner at Olive Garden" typed into the Add
// Expense form stayed on General while the same words in chat became Food
// (QA 2026-09-18 F-23). The chat and the form now suggest the same category.

const RULES: Array<{ category: string; re: RegExp }> = [
  { category: "pet", re: /vet|pet food|dog food|cat food|grooming|flea|treats|chewy/ },
  { category: "food", re: /groceries|restaurant|food|coffee|lunch|dinner|breakfast|brunch|pizza|burger|sandwich|sushi|taco|donut|latte|starbucks|mcdonald|chipotle|uber eats|doordash|olive garden|takeout|take-out/ },
  { category: "transport", re: /uber|lyft|\bgas\b|fuel|parking|toll|transit|\bbus\b|train|flight|airline/ },
  { category: "vehicle", re: /oil change|tire|car wash|mechanic|\bauto\b|vehicle|detailing/ },
  { category: "health", re: /doctor|pharmacy|\bcvs\b|walgreens|\bgym\b|dentist|hospital|medical|prescription|copay/ },
  { category: "subscription", re: /netflix|spotify|hulu|disney|apple music|youtube|subscription/ },
  { category: "housing", re: /\brent\b|mortgage|\bhoa\b/ },
  { category: "utilities", re: /electric|water bill|internet|phone|cable|utility|\batt\b|verizon|comcast/ },
  { category: "shopping", re: /amazon|walmart|target|clothes|shoes|electronics|bestbuy|apple store/ },
  { category: "entertainment", re: /movie|\bgame\b|concert|ticket|\bbar\b|drinks|bowling|arcade/ },
  { category: "education", re: /school|tuition|textbook|course|udemy/ },
  { category: "insurance", re: /insurance|geico|allstate|progressive|state farm/ },
];

/**
 * The category the words suggest, or null when nothing matches. Callers keep
 * their own default ("general") so a null never overwrites a user's choice.
 */
export function guessExpenseCategory(description: unknown, vendor?: unknown): string | null {
  const combined = `${String(description ?? "")} ${String(vendor ?? "")}`.toLowerCase();
  if (!combined.trim()) return null;
  for (const { category, re } of RULES) if (re.test(combined)) return category;
  return null;
}
