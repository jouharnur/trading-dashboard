import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
};

export async function GET() {
  const db = supabaseAdmin();

  const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const since7d  = new Date(Date.now() -  7 * 24 * 3600 * 1000).toISOString();
  const since24h = new Date(Date.now() -  1 * 24 * 3600 * 1000).toISOString();

  const accounts = (await db.from("accounts").select("*").order("tag")).data ?? [];

  // Per-account reset cutoff. All rows older than this are hidden.
  const resetAt: Record<string, string> = {};
  for (const a of accounts as any[]) {
    if (a.reset_at) resetAt[a.tag] = a.reset_at as string;
  }
  const passesReset = (account_tag: string | null | undefined, ts: string | null | undefined) => {
    if (!account_tag) return true;
    const r = resetAt[account_tag];
    if (!r) return true;
    if (!ts) return false;
    return new Date(ts).getTime() > new Date(r).getTime();
  };

  const snapshotsDesc = (
    await db
      .from("snapshots")
      .select("account_tag, ts, balance, equity, open_count")
      .gte("ts", since30d)
      .order("ts", { ascending: false })
      .limit(50000)
  ).data ?? [];
  const rawSnapshots = snapshotsDesc.slice().reverse().filter((s: any) => passesReset(s.account_tag, s.ts));

  // Smooth equity series: 1-minute median bucketing per account.
  const BUCKET_MS = 60_000;
  const buckets = new Map<string, { account_tag: string; ts: string; balance: number; equity: number; open_count: number; eqs: number[] }>();
  for (const s of rawSnapshots) {
    const t = new Date(s.ts).getTime();
    const bucket = Math.floor(t / BUCKET_MS) * BUCKET_MS;
    const key = `${s.account_tag}_${bucket}`;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        account_tag: s.account_tag,
        ts: new Date(bucket).toISOString(),
        balance: Number(s.balance),
        equity: Number(s.equity),
        open_count: s.open_count ?? 0,
        eqs: [Number(s.equity)],
      });
    } else {
      existing.eqs.push(Number(s.equity));
      existing.balance = Number(s.balance);
      existing.open_count = s.open_count ?? existing.open_count;
    }
  }
  const median = (arr: number[]) => {
    const a = arr.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const snapshots = Array.from(buckets.values())
    .map((b) => ({ account_tag: b.account_tag, ts: b.ts, balance: b.balance, equity: median(b.eqs), open_count: b.open_count }))
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  const positions = ((
    await db
      .from("positions")
      .select("*")
      .order("snapshot_ts", { ascending: false })
  ).data ?? []).filter((p: any) => passesReset(p.account_tag, p.snapshot_ts));

  const recentLogs = ((
    await db
      .from("ea_logs")
      .select("account_tag, ea, message, ts")
      .gte("ts", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
      .order("ts", { ascending: false })
      .limit(10000)
  ).data ?? []).filter((r: any) => passesReset(r.account_tag, r.ts));

  const deals = ((
    await db
      .from("deals")
      .select("*")
      .gte("closed_at", since30d)
      .order("closed_at", { ascending: false })
      .limit(500)
  ).data ?? []).filter((d: any) => passesReset(d.account_tag, d.closed_at));

  const startOfDayUTC = () => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  };
  const startOfWeekUTC = () => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString();
  };
  const startOfMonthUTC = () => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(1);
    return d.toISOString();
  };

  const SOD = startOfDayUTC();
  const SOW = startOfWeekUTC();
  const SOM = startOfMonthUTC();

  // Broker-day start (UTC+3 midnight expressed as real UTC ISO).
  // Used to compute "today's % gain" from the first snapshot of the day.
  const TZ_OFFSET_H = 3;
  const nowShifted = new Date(Date.now() + TZ_OFFSET_H * 3600 * 1000);
  nowShifted.setUTCHours(0, 0, 0, 0);
  const SOD_BROKER = new Date(nowShifted.getTime() - TZ_OFFSET_H * 3600 * 1000).toISOString();

  const perAccount = accounts.map((a: any) => {
    const acctDeals = deals.filter((d: any) => d.account_tag === a.tag);
    const sum = (since: string) =>
      acctDeals
        .filter((d: any) => d.closed_at >= since)
        .reduce((s: number, d: any) => s + Number(d.profit ?? 0) + Number(d.swap ?? 0) + Number(d.commission ?? 0), 0);

    const pnl_today = sum(SOD);
    const pnl_week  = sum(SOW);
    const pnl_month = sum(SOM);

    const byEa: Record<string, number> = {};
    acctDeals
      .filter((d: any) => d.closed_at >= SOD)
      .forEach((d: any) => {
        const ea = d.ea || "OTHER";
        byEa[ea] = (byEa[ea] || 0) + Number(d.profit ?? 0) + Number(d.swap ?? 0) + Number(d.commission ?? 0);
      });

    const acctSnaps = snapshots.filter((s: any) => s.account_tag === a.tag);

    // === Robust day_start computation ===
    //
    // Mathematically guaranteed: balance moves only when deals close, and
    // pnl_today is exactly the sum of closes since broker midnight. So:
    //
    //     balance_at_midnight = current_balance - pnl_today
    //
    // This is more reliable than picking the FIRST snapshot of today, which
    // can be hours late if Telemetry was offline at the actual broker midnight
    // (e.g. VPS restart, EA migration). Previously a 10:00 restart would
    // anchor day_start to 10:00 balance — wiping out the morning's P&L from
    // the arrow comparison.
    //
    // For equity at midnight we PREFER a real snapshot if one exists within
    // the first hour of the broker day (close to true midnight). Otherwise we
    // fall back to balance-at-midnight (which is correct when no positions
    // were carried across midnight — true for V52, approximate for V5+).
    const last_balance = Number(a.last_balance ?? 0);
    const sodMs = new Date(SOD_BROKER).getTime();
    const earlyTodaySnap = acctSnaps.find((s: any) => {
      const t = new Date(s.ts).getTime();
      return t >= sodMs && t <= sodMs + 60 * 60 * 1000; // first hour of broker day
    });

    const day_start_balance =
      last_balance > 0
        ? last_balance - pnl_today
        : Number(a.last_balance ?? 0);
    const day_start_equity = earlyTodaySnap
      ? Number(earlyTodaySnap.equity)
      : day_start_balance;

    // === Synthesize equity points from closed deals to fill Telemetry gaps ===
    //
    // If Telemetry was offline during part of the window (e.g. VPS restart),
    // the snapshot series is sparse and the chart looks flat. We have the
    // deals table — every closed deal is a known balance step. We can
    // reconstruct synthetic equity points at each deal.closed_at by walking
    // backwards from current balance and subtracting subsequent deal P&Ls.
    //
    // Assumption: equity ≈ balance at the moment a deal closes (the just-
    // closed position no longer contributes to floating). This is exactly
    // correct when no other positions were open at that moment, and a good
    // approximation otherwise.
    const dealsAsc = acctDeals
      .slice()
      .sort((d1: any, d2: any) =>
        new Date(d1.closed_at).getTime() - new Date(d2.closed_at).getTime());
    const totalPnlInWindow = dealsAsc
      .filter((d: any) => d.closed_at >= since24h)
      .reduce((s: number, d: any) =>
        s + Number(d.profit ?? 0) + Number(d.swap ?? 0) + Number(d.commission ?? 0), 0);
    // Balance 24h ago = current_balance - all profits in window
    let runningBal = last_balance - totalPnlInWindow;
    const syntheticPoints: any[] = [];
    // Seed with a synthetic "start of window" point so the line begins at the
    // correct starting balance even when real snapshots are sparse.
    syntheticPoints.push({
      account_tag: a.tag,
      ts: since24h,
      balance: runningBal,
      equity: runningBal,
      open_count: 0,
    });
    for (const d of dealsAsc) {
      if (d.closed_at < since24h) continue;
      runningBal += Number(d.profit ?? 0) + Number(d.swap ?? 0) + Number(d.commission ?? 0);
      // Emit TWO points per deal — one just before (at the pre-close balance)
      // and one at the close (at the post-close balance). This creates the
      // step shape in the chart instead of a slanted line between deals.
      const closedAtMs = new Date(d.closed_at).getTime();
      const justBeforeIso = new Date(closedAtMs - 1000).toISOString();
      syntheticPoints.push({
        account_tag: a.tag,
        ts: justBeforeIso,
        balance: runningBal - (Number(d.profit ?? 0) + Number(d.swap ?? 0) + Number(d.commission ?? 0)),
        equity: runningBal - (Number(d.profit ?? 0) + Number(d.swap ?? 0) + Number(d.commission ?? 0)),
        open_count: 0,
      });
      syntheticPoints.push({
        account_tag: a.tag,
        ts: d.closed_at,
        balance: runningBal,
        equity: runningBal,
        open_count: 0,
      });
    }
    // Merge real snapshots + synthetic deal-derived points, dedupe by ts,
    // prefer real snapshot when both exist for the same minute.
    const merged = new Map<string, any>();
    for (const p of syntheticPoints) merged.set(p.ts, p);
    for (const s of acctSnaps) merged.set(s.ts, s); // overwrites synthetic at same ts
    const equityAll = Array.from(merged.values())
      .sort((x: any, y: any) => new Date(x.ts).getTime() - new Date(y.ts).getTime());

    const equity24h = equityAll.filter((s: any) => s.ts >= since24h);
    const equity7d  = equityAll.filter((s: any) => s.ts >= since7d);
    const equity30d = equityAll;

    const MAX_LOGS_PER_EA = 500;  // ~1 day worth of heartbeats per EA
    const lastLogByEa: Record<string, { message: string; ts: string }[]> = {};
    for (const r of recentLogs) {
      if (r.account_tag !== a.tag) continue;
      if (!lastLogByEa[r.ea]) lastLogByEa[r.ea] = [];
      if (lastLogByEa[r.ea].length < MAX_LOGS_PER_EA) {
        lastLogByEa[r.ea].push({ message: r.message, ts: r.ts });
      }
    }

    return {
      tag: a.tag,
      login: a.login,
      server: a.server,
      currency: a.currency,
      last_seen: a.last_seen,
      balance: Number(a.last_balance ?? 0),
      equity: Number(a.last_equity ?? 0),
      margin: Number(a.last_margin ?? 0),
      free_margin: Number(a.last_free ?? 0),
      floating: Number(a.last_profit ?? 0),
      pnl_today,
      pnl_week,
      pnl_month,
      by_ea_today: byEa,
      open_positions: positions.filter((p: any) => p.account_tag === a.tag),
      recent_deals: acctDeals.slice(0, 25),
      equity_24h: equity24h,
      equity_7d:  equity7d,
      equity_30d: equity30d,
      last_logs: lastLogByEa,
      day_start_balance,
      day_start_equity,
    };
  });

  return NextResponse.json(
    {
      fetched_at: new Date().toISOString(),
      accounts: perAccount,
    },
    { headers: NO_STORE_HEADERS }
  );
}
