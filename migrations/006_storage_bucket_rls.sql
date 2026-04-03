-- Supabase Storage Bucket RLS Policies
-- Run in Supabase Dashboard > SQL Editor
-- This replaces path-based isolation with explicit RLS on storage.objects

-- Ensure the documents bucket exists
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;

-- Drop any existing policies to avoid conflicts
DROP POLICY IF EXISTS "documents_select_own" ON storage.objects;
DROP POLICY IF EXISTS "documents_insert_own" ON storage.objects;
DROP POLICY IF EXISTS "documents_update_own" ON storage.objects;
DROP POLICY IF EXISTS "documents_delete_own" ON storage.objects;

-- Users can only SELECT their own objects (path: {user_id}/*)
CREATE POLICY "documents_select_own" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'documents'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- Users can only INSERT into their own folder
CREATE POLICY "documents_insert_own" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'documents'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- Users can only UPDATE their own objects
CREATE POLICY "documents_update_own" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'documents'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- Users can only DELETE their own objects
CREATE POLICY "documents_delete_own" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'documents'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );
