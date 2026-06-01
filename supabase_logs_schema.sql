-- =====================================================================
-- Add ea_logs table for storing EA heartbeat / status messages
-- Run in Supabase → SQL Editor → New query → paste → Run
-- =====================================================================

create table if not exists ea_logs (
  id             bigserial primary key,
  account_tag    text not null,
  ea             text not null,
  message        text not null,
  ts             timestamptz not null default now(),
  inserted_at    timestamptz default now()
);
create index if not exists ea_logs_acct_ea_ts_idx on ea_logs (account_tag, ea, ts desc);
create index if not exists ea_logs_ts_idx         on ea_logs (ts desc);

-- Prune helper: keep last 24h of logs only (they pile up fast)
create or replace function prune_old_logs()
returns void language plpgsql as $$
begin
  delete from ea_logs where ts < now() - interval '24 hours';
end;
$$;
