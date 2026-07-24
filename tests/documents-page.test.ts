import { describe, it, expect, beforeEach } from 'vitest';
import { MemStorage } from '../server/storage';

// [PERF Phase 4] Regression tests for the server-side paginated documents path
// (storage.getDocumentsPage). Guards the /api/documents pushdown contract:
// created_at-desc ordering, limit/offset windowing, exact total independent of
// the range, metadata-only rows (no fileData), and the NON-orphan half of the
// profile containment filter. Uses MemStorage (no Supabase mock needed); its
// getDocumentsPage is a byte-for-byte parity mirror of the DB path.

// createDocument hardcodes createdAt=now, so set a deterministic timestamp via
// updateDocument (which merges {...doc, ...data}) to control ordering.
async function makeDoc(
  store: MemStorage,
  name: string,
  createdAt: string,
  opts: { linkedProfiles?: string[]; fileData?: string } = {},
) {
  const doc = await store.createDocument({
    name,
    type: 'other',
    linkedProfiles: opts.linkedProfiles || [],
    fileData: opts.fileData || '',
  });
  const updated = await store.updateDocument(doc.id, { createdAt } as any);
  return updated!;
}

describe('getDocumentsPage — pagination + contract', () => {
  let store: MemStorage;

  beforeEach(async () => {
    store = new MemStorage();
    // 5 docs, ascending creation time d1..d5 (d5 newest).
    for (let i = 1; i <= 5; i++) {
      await makeDoc(store, `d${i}`, `2026-01-0${i}T00:00:00.000Z`);
    }
  });

  it('orders by created_at descending', async () => {
    const { rows } = await store.getDocumentsPage();
    expect(rows.map(r => r.name)).toEqual(['d5', 'd4', 'd3', 'd2', 'd1']);
  });

  it('total is the full match count, independent of the range window', async () => {
    const { rows, total } = await store.getDocumentsPage({ limit: 2, offset: 0 });
    expect(total).toBe(5);
    expect(rows).toHaveLength(2);
  });

  it('windows correctly with limit + offset', async () => {
    const page1 = await store.getDocumentsPage({ limit: 2, offset: 0 });
    const page2 = await store.getDocumentsPage({ limit: 2, offset: 2 });
    const page3 = await store.getDocumentsPage({ limit: 2, offset: 4 });
    expect(page1.rows.map(r => r.name)).toEqual(['d5', 'd4']);
    expect(page2.rows.map(r => r.name)).toEqual(['d3', 'd2']);
    expect(page3.rows.map(r => r.name)).toEqual(['d1']);
    expect(page3.total).toBe(5);
  });

  it('offset past the end returns no rows but the true total', async () => {
    const { rows, total } = await store.getDocumentsPage({ limit: 10, offset: 100 });
    expect(rows).toHaveLength(0);
    expect(total).toBe(5);
  });

  it('offset with no explicit limit skips the leading rows and keeps the rest', async () => {
    const { rows, total } = await store.getDocumentsPage({ offset: 3 });
    expect(rows.map(r => r.name)).toEqual(['d2', 'd1']);
    expect(total).toBe(5);
  });

  it('strips fileData from list rows', async () => {
    const s = new MemStorage();
    await makeDoc(s, 'withBlob', '2026-02-01T00:00:00.000Z', { fileData: 'AAAA'.repeat(1000) });
    const { rows } = await s.getDocumentsPage();
    expect(rows).toHaveLength(1);
    expect(rows[0].fileData).toBe('');
  });
});

describe('getDocumentsPage — profile containment (non-orphan half)', () => {
  let store: MemStorage;

  beforeEach(async () => {
    store = new MemStorage();
    await makeDoc(store, 'alice', '2026-03-01T00:00:00.000Z', { linkedProfiles: ['pA'] });
    await makeDoc(store, 'bob', '2026-03-02T00:00:00.000Z', { linkedProfiles: ['pB'] });
    await makeDoc(store, 'both', '2026-03-03T00:00:00.000Z', { linkedProfiles: ['pA', 'pB'] });
    await makeDoc(store, 'orphan', '2026-03-04T00:00:00.000Z', { linkedProfiles: [] });
  });

  it('filters to docs whose linkedProfiles contain a selected id', async () => {
    const { rows, total } = await store.getDocumentsPage({ profileIds: ['pA'] });
    expect(rows.map(r => r.name).sort()).toEqual(['alice', 'both']);
    expect(total).toBe(2);
  });

  it('does NOT include orphan (empty linkedProfiles) docs — orphan inclusion stays on the fetch-all path', async () => {
    const { rows } = await store.getDocumentsPage({ profileIds: ['pA', 'pB'] });
    expect(rows.map(r => r.name)).not.toContain('orphan');
    expect(rows.map(r => r.name).sort()).toEqual(['alice', 'bob', 'both']);
  });

  it('empty profileIds (everyone-mode) returns all docs including orphans', async () => {
    const { rows, total } = await store.getDocumentsPage();
    expect(total).toBe(4);
    expect(rows.map(r => r.name)).toContain('orphan');
  });

  it('combines containment filter with range + exact total', async () => {
    const { rows, total } = await store.getDocumentsPage({ profileIds: ['pA'], limit: 1, offset: 0 });
    // both (03-03) is newer than alice (03-01) → desc order puts it first.
    expect(rows.map(r => r.name)).toEqual(['both']);
    expect(total).toBe(2);
  });
});
