-- =====================================================================
-- Migration: add reset_at to accounts so dashboard can hide pre-reset data
-- Run this in Supabase SQL Editor.
-- =====================================================================
alter table accounts add column if not exists reset_at timestamptz;

-- Existing accounts start with reset_at = NULL (no filter applied)
-- When a reset is triggered via /api/reset, reset_at is set to NOW()
-- and dashboard queries filter by ts/closed_at/snapshot_ts >= reset_at.
