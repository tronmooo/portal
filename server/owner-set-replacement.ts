export interface OwnerSetRecord {
  id: string;
  partyProfileId: string;
  ownershipPercentage: number;
  role?: string | null;
}

export interface OwnerSetOperations<T extends OwnerSetRecord> {
  load: () => Promise<T[]>;
  remove: (row: T) => Promise<boolean>;
  updatePercentage: (row: T, ownershipPercentage: number) => Promise<T | undefined>;
  create: (target: T) => Promise<T>;
}

function ownerRole(role: string | null | undefined): boolean {
  const normalized = (role || "owner").toLowerCase();
  return normalized === "owner" || normalized === "co_owner" || normalized === "co-owner";
}

function ownersOnly<T extends OwnerSetRecord>(rows: T[]): T[] {
  return rows.filter((row) => ownerRole(row.role));
}

async function reconcileOwnerSet<T extends OwnerSetRecord>(
  targetRows: T[],
  operations: OwnerSetOperations<T>,
): Promise<void> {
  const targetByParty = new Map(targetRows.map((row) => [row.partyProfileId, row]));

  // Deletes can redistribute the shares of surviving rows. Always reload after
  // them instead of comparing later phases with a stale pre-delete snapshot.
  let current = ownersOnly(await operations.load());
  for (const row of current) {
    if (!targetByParty.has(row.partyProfileId)) {
      if (!await operations.remove(row)) {
        throw new Error(`Owner link ${row.id} disappeared during replacement`);
      }
    }
  }

  current = ownersOnly(await operations.load());
  let currentByParty = new Map(current.map((row) => [row.partyProfileId, row]));
  for (const target of targetRows) {
    const row = currentByParty.get(target.partyProfileId);
    if (row && Number(target.ownershipPercentage) < Number(row.ownershipPercentage)) {
      if (!await operations.updatePercentage(row, target.ownershipPercentage)) {
        throw new Error(`Owner link ${row.id} disappeared during replacement`);
      }
    }
  }

  // Reload between the lowering and raising phases as well: storage hooks may
  // normalize or redistribute percentages while applying an earlier write.
  current = ownersOnly(await operations.load());
  currentByParty = new Map(current.map((row) => [row.partyProfileId, row]));
  for (const target of targetRows) {
    const row = currentByParty.get(target.partyProfileId);
    if (row && Number(target.ownershipPercentage) > Number(row.ownershipPercentage)) {
      if (!await operations.updatePercentage(row, target.ownershipPercentage)) {
        throw new Error(`Owner link ${row.id} disappeared during replacement`);
      }
    }
  }

  current = ownersOnly(await operations.load());
  currentByParty = new Map(current.map((row) => [row.partyProfileId, row]));
  for (const target of targetRows) {
    if (!currentByParty.has(target.partyProfileId)) {
      await operations.create(target);
    }
  }
}

/**
 * Replace an ownership set using guardrail-safe phases. If any phase fails,
 * reconcile back to the complete pre-write snapshot before rethrowing.
 *
 * This is application-level compensation rather than a database transaction:
 * a second independent database failure can still prevent rollback, in which
 * case the thrown error reports both failures.
 */
export async function replaceOwnerSetWithRollback<T extends OwnerSetRecord>(
  desired: T[],
  operations: OwnerSetOperations<T>,
): Promise<void> {
  const snapshot = ownersOnly(await operations.load()).map((row) => ({ ...row }));
  try {
    await reconcileOwnerSet(desired, operations);
  } catch (writeError) {
    try {
      await reconcileOwnerSet(snapshot, operations);
    } catch (rollbackError) {
      const error = new Error(
        `Owner replacement failed and rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
      (error as any).cause = writeError;
      (error as any).rollbackError = rollbackError;
      throw error;
    }
    throw writeError;
  }
}
