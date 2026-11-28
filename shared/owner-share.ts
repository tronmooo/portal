// Adding (or changing) ONE owner's share in an owner set.
//
// "Add Robin as a co-owner of my drone with a 40% share": the drone already has
// its owner(s) at 100%. The new person gets the share asked for, and the
// existing owners keep their PROPORTIONS of what is left (me 100% → me 60%;
// me 50% + Sam 50% → me 30% + Sam 30%). The result always totals exactly 100.
// Chat used to add 40% on top of 100%, which the database guard refuses, so
// the request never worked on the first message (chat-tools scenarios,
// 2026-11-28: 0 of 7).
export interface Share { partyProfileId: string; ownershipPercentage: number }

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The owner set after giving `partyProfileId` exactly `pct` percent.
 * `current` is the stored owner set (owner roles only); `fallbackOwnerId` is who
 * owns the rest when nobody is stored yet (the account holder).
 */
export function withOwnerShare(current: Share[], partyProfileId: string, pct: number, fallbackOwnerId: string | null): Share[] {
  const share = Math.min(100, Math.max(0, r2(Number(pct))));
  if (!Number.isFinite(share)) throw new Error("A share must be a number from 0 to 100");
  const others = current.filter((o) => o.partyProfileId !== partyProfileId && Number(o.ownershipPercentage) > 0);
  const rest = r2(100 - share);
  let scaled: Share[];
  if (others.length === 0) {
    scaled = rest > 0 && fallbackOwnerId && fallbackOwnerId !== partyProfileId ? [{ partyProfileId: fallbackOwnerId, ownershipPercentage: rest }] : [];
  } else {
    const total = others.reduce((s, o) => s + Number(o.ownershipPercentage), 0);
    scaled = others.map((o) => ({ partyProfileId: o.partyProfileId, ownershipPercentage: r2((Number(o.ownershipPercentage) / total) * rest) }));
    // put any rounding remainder on the largest other share, so the set totals 100 exactly
    const drift = r2(rest - scaled.reduce((s, o) => s + o.ownershipPercentage, 0));
    if (drift !== 0 && scaled.length) {
      const big = scaled.reduce((a, b) => (b.ownershipPercentage > a.ownershipPercentage ? b : a));
      big.ownershipPercentage = r2(big.ownershipPercentage + drift);
    }
  }
  const out = [...scaled.filter((o) => o.ownershipPercentage > 0), ...(share > 0 ? [{ partyProfileId, ownershipPercentage: share }] : [])];
  // nobody left at all (a 0% share for the only owner): the fallback owns it
  if (out.length === 0 && fallbackOwnerId) return [{ partyProfileId: fallbackOwnerId, ownershipPercentage: 100 }];
  return out;
}
