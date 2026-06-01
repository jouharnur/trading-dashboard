import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type Position = {
  ticket: number;
  symbol: string;
  type: number;
  volume: number;
  open_price: number;
  current_price: number;
  sl: number;
  tp: number;
  magic: number;
  comment: string;
  profit: number;
  swap: number;
  open_time: string;
  ea: string;
};

type Deal = {
  deal_id: number;
  symbol: string;
  type: number;
  volume: number;
  price: number;
  profit: number;
  swap: number;
  commission: number;
  magic: number;
  comment: string;
  time: string;
  ea: string;
};

type Payload = {
  ts: string;
  auth: string;
  account: {
    tag: string;
    login: number;
    server: string;
    currency: string;
    balance: number;
    equity: number;
    margin: number;
    free_margin: number;
    profit: number;
  };
  positions: Position[];
  deals: Deal[];
};

let pushCounter = 0;

export async function POST(req: NextRequest) {
  let payload: Payload;
  try {
    payload = (await req.json()) as Payload;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  if (!payload?.auth || payload.auth !== process.env.INGEST_TOKEN) {
    return NextResponse.json({ ok: false, error: "auth" }, { status: 401 });
  }
  if (!payload.account?.tag) {
    return NextResponse.json({ ok: false, error: "no_tag" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const tag = payload.account.tag;
  // Always use server time. The EA's payload.ts comes from MT5's TimeCurrent(),
  // which on weekends gets stuck at Friday's last tick (especially on FX-only
  // brokers like FTMO) → equity-chart x-axis appears frozen. Stamping server-side
  // makes ts strictly monotonic regardless of broker quirks.
  const ts = new Date().toISOString();

  // 1) Upsert account row
  const acctErr = (
    await db.from("accounts").upsert(
      {
        tag,
        login: payload.account.login,
        server: payload.account.server,
        currency: payload.account.currency,
        last_seen: ts,
        last_balance: payload.account.balance,
        last_equity: payload.account.equity,
        last_margin: payload.account.margin,
        last_free: payload.account.free_margin,
        last_profit: payload.account.profit,
      },
      { onConflict: "tag" }
    )
  ).error;
  if (acctErr) return NextResponse.json({ ok: false, step: "acct", error: acctErr.message }, { status: 500 });

  // 2) Append snapshot
  const snapErr = (
    await db.from("snapshots").insert({
      account_tag: tag,
      ts,
      balance: payload.account.balance,
      equity: payload.account.equity,
      margin: payload.account.margin,
      free_margin: payload.account.free_margin,
      profit: payload.account.profit,
      open_count: payload.positions?.length ?? 0,
    })
  ).error;
  if (snapErr) return NextResponse.json({ ok: false, step: "snap", error: snapErr.message }, { status: 500 });

  // 3) Refresh positions for this account: delete-then-insert
  const delErr = (await db.from("positions").delete().eq("account_tag", tag)).error;
  if (delErr) return NextResponse.json({ ok: false, step: "pos_del", error: delErr.message }, { status: 500 });

  if (payload.positions?.length > 0) {
    const rows = payload.positions.map((p) => ({
      account_tag: tag,
      snapshot_ts: ts,
      ticket: p.ticket,
      symbol: p.symbol,
      side: p.type,
      volume: p.volume,
      open_price: p.open_price,
      current_price: p.current_price,
      sl: p.sl,
      tp: p.tp,
      magic: p.magic,
      comment: p.comment,
      profit: p.profit,
      swap: p.swap,
      open_time: p.open_time,
      ea: p.ea,
    }));
    const posErr = (await db.from("positions").insert(rows)).error;
    if (posErr) return NextResponse.json({ ok: false, step: "pos_ins", error: posErr.message }, { status: 500 });
  }

  // 4) Append deals (dedupe by (tag, deal_id))
  if (payload.deals?.length > 0) {
    const rows = payload.deals.map((d) => ({
      account_tag: tag,
      deal_id: d.deal_id,
      symbol: d.symbol,
      side: d.type,
      volume: d.volume,
      price: d.price,
      profit: d.profit,
      swap: d.swap,
      commission: d.commission,
      magic: d.magic,
      comment: d.comment,
      closed_at: d.time,
      ea: d.ea,
    }));
    const dealErr = (
      await db.from("deals").upsert(rows, { onConflict: "account_tag,deal_id" })
    ).error;
    if (dealErr) return NextResponse.json({ ok: false, step: "deals", error: dealErr.message }, { status: 500 });
  }

  // 5) Periodic prune
  pushCounter++;
  const everyN = parseInt(process.env.PRUNE_EVERY_N_PUSHES || "0", 10);
  if (everyN > 0 && pushCounter % everyN === 0) {
    await db.rpc("prune_old_snapshots");
  }

  return NextResponse.json({
    ok: true,
    tag,
    ts,
    open: payload.positions?.length ?? 0,
    deals_seen: payload.deals?.length ?? 0,
  });
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST telemetry payloads here" });
}
