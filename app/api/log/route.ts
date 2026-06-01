import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type LogPayload = {
  auth: string;
  account_tag: string;
  ea: string;          // e.g. "V52"
  message: string;     // the heartbeat string, e.g. "open=0/8 maxZ=0.96 need=3.5 market=LIVE"
};

export async function POST(req: NextRequest) {
  let payload: LogPayload;
  try {
    payload = (await req.json()) as LogPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  if (!payload?.auth || payload.auth !== process.env.INGEST_TOKEN) {
    return NextResponse.json({ ok: false, error: "auth" }, { status: 401 });
  }
  if (!payload.account_tag || !payload.ea || !payload.message) {
    return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { error } = await db.from("ea_logs").insert({
    account_tag: payload.account_tag,
    ea: payload.ea,
    message: payload.message,
    ts: new Date().toISOString(),
  });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST EA heartbeat strings here" });
}
