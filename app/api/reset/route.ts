import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/reset
// Body: { tag: "FTMO" | "PEPPERSTONE", clear?: boolean }
// Headers: x-reset-token must match RESET_TOKEN env var
//
// Behaviour:
//   - Sets accounts.reset_at = now() for the given tag. All snapshots/deals/
//     positions/ea_logs older than this timestamp will be hidden by /api/data.
//   - If `clear` is true, ALSO physically deletes rows older than the new
//     reset_at (frees Supabase storage).
//   - Also clears last_balance/last_equity/last_profit on the account row so
//     the headline numbers show fresh state until the next EA push.
export async function POST(req: NextRequest) {
  const token = req.headers.get("x-reset-token");
  const expected = process.env.RESET_TOKEN;
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const tag = String(body.tag || "").trim();
  const clear = body.clear === true;
  if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });

  const db = supabaseAdmin();
  const nowIso = new Date().toISOString();

  // Verify account exists
  const acct = (await db.from("accounts").select("tag").eq("tag", tag).maybeSingle()).data;
  if (!acct) return NextResponse.json({ error: `account ${tag} not found` }, { status: 404 });

  // Set reset_at + clear cached headline numbers
  const upd = await db.from("accounts")
    .update({
      reset_at: nowIso,
      last_balance: null,
      last_equity: null,
      last_margin: null,
      last_free: null,
      last_profit: null,
    })
    .eq("tag", tag);
  if (upd.error) return NextResponse.json({ error: upd.error.message }, { status: 500 });

  const deleted: Record<string, number | null> = {};
  if (clear) {
    // Physically wipe old data for this account
    const tables = [
      { name: "snapshots", col: "ts" },
      { name: "positions", col: "snapshot_ts" },
      { name: "deals",     col: "closed_at" },
      { name: "ea_logs",   col: "ts" },
    ];
    for (const t of tables) {
      const del = await db.from(t.name).delete().eq("account_tag", tag).lt(t.col, nowIso);
      deleted[t.name] = del.error ? null : (del.count ?? null);
      if (del.error) console.error(`reset ${t.name}:`, del.error.message);
    }
  }

  return NextResponse.json({
    ok: true,
    tag,
    reset_at: nowIso,
    cleared: clear,
    deleted,
  });
}
