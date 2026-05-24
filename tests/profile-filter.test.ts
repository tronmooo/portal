import { describe, it, expect } from 'vitest';
import {
  passesProfileFilter,
  selfInSelection,
  type ProfileFilterContext,
} from '../shared/profile-filter';

const PROFILES = [
  { id: 'self-1', type: 'self' },
  { id: 'spouse-1', type: 'spouse' },
  { id: 'kid-1', type: 'child' },
  { id: 'kid-2', type: 'child' },
  { id: 'pet-1', type: 'pet' },
];

function ctx(selectedIds: string[]): ProfileFilterContext {
  return { selectedIds, allProfiles: PROFILES };
}

describe('selfInSelection', () => {
  it('returns false when nothing is selected', () => {
    expect(selfInSelection(ctx([]))).toBe(false);
  });

  it('returns true when a self profile is selected', () => {
    expect(selfInSelection(ctx(['self-1']))).toBe(true);
    expect(selfInSelection(ctx(['kid-1', 'self-1']))).toBe(true);
  });

  it('returns false when only non-self profiles are selected', () => {
    expect(selfInSelection(ctx(['spouse-1', 'kid-1']))).toBe(false);
    expect(selfInSelection(ctx(['pet-1']))).toBe(false);
  });

  it('returns false when a selected id does not exist in allProfiles', () => {
    expect(selfInSelection(ctx(['ghost-id']))).toBe(false);
  });
});

describe('passesProfileFilter — no filter active', () => {
  it('passes everything when selectedIds is empty', () => {
    expect(passesProfileFilter([], ctx([]))).toBe(true);
    expect(passesProfileFilter(['kid-1'], ctx([]))).toBe(true);
    expect(passesProfileFilter(undefined, ctx([]))).toBe(true);
    expect(passesProfileFilter(null, ctx([]))).toBe(true);
  });
});

describe('passesProfileFilter — items with explicit links', () => {
  it('passes when any link matches any selected id', () => {
    expect(passesProfileFilter(['kid-1'], ctx(['kid-1']))).toBe(true);
    expect(passesProfileFilter(['kid-1', 'kid-2'], ctx(['kid-2']))).toBe(true);
  });

  it('rejects when no link matches any selected id', () => {
    expect(passesProfileFilter(['kid-1'], ctx(['kid-2']))).toBe(false);
    expect(passesProfileFilter(['spouse-1'], ctx(['kid-1', 'pet-1']))).toBe(false);
  });

  it('does not leak to "self" selection when item is linked elsewhere', () => {
    // Item is linked to kid-1 only; selecting self alone must not match it.
    expect(passesProfileFilter(['kid-1'], ctx(['self-1']))).toBe(false);
  });
});

describe('passesProfileFilter — orphan handling (the privacy-critical case)', () => {
  it('shows orphans only when the self profile is in the selection', () => {
    expect(passesProfileFilter([], ctx(['self-1']))).toBe(true);
    expect(passesProfileFilter(undefined, ctx(['self-1']))).toBe(true);
    expect(passesProfileFilter(null, ctx(['self-1']))).toBe(true);
  });

  it('hides orphans when only non-self profiles are selected', () => {
    expect(passesProfileFilter([], ctx(['spouse-1']))).toBe(false);
    expect(passesProfileFilter(undefined, ctx(['kid-1', 'pet-1']))).toBe(false);
    expect(passesProfileFilter(null, ctx(['spouse-1', 'kid-1']))).toBe(false);
  });

  it('shows orphans for mixed selections that include self', () => {
    expect(passesProfileFilter([], ctx(['self-1', 'kid-1']))).toBe(true);
  });
});

describe('passesProfileFilter — defensive input handling', () => {
  it('treats non-array linkedProfiles as orphan', () => {
    // Legacy rows stored as a non-array (e.g. JSON-parsed string) must not crash.
    expect(passesProfileFilter('kid-1' as unknown as string[], ctx(['kid-1']))).toBe(false);
    expect(passesProfileFilter('kid-1' as unknown as string[], ctx(['self-1']))).toBe(true);
  });
});
