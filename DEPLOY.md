# Dashboard Deployment Guide

Everything you need to get the live FTMO + Pepperstone dashboard online. Free tier on Vercel + Supabase. ~30 minutes total.

## What you're building

```
[VPS: MT5 + Telemetry EA] --POST every 30s--> [Vercel /api/ingest] --> [Supabase DB]
                                                                              |
                                                  [Vercel dashboard page] ----+
                                                            ^
                                                            |
                                                  [Your phone / laptop]
```

The Telemetry EA runs on each VPS and pushes account state to your Vercel app, which stores it in Supabase. You open the dashboard URL from any browser — no terminal needed.

---

## Step 1 — Create Supabase project (5 min)

1. Go to https://supabase.com → Sign up (GitHub login is fastest).
2. New project:
   - Name: `trading-dashboard`
   - DB password: pick anything strong, save it (you won't need it day-to-day).
   - Region: pick closest to your VPS region.
   - Plan: Free.
3. Wait ~1 min for provisioning.
4. Once ready: left sidebar → **SQL Editor** → **New query**.
5. Paste the entire contents of `supabase_schema.sql` (in this folder) and click **Run**. Should see "Success. No rows returned."
6. Left sidebar → **Project Settings** → **API**. Copy these three values, you'll need them:
   - **Project URL** (e.g. `https://abcd1234.supabase.co`)
   - **anon public** key
   - **service_role** key (click the eye icon to reveal — keep this secret)

---

## Step 2 — Push this folder to GitHub (5 min)

Vercel deploys from a Git repo. If you don't have a GitHub repo yet:

```
cd C:\RD11\trading_system\dashboard
git init
git add .
git commit -m "Initial dashboard"
```

Create a private repo on GitHub.com (e.g. `trading-dashboard`), then:

```
git remote add origin https://github.com/<you>/trading-dashboard.git
git branch -M main
git push -u origin main
```

---

## Step 3 — Deploy to Vercel (5 min)

1. Go to https://vercel.com → Sign up with GitHub.
2. **Add New Project** → import your `trading-dashboard` repo.
3. Framework: Next.js (auto-detected).
4. Before clicking Deploy, expand **Environment Variables** and add:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | the Project URL from Step 1.6 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the anon public key from Step 1.6 |
| `SUPABASE_SERVICE_ROLE_KEY` | the service_role key from Step 1.6 |
| `INGEST_TOKEN` | a long random string (e.g. `openssl rand -hex 32`). Save this — the EA needs it. |
| `PRUNE_EVERY_N_PUSHES` | `200` |

5. Click **Deploy**. Takes 1-2 min.
6. After it deploys, you'll get a URL like `https://trading-dashboard-xyz.vercel.app`. Open it — you should see the dashboard with "No telemetry yet."
7. Verify the ingest endpoint works: open `https://trading-dashboard-xyz.vercel.app/api/ingest` in a browser — should return `{"ok":true,"hint":"POST telemetry payloads here"}`.

---

## Step 4 — Wire up the Telemetry EA on each VPS (10 min)

### 4.1 Copy the EA to each MT5 install

The file `C:\RD11\trading_system\Telemetry_V1.mq5` is the EA. Copy it into each MT5 terminal's `MQL5\Experts\TradingSystem\` folder:

- **FTMO VPS:** `<FTMO_HASH>\MQL5\Experts\TradingSystem\Telemetry_V1.mq5`
- **Pepperstone VPS:** `<PEPP_HASH>\MQL5\Experts\TradingSystem\Telemetry_V1.mq5`

(If your trading EAs are already running on the MetaTrader Virtual Hosting cloud, you'll do this on your local MT5 install and then re-migrate to the VPS.)

### 4.2 Compile the EA

In MetaEditor: F4 → open `Telemetry_V1.mq5` → F7 to compile. Should be "0 errors, 0 warnings".

### 4.3 Allow the webhook URL in MT5

On each terminal: **Tools → Options → Expert Advisors → Allow WebRequest for listed URL** → add your Vercel URL (origin only, e.g. `https://trading-dashboard-xyz.vercel.app`). Tick the checkbox. OK.

> If you skip this, the EA's first WebRequest call returns -1 and logs "URL not in allow-list".

### 4.4 Attach the EA to a chart

The Telemetry EA reads **all** open positions and account-level state — it doesn't care which symbol's chart it's attached to. Just pick one chart per terminal (e.g. EURUSD H1) and drag the EA on.

Inputs to set:

- **Inp_WebhookURL:** `https://trading-dashboard-xyz.vercel.app/api/ingest` (your Vercel URL + `/api/ingest`)
- **Inp_AuthToken:** the same `INGEST_TOKEN` you set on Vercel
- **Inp_AccountTag:** `FTMO` on the FTMO terminal, `PEPPERSTONE` on the Pepperstone terminal
- **Inp_IntervalSec:** `30` (default)

Make sure AutoTrading is on (the EA uses WebRequest, not trade calls, so AlgoTrading-off would still let it log but won't fire WebRequest in some MT5 builds — safest to leave AlgoTrading on for the telemetry chart).

### 4.5 Re-migrate to MetaTrader Virtual Hosting

If you're using MQ's cloud VPS, repeat your migration step so the VPS gets the new EA attached to a chart. The WebRequest allow-list IS carried over by the migrate command.

### 4.6 Watch the journal

You should see lines like:
```
TELE: Telemetry started. URL=https://... tag=FTMO interval=30s
TELE: snapshot ok http=200 sent=1 failed=0 bytes=987
```

Every ~10 minutes you'll get another "snapshot ok" line (the EA logs every 20th push to avoid spam — actual pushes happen every 30s).

---

## Step 5 — Open the dashboard

Open your Vercel URL on your laptop or phone. Within 30 seconds of attaching the EA you should see:

- Status dot turns green
- Equity / balance / floating populated
- Positions and recent deals appear
- Equity chart starts building (sparse at first; full curve fills in over 24h)

Bookmark the URL on your phone home screen.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard says "No telemetry yet" | Check MT5 Journal for `TELE:` lines. If you see "WebRequest FAILED err=4060" the URL isn't in allow-list. |
| `auth` errors in Vercel logs | `INGEST_TOKEN` env var doesn't match `Inp_AuthToken` on the EA. |
| Dashboard loads but accounts don't update | Vercel logs (`/api/ingest`) will show the error. Most common: Supabase env vars wrong. |
| Free Supabase project paused | Your VPS was down for 7+ days. Go to Supabase dashboard → restore the project (1 click). |
| Mobile shows different time than expected | All times in UTC. Local browser timezone is used for display only. |

---

## What's portable

If Vercel/Supabase change their pricing, you can:

- **Vercel** → swap for Cloudflare Pages, Railway, or self-host. Code is plain Next.js.
- **Supabase** → swap for any Postgres (self-hosted, Neon, etc.). The schema file works as-is.

You're not locked in.

---

## Costs

- Vercel Hobby: **$0/mo** (your usage is well below limits)
- Supabase Free: **$0/mo** (with 30-day prune, DB stays well under 500 MB)
- Total: **$0/mo**

If you exceed: Vercel Pro $20/mo, Supabase Pro $25/mo. Neither is likely for a personal dashboard.

---

## Reset for a new broker account (2026-06-02)

When you swap to a fresh FTMO (or Pepperstone) login but keep the same EA `account_tag`,
the dashboard would otherwise still show the old account's history.

### One-time setup

1. **Run the migration** (Supabase SQL Editor):
   ```sql
   alter table accounts add column if not exists reset_at timestamptz;
   ```
2. **Add a Vercel env var** (Project Settings → Environment Variables):
   - `RESET_TOKEN` = some long random string (this protects the reset endpoint)
   - Redeploy after adding.

### How to reset

In the dashboard header you'll now see two buttons next to each account:

- **Reset** — sets `accounts.reset_at = now()`. All `snapshots`, `deals`, `positions`,
  and `ea_logs` older than that moment are HIDDEN from queries but stay in the database.
  Reversible by manually setting `reset_at = null` in Supabase.
- **Reset+Wipe** — same, but ALSO physically deletes the old rows. Irreversible. Frees
  storage on the Supabase free tier.

Both prompt for the `RESET_TOKEN` value (typed into a confirm dialog, not stored).

### Manual reset (no UI)

```bash
curl -X POST https://your-dashboard.vercel.app/api/reset \
  -H "x-reset-token: YOUR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"tag":"FTMO","clear":false}'
```

Returns `{ ok: true, tag: "FTMO", reset_at: "2026-06-02T15:23:00.000Z", cleared: false, deleted: {} }`.

---

## Show deal open + close time (2026-06-02)

If you want the "Recent closed deals" table to also show when each deal was
opened (currently shows only close time), run this Supabase migration and
push the Telemetry EA patch:

```sql
alter table deals add column if not exists opened_at timestamptz;
```

The Telemetry EA needs to send `opened_at` per deal (looked up via
`HistorySelectByPosition` on the deal's position ID). Until that EA patch
is deployed, the `Opened` column shows "-" for existing rows — no harm,
just informational.
