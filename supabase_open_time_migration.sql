-- =====================================================================
-- Migration: add opened_at to deals so dashboard can show open + close times
-- Run this in Supabase SQL Editor.
-- =====================================================================
alter table deals add column if not exists opened_at timestamptz;

-- Existing rows have opened_at = NULL until the EA repushes with the new field.
-- The dashboard renders "-" for null opened_at, so old rows display gracefully.
