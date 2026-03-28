# Backend & Database Audit — Portol

## Executive Summary
The data model has 6 critical structural flaws that will cause data integrity failures in production, 4 schema mismatches between TypeScript types and SQL that will cause runtime errors today, and multiple design choices that prevent the frontend from working as intended.

## Phase 1 — Fix Active Runtime Failures (Immediate)
1. Fix journal mood CHECK constraint
2. Add parent_profile_id column
3. Fix goals.tracker_id and goals.habit_id types (TEXT → UUID with FK)
4. Add obligations.status column
5. Add UNIQUE(habit_id, date) on habit_checkins
6. Add UNIQUE(user_id, key) on memories

## Phase 2 — Schema Hardening
- Add updated_at to all mutable tables
- Add created_at to obligation_payments
- Convert TEXT date columns to DATE
- Add missing indexes
- Fix user_id consistency on child tables

## Phase 3 — Relationship Model Migration (JSONB → Junction Tables)
- Create all junction tables
- Migrate existing JSONB data
- Update storage layer
- Remove JSONB link columns
- Update RLS policies

## Phase 4 — Streak & Goal Computation
- Remove habits.current_streak (compute on-read)
- Add goal auto-progress hook

## Phase 5 — Document Storage Migration
- Move base64 file_data to Supabase Storage
- Store storage_path only

## Phase 6 — Entity Deduplication
- Resolve subscription/loan ProfileType vs obligations ambiguity
