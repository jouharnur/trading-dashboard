import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};

// Constants from the deployed strategy configs
const V52_ACTIVE_PAIRS = new Set([
  "EG_GC", "EA_GA", "GJ_UJ", "GN_UC",
  "AC_AJ", "GU_NU", "EJ_NJ", "AN_AU",
]);
const V52_THRESHOLD = 3.5;

// Backtest medians (from prior analysis)
const V52_DAY_MEDIAN_USD = 3600;
const V5_DAY_MEDIAN_USD  = 2673;
const COMBINED_DAY_MEDIAN_USD = 3900;
const FTMO_DAILY_FLOOR_USD = -4000;
const FTMO_PHASE1_TARGET_USD = 10000;

// V52 bar-check log format:
// "V52_P1: M15 bar YYYY.MM.DD HH:MM | EG_GC=z EU_UC=z ... | max|z|=X need>=Y near_signal=N/M"
const V52_BAR_RE = /M15 bar (\S+ \S+) \| (.+?) \| max\|z\|=(\S+) need>=(\S+) near_signal=(\d+)\/(\d+)/;

type V52Bar = {
  bar_time: string;
  max_z: number;
  threshold: number;
  per_pair_z: Record<string, number>;
  signaling_pairs: string[]; // active pairs with |z| >= threshold
};

function parseV52BarLog(msg: string): V52Bar | null {
  const m = V52_BAR_RE.exec(msg);
  if (!m) return null;
  const per_pair_z: Record<string, number> = {};
  for (const tok of m[2].split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    const p = tok.slice(0, eq);
    const z = parseFloat(tok.slice(eq + 1));
    if (!Number.isFinite(z)) continue;
    per_pair_z[p] = z;
  }
  const threshold = parseFloat(m[4]);
  const signaling_pairs: string[] = [];
  for (const [p, z] of Object.entries(per_pair_z)) {
    if (V52_ACTIVE_PAIRS.has(p) && Math.abs(z) >= threshold) {
      signaling_pairs.push(p);
    }
  }
  return {
    bar_time: m[1],
    max_z: parseFloat(m[3]),
    threshold,
    per_pair_z,
    signaling_pairs,
  };
}

function todayUtcIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const dateParam = url.searchParams.get("date"); // YYYY-MM-DD, defaults to today UTC
  const acctTag = url.searchParams.get("account") || "FTMO";

  const startIso = dateParam
    ? new Date(`${dateParam}T00:00:00Z`).toISOString()
    : todayUtcIso();
  const endIso = new Date(
    new Date(startIso).getTime() + 24 * 3600 * 1000
  ).toISOString();
  const dateStr = startIso.slice(0, 10);

  const db = supabaseAdmin();

  // Pull today's EA logs for the target account
  const { data: logs } = await db
    .from("ea_logs")
    .select("ea, message, ts")
    .eq("account_tag", acctTag)
    .gte("ts", startIso)
    .lt("ts", endIso)
    .order("ts", { ascending: true })
    .limit(20000);

  // Pull today's closed deals for the target account
  const { data: deals } = await db
    .from("deals")
    .select("*")
    .eq("account_tag", acctTag)
    .gte("closed_at", startIso)
    .lt("closed_at", endIso)
    .order("closed_at", { ascending: true })
    .limit(2000);

  // Parse V52 bar-check logs
  const v52Bars: V52Bar[] = [];
  for (const log of logs ?? []) {
    if (typeof log.message !== "string") continue;
    if (!log.message.includes("V52_P1: M15 bar")) continue;
    const bar = parseV52BarLog(log.message);
    if (bar) v52Bars.push(bar);
  }

  const v52BarsWithSignals = v52Bars.filter((b) => b.signaling_pairs.length > 0);
  const v52MaxZToday = v52Bars.reduce((mx, b) => Math.max(mx, b.max_z), 0);

  // Group deals by EA
  const v52Deals = (deals ?? []).filter(
    (d: any) => d.ea_tag === "QM_Universe_V52" || /V52/i.test(d.comment ?? "")
  );
  const v5Deals = (deals ?? []).filter(
    (d: any) =>
      d.ea_tag === "ACCT10_StatArb" || /ACCT10|V5\+|Hybrid34/i.test(d.comment ?? "")
  );

  const sumPnl = (arr: any[]) =>
    arr.reduce(
      (s, d) =>
        s +
        Number(d.profit ?? d.pnl_usd ?? 0) +
        Number(d.swap ?? 0) +
        Number(d.commission ?? 0),
      0
    );
  const v52Pnl = sumPnl(v52Deals);
  const v5Pnl = sumPnl(v5Deals);
  const combinedPnl = v52Pnl + v5Pnl;

  // Match V52 signaling-bar pairs to deals: did the signaled pair execute within 24h?
  const v52Matches: Array<{
    bar_time: string;
    pair: string;
    z: number;
    matched_deal: boolean;
    pnl_usd?: number;
  }> = [];

  for (const bar of v52BarsWithSignals) {
    for (const pair of bar.signaling_pairs) {
      const matched = v52Deals.find(
        (d: any) =>
          (d.comment ?? "").includes(pair) ||
          (d.ea_tag ?? "") === "QM_Universe_V52"
      );
      v52Matches.push({
        bar_time: bar.bar_time,
        pair,
        z: bar.per_pair_z[pair],
        matched_deal: !!matched,
        pnl_usd: matched ? sumPnl([matched]) : undefined,
      });
    }
  }

  const v52SignalCount = v52Matches.length;
  const v52MatchedCount = v52Matches.filter((m) => m.matched_deal).length;
  const v52MatchRate = v52SignalCount
    ? Math.round((v52MatchedCount / v52SignalCount) * 100)
    : null;

  // Build flags
  const flags: string[] = [];
  if (combinedPnl < FTMO_DAILY_FLOOR_USD + 2000) {
    flags.push(
      `Combined day P&L $${combinedPnl.toFixed(0)} is within $${(combinedPnl - FTMO_DAILY_FLOOR_USD).toFixed(0)} of FTMO floor`
    );
  }
  if (v52MatchRate !== null && v52MatchRate < 80) {
    flags.push(`V52 match rate ${v52MatchRate}% — investigate missing trades`);
  }
  if (v52SignalCount > 0 && v52Deals.length === 0) {
    flags.push(
      `V52 fired ${v52SignalCount} signals but 0 trades executed — broker rejection or cap issue`
    );
  }
  if (combinedPnl < -2000) {
    flags.push(`Combined day P&L below -$2,000 — bigger than expected loss day`);
  }

  // FTMO Phase 1 progress estimate (uses combined cumulative if available, otherwise today's PnL)
  const ftmoPhase1ProgressPct = Math.round(
    (combinedPnl / FTMO_PHASE1_TARGET_USD) * 100
  );

  const payload = {
    date: dateStr,
    account: acctTag,
    last_updated: new Date().toISOString(),
    v52: {
      bars_evaluated: v52Bars.length,
      bars_with_signals: v52BarsWithSignals.length,
      max_z_today: Math.round(v52MaxZToday * 100) / 100,
      signal_count: v52SignalCount,
      matched_count: v52MatchedCount,
      match_rate_pct: v52MatchRate,
      trades_today: v52Deals.length,
      day_pnl_usd: Math.round(v52Pnl),
      expected_median_usd: V52_DAY_MEDIAN_USD,
      vs_expected: v52Pnl - V52_DAY_MEDIAN_USD,
      signaling_pairs_today: [
        ...new Set(v52BarsWithSignals.flatMap((b) => b.signaling_pairs)),
      ],
      match_detail: v52Matches.slice(0, 20),
    },
    v5plus: {
      trades_today: v5Deals.length,
      day_pnl_usd: Math.round(v5Pnl),
      expected_median_usd: V5_DAY_MEDIAN_USD,
      vs_expected: v5Pnl - V5_DAY_MEDIAN_USD,
    },
    combined: {
      day_pnl_usd: Math.round(combinedPnl),
      expected_median_usd: COMBINED_DAY_MEDIAN_USD,
      vs_expected: combinedPnl - COMBINED_DAY_MEDIAN_USD,
      ftmo_floor_distance_usd: Math.round(combinedPnl - FTMO_DAILY_FLOOR_USD),
      ftmo_phase1_progress_pct: ftmoPhase1ProgressPct,
    },
    flags,
  };

  return NextResponse.json(payload, { headers: NO_STORE });
}
