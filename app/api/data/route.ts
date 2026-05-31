import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Aggregated snapshot for the dashboard. Polled by the client every ~10s.
export async function GET() {
  const db = supabaseAdmin();

  const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const since7d  = new Date(Date.now() -  7 * 24 * 3600 * 1000).toISOString();
  const since24h = new Date(Date.now() -  1 * 24 * 3600 * 1000).toISOString();

  const accounts = (await db.from("accounts").select("*").order("tag")).data ?? [];

  // Pull last 30 days of snapshots once and slice client-side for charts/PnL
  const snapshots = (
    await db
      .from("snapshots")
      .select("account_tag, ts, balance, equity, open_count")
      .gte("ts", since30d)
      .order("ts")
  ).data ?? [];

  const positions = (
    await db
      .from("positions")
      .select("*")
      .order("snapshot_ts", { ascending: false })
  ).data ?? [];

  const deals = (
    await db
      .from("deals")
      .select("*")
      .gte("closed_at", since30d)
      .order("closed_at", { ascending: false })
      .limit(500)
  ).data ?? [];

  // Helpers
  const startOfDayUTC = () => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.toISOString();
  };
  const startOfWeekUTC = () => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    const dow = (d.getUTCDay() + 6) % 7; // Monday=0
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

  // Compute per-account PnL windows from deals (realized only)
  const perAccount = accounts.map((a: any) => {
    const acctDeals = deals.filter((d: any) => d.account_tag === a.tag);
    const sum = (since: string) =>
      acctDeals
        .filter((d: any) => d.closed_at >= since)
        .reduce((s: number, d: any) => s + Number(d.profit ?? 0) + Number(d.swap ?? 0) + Number(d.commission ?? 0), 0);

    const pnl_today = sum(SOD);
    const pnl_week  = sum(SOW);
    const pnl_month = sum(SOM);

    // Per-EA breakdown (today)
    const byEa: Record<string, number> = {};
    acctDeals
      .filter((d: any) => d.closed_at >= SOD)
      .forEach((d: any) => {
        const ea = d.ea || "OTHER";
        byEa[ea] = (byEa[ea] || 0) + Number(d.profit ?? 0) + Number(d.swap ?? 0) + Number(d.commission ?? 0);
      });

    // Equity curves
    const acctSnaps = snapshots.filter((s: any) => s.account_tag === a.tag);
    const equity24h = acctSnaps.filter((s: any) => s.ts >= since24h);
    const equity7d  = acctSnaps.filter((s: any) => s.ts >= since7d);
    const equity30d = acctSnaps;

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
    };
  });

  return NextResponse.json({
    fetched_at: new Date().toISOString(),
    accounts: perAccount,
  });
}
