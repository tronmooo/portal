-- Migration 011: covering indexes for unindexed foreign keys
-- (Supabase performance advisor, 2026-06-10). Matters at scale: without
-- these, deletes/updates on the referenced tables (documents, profiles,
-- obligation_payments) trigger sequential scans of the referencing tables.
CREATE INDEX IF NOT EXISTS idx_documents_superseded_by ON public.documents (superseded_by) WHERE superseded_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_extraction_corrections_document_id ON public.extraction_corrections (document_id);
CREATE INDEX IF NOT EXISTS idx_extraction_corrections_user_id ON public.extraction_corrections (user_id);
CREATE INDEX IF NOT EXISTS idx_liability_payments_document_id ON public.liability_payments (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_net_worth_snapshots_profile_id ON public.net_worth_snapshots (profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_obligation_occurrences_payment_id ON public.obligation_occurrences (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_profile_id ON public.reminders (profile_id) WHERE profile_id IS NOT NULL;
