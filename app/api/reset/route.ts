import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/reset
// Body: { tag: "FTMO" | "PEPPERSTONE", clear?: boolean }
// Headers: x-reset-token must match RESET_TOKEN env var
//
// Behaviour:
//   - Sets accounts.reset_at = now(). /api/data hides rows older than that.
//   - If clear=true: physically deletes rows in snapshots / positions / deals
//     / ea_logs older than the new reset_at (frees free-tier storage).
//   - Also nulls last_balance / last_equity / last_profit so headline numbers
//     show fresh state until the EA's next push.
export async function POST(req: NextRequest) {
  const diag: any = {};
  try {
    const token = req.headers.get("x-reset-token");
    const expected = process.env.RESET_TOKEN;
    if (!expected) {
      return NextResponse.json(
        { error: "RESET_TOKEN env var not set on the server. Add it in Vercel project settings and redeploy." },
        { status: 500 }
      );
    }
    if (token !== expected) {
      return NextResponse.json({ error: "unauthorized (token mismatch)" }, { status: 401 });
    }

    let body: any;
    try { body = await req.json(); } catch { body = {}; }
    const tag = String(body.tag || "").trim();
    const clear = body.clear === true;
    if (!tag) return NextResponse.json({ error: "tag required in body" }, { status: 400 });
    diag.tag = tag;
    diag.clear = clear;

    const db = supabaseAdmin();
    const nowIso = new Date().toISOString();
    diag.reset_at = nowIso;

    // Verify account exists
    const acctRes = await db.from("accounts").select("tag, reset_at").eq("tag", tag).maybeSingle();
    if (acctRes.error) {
      return NextResponse.json({ error: `accounts query failed: ${acctRes.error.message}`, diag }, { status: 500 });
    }
    if (!acctRes.data) {
      return NextResponse.json({ error: `account '${tag}' not found in accounts table`, diag }, { status: 404 });
    }
    diag.prev_reset_at = acctRes.data.reset_at ?? null;

    // Set reset_at + clear cached headline numbers
    const upd = await db
      .from("accounts")
      .update({
        reset_at: nowIso,
        last_balance: null,
        last_equity: null,
        last_margin: null,
        last_free: null,
        last_profit: null,
      })
      .eq("tag", tag);
    if (upd.error) {
      // Most likely cause: migration not run -> column reset_at doesn't exist.
      return NextResponse.json(
        {
          error: `accounts.update failed: ${upd.error.message}`,
          hint: "If error mentions 'reset_at' or 'column ... does not exist', run the migration: alter table accounts add column if not exists reset_at timestamptz;",
          diag,
        },
        { status: 500 }
      );
    }
    diag.accounts_updated = true;

    const deleted: Record<string, { count: number | null; error: string | null }> = {};
    if (clear) {
      // Physically wipe old data for this account
      const tables: { name: string; col: string }[] = [
        { name: "snapshots", col: "ts" },
        { name: "positions", col: "snapshot_ts" },
        { name: "deals",     col: "closed_at" },
        { name: "ea_logs",   col: "ts" },
      ];
      // HARD wipe: delete ALL rows for this account_tag regardless of timestamp.
      // (Earlier behavior only deleted rows older than reset_at, which left
      //  deals that closed at or after the reset moment in place. With reset_at
      //  also set, the data API will hide anything from before reset_at, so
      //  hard-wiping all rows is safe and gives a true clean slate.)
      for (const t of tables) {
        const del = await db
          .from(t.name)
          .delete({ count: "exact" })
          .eq("account_tag", tag);
        deleted[t.name] = {
          count: del.count ?? null,
          error: del.error ? del.error.message : null,
        };
      }
    }
    diag.deleted = deleted;

    return NextResponse.json({ ok: true, ...diag });
  } catch (e: any) {
    return NextResponse.json(
      { error: `unhandled exception: ${e?.message ?? String(e)}`, diag },
      { status: 500 }
    );
  }
}
