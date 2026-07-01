import { describe, it, expect } from 'vitest';
import {
  insertTaskSchema,
  insertExpenseSchema,
  insertHabitSchema,
  insertObligationSchema,
  insertEventSchema,
  insertDocumentSchema,
} from '../shared/schema';

describe('Schema Validation', () => {
  describe('insertTaskSchema', () => {
    it('accepts valid task with required fields only', () => {
      const result = insertTaskSchema.safeParse({ title: 'Test task' });
      expect(result.success).toBe(true);
    });

    it('rejects empty title', () => {
      const result = insertTaskSchema.safeParse({ title: '' });
      expect(result.success).toBe(false);
    });

    it('defaults linkedProfiles to empty array', () => {
      const result = insertTaskSchema.parse({ title: 'Test' });
      expect(result.linkedProfiles).toEqual([]);
    });

    it('defaults tags to empty array', () => {
      const result = insertTaskSchema.parse({ title: 'Test' });
      expect(result.tags).toEqual([]);
    });

    it('accepts all optional fields', () => {
      const result = insertTaskSchema.safeParse({
        title: 'Full task',
        description: 'A description',
        priority: 'high',
        dueDate: '2026-04-15',
        tags: ['urgent'],
        linkedProfiles: ['abc-123'],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('insertExpenseSchema', () => {
    it('accepts valid expense', () => {
      const result = insertExpenseSchema.safeParse({
        amount: 25.50,
        description: 'Lunch',
      });
      expect(result.success).toBe(true);
    });

    it('rejects negative amount', () => {
      const result = insertExpenseSchema.safeParse({
        amount: -5,
        description: 'Bad',
      });
      expect(result.success).toBe(false);
    });

    it('defaults category to general', () => {
      const result = insertExpenseSchema.parse({
        amount: 10,
        description: 'Test',
      });
      expect(result.category).toBe('general');
    });

    it('rejects an absurdly large amount (MAX_MONEY cap)', () => {
      // Audit found the API accepted a $1e15 expense — must be capped.
      expect(insertExpenseSchema.safeParse({ amount: 1e15, description: 'Huge' }).success).toBe(false);
      expect(insertExpenseSchema.safeParse({ amount: 1_000_000_000, description: 'Fine' }).success).toBe(true);
    });
  });

  describe('insertHabitSchema', () => {
    it('accepts valid habit with name only', () => {
      const result = insertHabitSchema.safeParse({ name: 'Meditate' });
      expect(result.success).toBe(true);
    });

    it('defaults frequency to daily', () => {
      const result = insertHabitSchema.parse({ name: 'Exercise' });
      expect(result.frequency).toBe('daily');
    });

    it('defaults targetPerDay to 1', () => {
      const result = insertHabitSchema.parse({ name: 'Brush teeth' });
      expect(result.targetPerDay).toBe(1);
    });

    it('accepts targetPerDay up to 10', () => {
      const result = insertHabitSchema.safeParse({ name: 'Water', targetPerDay: 8 });
      expect(result.success).toBe(true);
    });

    it('rejects targetPerDay over 10', () => {
      const result = insertHabitSchema.safeParse({ name: 'Too many', targetPerDay: 11 });
      expect(result.success).toBe(false);
    });
  });

  describe('insertObligationSchema', () => {
    it('accepts valid obligation', () => {
      const result = insertObligationSchema.safeParse({
        name: 'Rent',
        amount: 1500,
        nextDueDate: '2026-05-01',
      });
      expect(result.success).toBe(true);
    });

    it('defaults frequency to monthly', () => {
      const result = insertObligationSchema.parse({
        name: 'Netflix',
        amount: 15.99,
        nextDueDate: '2026-04-15',
      });
      expect(result.frequency).toBe('monthly');
    });
  });

  describe('insertEventSchema', () => {
    it('accepts valid event', () => {
      const result = insertEventSchema.safeParse({
        title: 'Meeting',
        date: '2026-04-10',
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing date', () => {
      const result = insertEventSchema.safeParse({ title: 'No date' });
      expect(result.success).toBe(false);
    });

    // 2026-06-25: a "daily standup on weekdays" used to fail because the event
    // recurrence enum lacked weekdays/weekends (habits had them, events didn't).
    it('accepts weekdays/weekends recurrence', () => {
      for (const recurrence of ['weekdays', 'weekends', 'daily', 'weekly', 'monthly', 'yearly', 'none']) {
        const r = insertEventSchema.safeParse({ title: 'Standup', date: '2026-06-29', recurrence });
        expect(r.success).toBe(true);
      }
    });

    it('still rejects an unknown recurrence value', () => {
      const r = insertEventSchema.safeParse({ title: 'x', date: '2026-06-29', recurrence: 'fortnightly' });
      expect(r.success).toBe(false);
    });
  });

  describe('insertDocumentSchema', () => {
    it('accepts valid document', () => {
      const result = insertDocumentSchema.safeParse({
        name: 'Drivers License',
        type: 'drivers_license',
        mimeType: 'image/jpeg',
        fileData: 'base64data',
      });
      expect(result.success).toBe(true);
    });
  });
});
