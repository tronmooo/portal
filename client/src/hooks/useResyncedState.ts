import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/**
 * `useState` seeded from a prop, re-seeded whenever the record it belongs to
 * changes.
 *
 * A tab component on the profile page is NOT remounted when the route moves
 * from one profile id to the next — React keeps the same instance and just
 * hands it new props. A plain `useState(profile.notes)` therefore runs its
 * initializer once, for the first profile, and every later profile inherits
 * that draft: pressing Save on profile B wrote A's notes into B (the ST8 fix
 * in EditProfileDialog closed the same hole with an ad-hoc effect).
 *
 * `resetKey` is the identity of the record (the profile id); the state is
 * re-seeded from `seed` when it changes, and also when `seed` itself changes
 * while the form is not being edited (a refetch or an AI write landed) so the
 * user never starts from a stale draft. A draft in progress is never clobbered.
 */
export function useResyncedState<T>(
  seed: T,
  resetKey: unknown,
  editing = false,
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(seed);
  // Identity change: always re-seed, even mid-edit — the draft belonged to the
  // previous record and must not leak into this one.
  useEffect(() => { setState(seed); }, [resetKey]);
  // Seed change on the same record: only take it when there is no draft.
  useEffect(() => { if (!editing) setState(seed); }, [seed]);
  return [state, setState];
}
