-- =====================================================================
-- Trading Dashboard - Supabase schema
-- Run this in Supabase SQL Editor (Project → SQL Editor → New query → paste → Run)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Accounts (one row per broker account)
-- ---------------------------------------------------------------------
create table if not exists accounts (
  tag            text primary key,            -- "FTMO" | "PEPPERSTONE"
  login          bigint,
  server         text,
  currency       text,
  last_seen      timestamptz,
  last_balance   numeric,
  last_equity    numeric,
  last_margin    numeric,
  last_free      numeric,
  last_profit    numeric,
  created_at     timestamptz default now()
);

-- ---------------------------------------------------------------------
-- Snapshots (one row per EA push)
-- ---------------------------------------------------------------------
create table if not exists snapshots (
  id             bigserial primary key,
  account_tag    text not null references accounts(tag) on delete cascade,
  ts             timestamptz not null,
  balance        numeric not null,
  equity         numeric not null,
  margin         numeric,
  free_margin    numeric,
  profit         numeric,
  open_count     int,
  inserted_at    timestamptz default now()
);
create index if not exists snapshots_acct_ts_idx on snapshots (account_tag, ts desc);

-- ---------------------------------------------------------------------
-- Open positions (truncated + reinserted per snapshot)
-- ---------------------------------------------------------------------
create table if not exists positions (
  id             bigserial primary key,
  account_tag    text not null references accounts(tag) on delete cascade,
  snapshot_ts    timestamptz not null,
  ticket         bigint not null,
  symbol         text not null,
  side           int not null,                -- 0=buy, 1=sell
  volume         numeric not null,
  open_price     numeric,
  current_price  numeric,
  sl             numeric,
  tp             numeric,
  magic          bigint,
  comment        text,
  profit         numeric,
  swap           numeric,
  open_time      timestamptz,
  ea             text,                        -- "V5+" | "V52" | "OTHER"
  inserted_at    timestamptz default now()
);
create index if not exists positions_acct_ts_idx on positions (account_tag, snapshot_ts desc);
create index if not exists positions_ea_idx       on positions (ea);

-- ---------------------------------------------------------------------
-- Closed deals (append-only; dedup by (account_tag, deal_id))
-- ---------------------------------------------------------------------
create table if not exists deals (
  id             bigserial primary key,
  account_tag    text not null references accounts(tag) on delete cascade,
  deal_id        bigint not null,
  symbol         text not null,
  side           int not null,
  volume         numeric not null,
  price          numeric,
  profit         numeric,
  swap           numeric,
  commission     numeric,
  magic          bigint,
  comment        text,
  closed_at      timestamptz,
  ea             text,
  inserted_at    timestamptz default now(),
  unique (account_tag, deal_id)
);
create index if not exists deals_acct_closed_idx on deals (account_tag, closed_at desc);
create index if not exists deals_ea_idx          on deals (ea);

-- ---------------------------------------------------------------------
-- Pruning helper: drop snapshots/positions older than 30 days.
-- Closed deals are kept indefinitely (small).
-- Run from a scheduled function or cron extension, OR call manually
-- via the Vercel receiver every Nth push.
-- ---------------------------------------------------------------------
create or replace function prune_old_snapshots()
returns void language plpgsql as $$
begin
  delete from snapshots where ts < now() - interval '30 days';
  delete from positions where snapshot_ts < now() - interval '30 days';
end;
$$;

-- =====================================================================
-- Sanity check
-- =====================================================================
-- select 'OK schema created' as status;
