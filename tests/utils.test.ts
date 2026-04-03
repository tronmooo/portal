import { describe, it, expect } from 'vitest';

// Test the expense category inference logic (extracted from ai-engine)
function inferExpenseCategory(description: string, vendor: string): string {
  const combined = `${description} ${vendor}`.toLowerCase();
  if (/vet|pet food|dog food|cat food|grooming|flea|treats|chewy/.test(combined)) return "pet";
  if (/groceries|restaurant|food|coffee|lunch|dinner|breakfast|pizza|burger|sandwich|sushi|taco|donut|latte|starbucks|mcdonald|chipotle|uber eats|doordash/.test(combined)) return "food";
  if (/uber|lyft|gas|fuel|parking|toll|transit|bus|train|flight|airline/.test(combined)) return "transport";
  if (/oil change|tire|car wash|mechanic|auto|vehicle|detailing/.test(combined)) return "vehicle";
  if (/doctor|pharmacy|cvs|walgreens|gym|dentist|hospital|medical|prescription|copay/.test(combined)) return "health";
  if (/netflix|spotify|hulu|disney|apple music|youtube|subscription/.test(combined)) return "subscription";
  if (/rent|mortgage|hoa/.test(combined)) return "housing";
  if (/electric|water|internet|phone|cable|utility|att|verizon|comcast/.test(combined)) return "utilities";
  if (/amazon|walmart|target|clothes|shoes|electronics|bestbuy|apple store/.test(combined)) return "shopping";
  if (/movie|game|concert|ticket|bar|drinks|bowling|arcade/.test(combined)) return "entertainment";
  if (/school|tuition|textbook|course|udemy/.test(combined)) return "education";
  if (/insurance|geico|allstate|progressive|state farm/.test(combined)) return "insurance";
  return "general";
}

describe('Expense Category Inference', () => {
  it('classifies food correctly', () => {
    expect(inferExpenseCategory('Lunch at restaurant', '')).toBe('food');
    expect(inferExpenseCategory('Coffee', 'Starbucks')).toBe('food');
    expect(inferExpenseCategory('Pizza delivery', 'Dominos')).toBe('food');
    expect(inferExpenseCategory('Groceries', 'Walmart')).toBe('food');
  });

  it('classifies transport correctly', () => {
    expect(inferExpenseCategory('Uber to airport', '')).toBe('transport');
    expect(inferExpenseCategory('Gas fill-up', 'Shell')).toBe('transport');
    expect(inferExpenseCategory('Parking downtown', '')).toBe('transport');
  });

  it('classifies pet correctly', () => {
    expect(inferExpenseCategory('Vet visit', '')).toBe('pet');
    expect(inferExpenseCategory('Dog food', 'Chewy')).toBe('pet');
    expect(inferExpenseCategory('Grooming for Rex', '')).toBe('pet');
  });

  it('classifies vehicle correctly', () => {
    expect(inferExpenseCategory('Oil change', 'Jiffy Lube')).toBe('vehicle');
    expect(inferExpenseCategory('New tires', '')).toBe('vehicle');
    expect(inferExpenseCategory('Car wash', '')).toBe('vehicle');
  });

  it('classifies health correctly', () => {
    expect(inferExpenseCategory('Doctor copay', '')).toBe('health');
    expect(inferExpenseCategory('Prescription', 'CVS')).toBe('health');
    expect(inferExpenseCategory('Gym membership', '')).toBe('health');
  });

  it('classifies subscription correctly', () => {
    expect(inferExpenseCategory('Netflix subscription', '')).toBe('subscription');
    expect(inferExpenseCategory('Spotify premium', '')).toBe('subscription');
  });

  it('classifies housing correctly', () => {
    expect(inferExpenseCategory('Rent payment', '')).toBe('housing');
    expect(inferExpenseCategory('Mortgage', 'Wells Fargo')).toBe('housing');
  });

  it('falls back to general for unknown', () => {
    expect(inferExpenseCategory('Random thing', '')).toBe('general');
    expect(inferExpenseCategory('Misc purchase', 'Some Store')).toBe('general');
  });
});

describe('Date Formatting', () => {
  it('creates YYYY-MM-DD from Date', () => {
    const d = new Date(2026, 3, 15); // April 15, 2026
    const str = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(str).toBe('2026-04-15');
  });
});
