"use client";

import { useEffect, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from "recharts";

type EquityPt = { account_tag: string; ts: string; balance: number; equity: number; open_count: number };
type Position = any;
type Deal = any;
type Account = {
  tag: string;
  login: number;
  server: string;
  currency: string;
  last_seen: string | null;
  balance: number;
  equity: number;
  margin: number;
  free_margin: number;
  floating: number;
  pnl_today: number;
  pnl_week: number;
  pnl_month: number;
  by_ea_today: Record<string, number>;
  open_positions: Position[];
  recent_deals: Deal[];
  equity_24h: EquityPt[];
  equity_7d: EquityPt[];
  equity_30d: EquityPt[];
  last_logs: Record<string, { message: string; ts: string }[]>;
  day_start_balance: number;
  day_start_equity: number;
};

type Resp = { fetched_at: string; accounts: Account[] };

const POLL_MS = 10_000;

function fmt$(n: number | null | undefined) {
  if (n == null || isNaN(n as number)) return "-";
  const sign = (n as number) < 0 ? "-" : "";
  const v = Math.abs(n as number).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  return `${sign}${v}`;
}
// Display all times in this fixed offset (broker time on Pepperstone is GMT+3).
const TZ_OFFSET_H = 3;
const TZ_LABEL = "UTC+3";
const tzShift = (msOrIso: number | string) => {
  const t = typeof msOrIso === "number" ? msOrIso : new Date(msOrIso).getTime();
  return new Date(t + TZ_OFFSET_H * 3600 * 1000);
};

function fmtPct(n: number | null | undefined) {
  if (n == null || isNaN(n as number)) return "-";
  const sign = (n as number) >= 0 ? "+" : "";
  return `${sign}${(n as number).toFixed(2)}%`;
}

function cls(n: number) {
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "";
}
function ageMin(iso: string | null) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 60000;
}
function statusDot(iso: string | null) {
  const m = ageMin(iso);
  if (m < 5) return <span className="dot ok" />;
  if (m < 30) return <span className="dot stale" />;
  return <span className="dot dead" />;
}

// Best-guess "primary EA" for an account: the most common ea tag across
// the by_ea_today buckets, then fall back to open positions, then deals.
function primaryEA(acct: Account): string {
  const counts: Record<string, number> = {};
  for (const k of Object.keys(acct.by_ea_today)) counts[k] = (counts[k] || 0) + 1;
  for (const p of acct.open_positions || []) {
    const e = (p as any).ea;
    if (e && e !== "OTHER") counts[e] = (counts[e] || 0) + 1;
  }
  for (const d of acct.recent_deals || []) {
    const e = (d as any).ea;
    if (e && e !== "OTHER") counts[e] = (counts[e] || 0) + 1;
  }
  let best = "", bestN = 0;
  for (const [k, n] of Object.entries(counts)) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

function ResetButton({ tag }: { tag: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const doReset = async (clear: boolean) => {
    const ok = window.confirm(
      `Reset ${tag}?\n\n${clear
        ? "This will DELETE all snapshots/deals/positions/logs older than now."
        : "This will hide all data older than now. Data stays in the database."
      }\n\nA reset token is required (set RESET_TOKEN env var on Vercel).`
    );
    if (!ok) return;
    const token = window.prompt(`Reset token for ${tag}:`);
    if (!token) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/reset", {
        method: "POST",
        headers: { "content-type": "application/json", "x-reset-token": token },
        body: JSON.stringify({ tag, clear }),
      });
      const j = await res.json();
      if (!res.ok) {
        const errMsg = j.error || `HTTP ${res.status}`;
        const hint = j.hint ? `\n\nHint: ${j.hint}` : "";
        const diag = j.diag ? `\n\nDiagnostics:\n${JSON.stringify(j.diag, null, 2)}` : "";
        window.alert(`Reset failed.\n\n${errMsg}${hint}${diag}`);
        setMsg(errMsg);
        return;
      }
      // Success path — show what got deleted if wipe was requested
      if (clear && j.deleted) {
        const lines = Object.entries(j.deleted).map(
          ([k, v]: [string, any]) => `  ${k}: ${v.count ?? "?"} rows${v.error ? " (ERROR: " + v.error + ")" : ""}`
        ).join("\n");
        window.alert(`Reset+wipe done for ${tag}.\n\nDeleted:\n${lines}`);
      } else {
        window.alert(`Reset done for ${tag}. reset_at=${j.reset_at}`);
      }
      setMsg(clear ? "Reset+wiped" : "Reset");
      setTimeout(() => window.location.reload(), 800);
    } catch (e: any) {
      setMsg(e?.message || "failed");
    } finally {
      setBusy(false);
    }
  };
  const [menuOpen, setMenuOpen] = useState(false);
  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && !t.closest(`[data-reset-menu="${tag}"]`)) setMenuOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [menuOpen, tag]);

  return (
    <span data-reset-menu={tag} style={{ position: "relative", display: "inline-flex", alignItems: "center", marginLeft: 8 }}>
      {msg && <span style={{ fontSize: 11, color: "#8aa", marginRight: 6 }}>{msg}</span>}
      <button
        disabled={busy}
        onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
        title="Account actions"
        aria-label="Account actions"
        style={{
          fontSize: 16, lineHeight: 1, padding: "2px 8px", borderRadius: 4,
          border: "1px solid #444", background: "#222", color: "#ccc",
          cursor: busy ? "wait" : "pointer", fontWeight: 700,
        }}
      >
        {busy ? "..." : "⋮"}
      </button>
      {menuOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 170,
            background: "#141821",
            border: "1px solid #2a2f3d",
            borderRadius: 6,
            boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
            zIndex: 50,
            padding: 4,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <button
            onClick={() => { setMenuOpen(false); doReset(false); }}
            title="Hide all data before this moment (reversible in Supabase)"
            style={{
              textAlign: "left",
              fontSize: 12,
              padding: "8px 10px",
              borderRadius: 4,
              border: "none",
              background: "transparent",
              color: "#cfd5e0",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#1f2530")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            Reset
          </button>
          <button
            onClick={() => { setMenuOpen(false); doReset(true); }}
            title="Reset AND physically delete rows (irreversible)"
            style={{
              textAlign: "left",
              fontSize: 12,
              padding: "8px 10px",
              borderRadius: 4,
              border: "none",
              background: "transparent",
              color: "#f78a8a",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#2a1014")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            Reset + Wipe
          </button>
        </div>
      )}
    </span>
  );
}

// Compute today's TOTAL P&L high and low (realized + unrealized combined).
// V52ProximityCard — parse latest V52 heartbeat message in acct.last_logs and
// render a multi-threshold horizontal gauge showing where max|z| sits on the
// 0 → stop scale. Same visual style as the FTMO challenge card.
//
// Heartbeat format produced by the EA:
//   open=0/8 equity=$110027.26 R=$1100.27 maxZ=1.36 need=3.5 market=LIVE
function V52ProximityCard({ acct }: { acct: Account }) {
  const v52Logs = (acct.last_logs && acct.last_logs["V52"]) || [];
  if (v52Logs.length === 0) return null;

  let maxZ: number | null = null;
  let need: number | null = null;
  let market = "?";
  let openCnt = "?";
  let lastTs: string | null = null;
  // Track today's broker-day peak by scanning ALL heartbeats since broker
  // midnight UTC+3. "Current" maxZ is the latest snapshot; "peak" tells you
  // how close anything came to the entry signal today — the question you'd
  // actually ask while monitoring.
  let peakZ = 0;
  let peakTs: string | null = null;
  const sodMs = (() => {
    const n = tzShift(Date.now());
    n.setUTCHours(0, 0, 0, 0);
    return n.getTime() - TZ_OFFSET_H * 3600 * 1000;
  })();
  for (const e of v52Logs) {
    const m = e.message || "";
    const mz = m.match(/maxZ=([0-9]+(?:\.[0-9]+)?)/);
    const nd = m.match(/need=([0-9]+(?:\.[0-9]+)?)/);
    if (mz && nd) {
      const z = parseFloat(mz[1]);
      const n = parseFloat(nd[1]);
      // First valid match = latest entry (logs come in descending-ts order).
      if (maxZ === null) {
        maxZ = z;
        need = n;
        const mk = m.match(/market=(\w+)/); if (mk) market = mk[1];
        const op = m.match(/open=([0-9]+\/[0-9]+)/); if (op) openCnt = op[1];
        lastTs = e.ts;
      }
      // Track today's peak across all broker-day heartbeats.
      const tms = new Date(e.ts).getTime();
      if (tms >= sodMs && z > peakZ) {
        peakZ = z;
        peakTs = e.ts;
      }
    }
  }
  if (maxZ === null || need === null || need <= 0) return null;

  const stop = need + 1.0;
  const SCALE_MIN = 0, SCALE_MAX = 5;
  const toPct = (v: number) => ((v - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100;

  const posQuiet  = toPct(need * 0.5);
  const posWatch  = toPct(need * 0.75);
  const posEntry  = toPct(need);
  const posStop   = toPct(stop);
  const posCur    = Math.max(0, Math.min(100, toPct(maxZ)));

  let status: string, statusColor: string;
  if (maxZ >= stop)             { status = "STOP ZONE"; statusColor = "#c14040"; }
  else if (maxZ >= need)        { status = "SIGNAL";    statusColor = "#7ec99e"; }
  else if (maxZ >= need * 0.85) { status = "IMMINENT";  statusColor = "#e9a05a"; }
  else if (maxZ >= need * 0.65) { status = "CLOSE";     statusColor = "#e9b94a"; }
  else                          { status = "QUIET";     statusColor = "#98a3b3"; }

  const toEntry = Math.max(0, need - maxZ);

  const timeStr = lastTs
    ? tzShift(new Date(lastTs).getTime()).toISOString().substring(11, 16) + " " + TZ_LABEL
    : "";

  return (
    <div className="card" style={{ flex: 1, minWidth: 320 }}>
      <h3>V52 signal proximity</h3>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4 }}>
        <div>
          <span style={{ fontSize: 22, fontWeight: 700 }}>{maxZ.toFixed(2)}</span>
          <span className="muted" style={{ fontSize: 13, marginLeft: 6 }}>
            / {need.toFixed(1)} entry · {stop.toFixed(1)} stop
          </span>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: statusColor, textTransform: "uppercase" }}>
          {status}
        </div>
      </div>

      <div style={{ position: "relative", height: 22, marginTop: 14, marginBottom: 22 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 8, height: 6, background: "#1e2330", borderRadius: 3, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: 0, width: `${posQuiet}%`, top: 0, bottom: 0, background: "#2a3142" }} />
          <div style={{ position: "absolute", left: `${posQuiet}%`, width: `${posWatch - posQuiet}%`, top: 0, bottom: 0, background: "#3a3624" }} />
          <div style={{ position: "absolute", left: `${posWatch}%`, width: `${posEntry - posWatch}%`, top: 0, bottom: 0, background: "#4a3422" }} />
          <div style={{ position: "absolute", left: `${posEntry}%`, width: `${posStop - posEntry}%`, top: 0, bottom: 0, background: "#2f5f3f" }} />
          <div style={{ position: "absolute", left: `${posStop}%`, right: 0, top: 0, bottom: 0, background: "#5c2424" }} />
        </div>
        {(() => {
          const labels = [
            { p: posQuiet, lbl: (need * 0.5).toFixed(1),  color: "#98a3b3", up: true  },
            { p: posWatch, lbl: (need * 0.75).toFixed(1), color: "#e9b94a", up: false },
            { p: posEntry, lbl: need.toFixed(1) + " entry", color: "#7ec99e", up: true },
            { p: posStop,  lbl: stop.toFixed(1) + " stop",  color: "#e57373", up: false },
          ];
          return labels.map((t, i) => {
            const isFirst = i === 0;
            const isLast = i === labels.length - 1;
            const labelStyle: React.CSSProperties = isFirst
              ? { left: 2, width: 56, textAlign: "left" }
              : isLast
              ? { left: -56, width: 56, textAlign: "right" }
              : { left: -28, width: 56, textAlign: "center" };
            return (
              <div key={i} style={{
                position: "absolute",
                left: `calc(${t.p}% - 1px)`,
                top: 0, bottom: 0, width: 2,
                background: t.color,
              }}>
                <div style={{
                  position: "absolute",
                  [t.up ? "top" : "bottom"]: "-2px",
                  ...labelStyle,
                  fontSize: 9,
                  color: t.color,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}>{t.lbl}</div>
              </div>
            );
          });
        })()}
        {/* Today's peak — translucent yellow tick at the highest z reached today.
            Only shown if it's actually higher than the current value. */}
        {peakZ > maxZ && (() => {
          const posPeak = Math.max(0, Math.min(100, toPct(peakZ)));
          return (
            <div style={{
              position: "absolute",
              left: `calc(${posPeak}% - 1px)`,
              top: -2, bottom: -2, width: 2,
              background: "#e9b94a",
              opacity: 0.8,
            }} title={`today peak ${peakZ.toFixed(2)}`} />
          );
        })()}
        <div style={{
          position: "absolute",
          left: `calc(${posCur}% - 6px)`,
          top: 2, width: 12, height: 18,
          background: statusColor,
          borderRadius: 2,
          boxShadow: "0 0 4px rgba(0,0,0,0.6)",
        }} title={`max|z| = ${maxZ.toFixed(2)}`} />
      </div>

      <div className="muted" style={{ fontSize: 11, display: "flex", justifyContent: "space-between", marginTop: 4 }}>
        <span>positions: <span style={{ color: "#e8ecf1" }}>{openCnt}</span></span>
        <span>market: <span style={{ color: "#e8ecf1" }}>{market}</span></span>
        <span>today peak: <span style={{ color: "#e9b94a", fontWeight: 600 }}>{peakZ.toFixed(2)}</span></span>
        <span>to entry: <span style={{ color: "#7ec99e" }}>{toEntry.toFixed(2)}</span></span>
        <span>{timeStr}</span>
      </div>
    </div>
  );
}

// FTMOChallengeCard — Phase 1 progress meter for FTMO challenges.
//
// Anchors (everything in dollar terms, NOT percentages):
//   initial balance = round(equity_30d[0]) to nearest standard challenge size
//                     ($10k, $25k, $50k, $100k, $200k). For an account that
//                     started at $100,000, this is always exactly $100,000.
//   PROFIT TARGET   = initial × 1.10  (e.g. $100k → $110k)  ← RIGHT side of gauge
//   DAILY HALT LINE = initial × 0.95  ($95k on a $100k)     ← left of center
//   BUST LINE       = initial × 0.90  ($90k on a $100k)     ← LEFT side of gauge
//
// Renders only on FTMO accounts.
function FTMOChallengeCard({ acct }: { acct: Account }) {
  // Renders only on FTMO — the broker-enforced challenge limits don't apply
  // to Pepperstone, so showing a "10% target" gauge there is misleading.
  if (!/^ftmo/i.test(acct.tag)) return null;

  let rawStart = 0;
  if (acct.equity_30d && acct.equity_30d.length > 0) {
    rawStart = Number(acct.equity_30d[0].equity) || 0;
  }
  if (!rawStart || rawStart <= 0) rawStart = acct.day_start_balance || acct.balance || 0;
  if (!rawStart || rawStart <= 0) return null;
  const STANDARD_SIZES = [5000, 10000, 25000, 50000, 100000, 200000, 400000];
  let initial = STANDARD_SIZES[0];
  let bestDiff = Math.abs(rawStart - initial);
  for (const sz of STANDARD_SIZES) {
    const d = Math.abs(rawStart - sz);
    if (d < bestDiff) { bestDiff = d; initial = sz; }
  }

  const target = initial * 1.10;
  const dailyLimit = initial * 0.95;
  const bustLimit = initial * 0.90;

  const cur = acct.equity;
  const dollarFromInit = cur - initial;
  const pctFromInit = (dollarFromInit / initial) * 100;

  // Scale ends EXACTLY at bust (left) and target (right). No extra margin.
  const SCALE_LOW  = bustLimit;
  const SCALE_HIGH = target;
  const toPct = (v: number) => ((v - SCALE_LOW) / (SCALE_HIGH - SCALE_LOW)) * 100;

  const posBust   = toPct(bustLimit);
  const posDaily  = toPct(dailyLimit);
  const posStart  = toPct(initial);
  const posTarget = toPct(target);
  const posCur    = Math.max(0, Math.min(100, toPct(cur)));

  let status: string, statusColor: string;
  if (cur >= target)              { status = "TARGET HIT"; statusColor = "#7ec99e"; }
  else if (cur >= initial * 1.05) { status = "ON TRACK";   statusColor = "#7ec99e"; }
  else if (cur >= initial)        { status = "AHEAD";      statusColor = "#a8d8b8"; }
  else if (cur >= initial * 0.99) { status = "HEALTHY";    statusColor = "#e8ecf1"; }
  else if (cur >= dailyLimit)     { status = "WATCHING";   statusColor = "#e9b94a"; }
  else if (cur >= bustLimit)      { status = "DANGER";     statusColor = "#e57373"; }
  else                            { status = "BUST";       statusColor = "#c14040"; }

  const sgn = dollarFromInit >= 0 ? "+" : "";

  return (
    <div className="card" style={{ flex: 1, minWidth: 360 }}>
      <h3>FTMO Phase 1 progress</h3>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4 }}>
        <div>
          <span style={{ fontSize: 22, fontWeight: 700, color: dollarFromInit >= 0 ? "#7ec99e" : "#e57373" }}>
            {fmt$(cur)}
          </span>
          <span className="muted" style={{ fontSize: 13, marginLeft: 6 }}>
            ({sgn}{fmt$(dollarFromInit)} · {sgn}{pctFromInit.toFixed(2)}%)
          </span>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: statusColor, textTransform: "uppercase" }}>
          {status}
        </div>
      </div>

      <div style={{ position: "relative", height: 22, marginTop: 14, marginBottom: 22 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 8, height: 6, background: "#1e2330", borderRadius: 3, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: 0, width: `${posBust}%`, top: 0, bottom: 0, background: "#5c2424" }} />
          <div style={{ position: "absolute", left: `${posBust}%`, width: `${posDaily - posBust}%`, top: 0, bottom: 0, background: "#7c3a3a" }} />
          <div style={{ position: "absolute", left: `${posDaily}%`, width: `${posStart - posDaily}%`, top: 0, bottom: 0, background: "#3a3624" }} />
          <div style={{ position: "absolute", left: `${posStart}%`, width: `${posTarget - posStart}%`, top: 0, bottom: 0, background: "#2a3142" }} />
          <div style={{ position: "absolute", left: `${posTarget}%`, right: 0, top: 0, bottom: 0, background: "#2f5f3f" }} />
        </div>
        {(() => {
          const labels = [
            { p: posBust,   lbl: fmt$(bustLimit),  color: "#e57373", up: true  },
            { p: posDaily,  lbl: fmt$(dailyLimit), color: "#e9a05a", up: false },
            { p: posStart,  lbl: fmt$(initial),    color: "#98a3b3", up: true  },
            { p: posTarget, lbl: fmt$(target),     color: "#7ec99e", up: false },
          ];
          return labels.map((t, i) => {
            // Edge-aware positioning so labels at 0% / 100% don't clip outside the card.
            const isFirst = i === 0;
            const isLast = i === labels.length - 1;
            const labelStyle: React.CSSProperties = isFirst
              ? { left: 2, width: 70, textAlign: "left" }
              : isLast
              ? { left: -70, width: 70, textAlign: "right" }
              : { left: -35, width: 70, textAlign: "center" };
            return (
              <div key={i} style={{
                position: "absolute",
                left: `calc(${t.p}% - 1px)`,
                top: 0, bottom: 0, width: 2,
                background: t.color,
              }}>
                <div style={{
                  position: "absolute",
                  [t.up ? "top" : "bottom"]: "-2px",
                  ...labelStyle,
                  fontSize: 9,
                  color: t.color,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}>{t.lbl}</div>
              </div>
            );
          });
        })()}
        <div style={{
          position: "absolute",
          left: `calc(${posCur}% - 6px)`,
          top: 2, width: 12, height: 18,
          background: statusColor,
          borderRadius: 2,
          boxShadow: "0 0 4px rgba(0,0,0,0.6)",
        }} title={`equity = ${fmt$(cur)}`} />
      </div>

    </div>
  );
}

// total_pnl_at_snapshot = equity(at snapshot) - day_start_equity.
// This is more correct than floating-only because once positions close they
// stop contributing to floating but their realized P&L stays in equity.
function DayHighLow({ acct }: { acct: Account }) {
  // Start of broker-day (UTC+3) = today's UTC midnight + offset, shifted back
  const nowShifted = tzShift(Date.now());
  nowShifted.setUTCHours(0, 0, 0, 0);
  const sod = nowShifted.getTime() - TZ_OFFSET_H * 3600 * 1000;
  const dayOpen = Number(acct.day_start_balance) || 0;

  // Scan today's equity series for the high and low.
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let hiTs: number | null = null;
  let loTs: number | null = null;
  for (const p of acct.equity_24h) {
    const t = new Date(p.ts).getTime();
    if (t < sod) continue;
    const eq = Number(p.equity);
    if (eq > high) { high = eq; hiTs = t; }
    if (eq < low)  { low  = eq; loTs = t; }
  }
  if (!isFinite(high)) { high = acct.equity; hiTs = null; }
  if (!isFinite(low))  { low  = acct.equity; loTs = null; }

  const fmtTime = (t: number | null) =>
    t == null ? "" : tzShift(t).toISOString().substring(11, 16) + " " + TZ_LABEL;

  return (
    <div className="card" style={{ flex: 1, minWidth: 220 }}>
      <h3>Today equity high / low</h3>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
        <div>
          <div className="muted">High</div>
          <div className="pos" style={{ fontSize: 18, fontWeight: 700 }}>{fmt$(high)}</div>
          <div className="muted" style={{ fontSize: 11 }}>{fmtTime(hiTs)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="muted">Low</div>
          <div className="neg" style={{ fontSize: 18, fontWeight: 700 }}>{fmt$(low)}</div>
          <div className="muted" style={{ fontSize: 11 }}>{fmtTime(loTs)}</div>
        </div>
      </div>
      <div className="muted" style={{ marginTop: 10, textAlign: "center", fontSize: 11 }}>
        day open {fmt$(dayOpen)}
      </div>
    </div>
  );
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function chartTickFormatter(mode: "24h" | "7d" | "30d") {
  return (v: number) => {
    const d = tzShift(v);
    if (mode === "24h") {
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mm = String(d.getUTCMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    }
    if (mode === "7d") {
      const hh = String(d.getUTCHours()).padStart(2, "0");
      return `${DOW[d.getUTCDay()]} ${hh}h`;
    }
    return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
  };
}

function EquityChart({ data, title, mode, dayStart }: { data: EquityPt[]; title: string; mode: "24h" | "7d" | "30d"; dayStart?: number }) {
  const points = data.map((p) => ({
    t: new Date(p.ts).getTime(),
    equity: Number(p.equity),
    balance: Number(p.balance),
  }));
  // Equity line goes red when the latest equity is BELOW the day-open
  // reference (same convention as the mobile summary card spark).
  const lastEq = points.length > 0 ? points[points.length - 1].equity : 0;
  const equityStroke = (dayStart && dayStart > 0 && lastEq < dayStart) ? "#e57373" : "#6ab0ff";
  return (
    <div className="card" style={{ flex: 1, minWidth: 360, width: "100%" }}>
      <h3>{title}</h3>
      <div style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer>
          <LineChart data={points}>
            <CartesianGrid stroke="#232938" />
            <XAxis
              dataKey="t"
              tick={{ fill: "#98a3b3", fontSize: 11 }}
              tickFormatter={chartTickFormatter(mode)}
              minTickGap={mode === "30d" ? 60 : 40}
            />
            <YAxis
              tick={{ fill: "#98a3b3", fontSize: 11 }}
              domain={
                dayStart && dayStart > 0
                  ? [
                      (dataMin: number) => Math.min(dataMin, dayStart) - Math.abs(dayStart) * 0.0005,
                      (dataMax: number) => Math.max(dataMax, dayStart) + Math.abs(dayStart) * 0.0005,
                    ]
                  : (["auto", "auto"] as any)
              }
            />
            <Tooltip
              contentStyle={{ background: "#141821", border: "1px solid #232938", fontSize: 12 }}
              labelFormatter={(v) => {
                const d = tzShift(v as number);
                return d.toISOString().replace("T", " ").substring(0, 19) + " " + TZ_LABEL;
              }}
              formatter={(v: any) => fmt$(Number(v))}
            />
            {dayStart && dayStart > 0 && (
              <ReferenceLine
                y={dayStart}
                stroke="#e9b94a"
                strokeDasharray="4 4"
                strokeWidth={1}
                label={{ value: `day open ${fmt$(dayStart)}`, position: "insideTopRight", fill: "#e9b94a", fontSize: 10 }}
              />
            )}
            <Line type="monotone" dataKey="equity" stroke={equityStroke} dot={false} strokeWidth={2} />
            <Line type="monotone" dataKey="balance" stroke="#7ec99e" dot={false} strokeWidth={1} strokeDasharray="3 3" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function fmtOpenTime(iso: string | null | undefined) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  // The EA sends position open_time as broker server time (already UTC+3 on
  // Pepperstone / FTMO Demo) tagged with a "Z" suffix. We do NOT add the +3
  // offset here, because that would double-shift it. Just read the raw fields.
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mn = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mn}`;
}

function PositionsTable({ rows }: { rows: Position[] }) {
  const sorted = rows.slice().sort((a, b) => {
    const ta = new Date(a.open_time || 0).getTime();
    const tb = new Date(b.open_time || 0).getTime();
    return tb - ta;
  });

  return (
    <div className="card" style={{ flex: 2, minWidth: 480 }}>
      <h3>Open positions ({sorted.length})</h3>
      {sorted.length === 0 ? (
        <div className="muted">- no open positions -</div>
      ) : (
        <div className="scroll-6">
          <table>
            <thead>
              <tr>
                <th className="desk-only">EA</th>
                <th>Symbol</th>
                <th className="desk-only">Side</th>
                <th>Vol</th>
                <th>P&amp;L</th>
                <th>Opened (UTC+3)</th>
                <th className="desk-only">Comment</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p, i) => (
                <tr key={i}>
                  <td className="desk-only">{p.ea}</td>
                  <td>{p.symbol}</td>
                  <td className="desk-only">{p.side === 0 ? "BUY" : "SELL"}</td>
                  <td>{Number(p.volume).toFixed(2)}</td>
                  <td className={cls(Number(p.profit))}>{fmt$(Number(p.profit) + Number(p.swap ?? 0))}</td>
                  <td className="muted">{fmtOpenTime(p.open_time)}</td>
                  <td className="muted desk-only">{p.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DealsTable({ rows }: { rows: Deal[] }) {
  return (
    <div className="card" style={{ flex: 2, minWidth: 480 }}>
      <h3>Recent closed deals</h3>
      {rows.length === 0 ? (
        <div className="muted">- none in the last 30 days -</div>
      ) : (
        <div className="scroll-6">
        <table>
          <thead>
            <tr>
              <th>Opened</th>
              <th>Closed</th>
              <th>EA</th>
              <th>Symbol</th>
              <th>Side</th>
              <th>Vol</th>
              <th>P&amp;L</th>
              <th className="desk-only">Comment</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d, i) => {
              const closedTs = d.closed_at ? new Date(d.closed_at) : null;
              const openedTs = (d as any).opened_at ? new Date((d as any).opened_at) : null;
              const fmtTs = (x: Date | null) =>
                x ? x.toISOString().replace("T", " ").substring(5, 16) : "-";
              return (
                <tr key={i}>
                  <td className="muted">{fmtTs(openedTs)}</td>
                  <td className="muted">{fmtTs(closedTs)}</td>
                  <td>{d.ea}</td>
                  <td>{d.symbol}</td>
                  <td>{d.side === 0 ? "BUY" : "SELL"}</td>
                  <td>{Number(d.volume).toFixed(2)}</td>
                  <td className={cls(Number(d.profit))}>
                    {fmt$(Number(d.profit) + Number(d.swap ?? 0) + Number(d.commission ?? 0))}
                  </td>
                  <td className="desk-only muted" style={{ fontSize: 11, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {(d as any).comment || ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

function ageStr(iso: string | null | undefined) {
  if (!iso) return "-";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function LastLogsCard({ acct }: { acct: Account }) {
  const entries = Object.entries(acct.last_logs || {});

  // Highlight "interesting" events visually
  const eventClass = (m: string) => {
    const u = m.toUpperCase();
    if (u.includes("FAILED") || u.includes("KILL") || u.includes("HALT")) return "neg";
    if (u.startsWith("OPEN ") || u.includes("PROFIT_LOCK")) return "pos";
    if (u.startsWith("CLOSE ")) return "warn";
    return "muted";
  };

  return (
    <div className="card" style={{ flex: 2, minWidth: 360 }}>
      <h3>Recent EA events (last 24h)</h3>
      {entries.length === 0 && (
        <div className="muted" style={{ fontSize: 12, padding: "12px 4px" }}>
          No EA events received in the last 24h for this account.<br />
          If you just restarted: heartbeats fire every <code>Inp_HeartbeatTicks × Inp_TimerSec</code> seconds
          (default 30×30 = 15 min; lower <code>Inp_HeartbeatTicks</code> to 4 for ~2 min cadence).
          Also confirm the dashboard URL is in MT5&apos;s WebRequest allowlist and that
          <code>Inp_AccountTag</code> matches this account&apos;s tag exactly.
        </div>
      )}
      {entries.map(([ea, lines]) => (
        <div key={ea} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: "#98a3b3", marginBottom: 4, display: "flex", justifyContent: "space-between" }}>
            <span><strong style={{ color: "#e8ecf1" }}>{ea}</strong> · {lines.length} entries · last {ageStr(lines[0]?.ts)}</span>
          </div>
          <div style={{
            maxHeight: 380,
            overflowY: "auto",
            overflowX: "auto",
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
            border: "1px solid #232938",
            borderRadius: 4,
            padding: 6,
          }}>
            {lines.map((l, i) => (
              <div key={i} style={{ display: "flex", gap: 8, padding: "2px 0", whiteSpace: "nowrap" }}>
                <span className="muted" style={{ minWidth: 90, fontSize: 11 }}>{ageStr(l.ts)}</span>
                <span className={eventClass(l.message)}>{l.message}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AccountBlock({ acct }: { acct: Account }) {
  const [chart, setChart] = useState<"24h" | "7d" | "30d">("24h");
  const chartData = chart === "24h" ? acct.equity_24h : chart === "7d" ? acct.equity_7d : acct.equity_30d;

  const eaRows = Object.entries(acct.by_ea_today);

  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 18, margin: "16px 0 12px 0", display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <span>{statusDot(acct.last_seen)} {acct.tag}</span>
        <span className="muted" style={{ fontSize: 12 }}>
          #{acct.login} - {acct.server} - {acct.currency}
        </span>
        <ResetButton tag={acct.tag} />
      </h2>

      <div className="row">
        <div className="card" style={{ flex: 1, minWidth: 160 }}>
          <h3>Equity</h3>
          <div className="big">{fmt$(acct.equity)}</div>
          <div className="muted">bal {fmt$(acct.balance)}</div>
          <div className="muted" style={{ marginTop: 6 }}>
            day open: <span style={{ fontWeight: 600, color: "#e8ecf1" }}>{fmt$(acct.day_start_balance)}</span>
          </div>
          {(() => {
            // change = realized_today + floating_now
            const dayGain = (acct.balance - acct.day_start_balance) + acct.floating;
            const dayPct = acct.day_start_balance > 0 ? (dayGain / acct.day_start_balance) * 100 : 0;
            const arrow = dayGain > 0 ? "↑" : dayGain < 0 ? "↓" : "→";
            return (
              <div style={{ marginTop: 4, fontSize: 14, fontWeight: 600 }}
                   className={cls(dayGain)}>
                {arrow} {Math.abs(dayPct).toFixed(2)}%
              </div>
            );
          })()}
        </div>
        <div className="card" style={{ flex: 1, minWidth: 160 }}>
          <h3>Floating</h3>
          <div className={"big " + cls(acct.floating)}>{fmt$(acct.floating)}</div>
          <div className={"muted " + cls(acct.floating)}>
            {acct.day_start_balance > 0 ? fmtPct((acct.floating / acct.day_start_balance) * 100) : "-"} of day start
          </div>
          <div className="muted">{acct.open_positions.length} open</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 160 }}>
          <h3>Today (closed)</h3>
          <div className={"big " + cls(acct.pnl_today)}>{fmt$(acct.pnl_today)}</div>
          <div className={"muted " + cls(acct.pnl_today)}>
            {acct.day_start_equity > 0 ? fmtPct((acct.pnl_today / acct.day_start_equity) * 100) : "-"} of day start
          </div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 160 }}>
          <h3>Week</h3>
          <div className={"big " + cls(acct.pnl_week)}>{fmt$(acct.pnl_week)}</div>
          <div style={{ marginTop: 6, fontSize: 12, color: "#98a3b3" }}>
            Month: <span className={cls(acct.pnl_month)} style={{ fontWeight: 600 }}>{fmt$(acct.pnl_month)}</span>
          </div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 180 }}>
          <h3>Today by EA (closed)</h3>
          {eaRows.length === 0 ? (
            <div className="muted">- none -</div>
          ) : (
            <table style={{ marginTop: 2 }}>
              <tbody>
                {eaRows.map(([ea, v]) => (
                  <tr key={ea}>
                    <td>{ea}</td>
                    <td className={cls(v)} style={{ textAlign: "right" }}>{fmt$(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <DayHighLow acct={acct} />
      </div>

      {/* V52 proximity gauge + FTMO challenge progress — each renders only when relevant. */}
      <div className="row" style={{ marginTop: 12 }}>
        <V52ProximityCard acct={acct} />
        <FTMOChallengeCard acct={acct} />
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="tabs">
          {(["24h", "7d", "30d"] as const).map((k) => (
            <div key={k} className={"tab " + (chart === k ? "active" : "")} onClick={() => setChart(k)}>
              {k}
            </div>
          ))}
        </div>
        <EquityChart data={chartData} mode={chart} title="Equity (blue) vs Balance (green) - UTC+3" dayStart={acct.day_start_balance} />
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <PositionsTable rows={acct.open_positions} />
        <DealsTable rows={acct.recent_deals} />
      </div>

      <div style={{ marginTop: 12 }}>
        <LastLogsCard acct={acct} />
      </div>
    </div>
  );
}

function MobileSummaryCard({ acct, onClick }: { acct: Account; onClick: () => void }) {
  const dayGain = (acct.balance - acct.day_start_balance) + acct.floating;
  const dayPct = acct.day_start_balance > 0 ? (dayGain / acct.day_start_balance) * 100 : 0;
  const arrow = dayGain > 0 ? "↑" : dayGain < 0 ? "↓" : "→";

  // Build today's equity sparkline: filter equity_24h to broker-day start, plot equity.
  const sodMs = (() => {
    const n = tzShift(Date.now());
    n.setUTCHours(0, 0, 0, 0);
    return n.getTime() - TZ_OFFSET_H * 3600 * 1000;
  })();
  const sparkData = (acct.equity_24h || [])
    .filter((p) => new Date(p.ts).getTime() >= sodMs)
    .map((p) => ({ t: new Date(p.ts).getTime(), equity: Number(p.equity) }));

  return (
    <div className="card mobile-summary" onClick={onClick} role="button">
      <div className="mobile-summary-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {statusDot(acct.last_seen)} <strong>{acct.tag}</strong>
        </span>
        <span className={cls(dayGain)} style={{ fontSize: 12, fontWeight: 600 }}>
          {arrow} {Math.abs(dayPct).toFixed(2)}%
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "stretch" }}>
        {/* LEFT: numbers stacked */}
        <div style={{ flex: 1, textAlign: "left", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div>
            <div className="muted" style={{ fontSize: 10 }}>Equity</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{fmt$(acct.equity)}</div>
            <div className="muted" style={{ fontSize: 9 }}>bal {fmt$(acct.balance)}</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 10 }}>Floating</div>
            <div className={cls(acct.floating)} style={{ fontSize: 14, fontWeight: 600 }}>{fmt$(acct.floating)}</div>
            <div className={"muted " + cls(acct.pnl_today)} style={{ fontSize: 9 }}>today {fmt$(acct.pnl_today)}</div>
          </div>
        </div>
        {/* RIGHT: full-height intraday equity chart */}
        <div style={{ flex: 1.4, height: 110, minWidth: 0 }}>
          {sparkData.length >= 2 && acct.day_start_balance > 0 ? (
            <ResponsiveContainer>
              <LineChart data={sparkData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                {/* Domain must explicitly include day_start_balance, otherwise the
                    ReferenceLine renders OUTSIDE the chart's auto-fit range. */}
                <YAxis
                  hide
                  domain={[
                    (dataMin: number) => Math.min(dataMin, acct.day_start_balance) - Math.abs(acct.day_start_balance) * 0.0005,
                    (dataMax: number) => Math.max(dataMax, acct.day_start_balance) + Math.abs(acct.day_start_balance) * 0.0005,
                  ]}
                />
                <ReferenceLine y={acct.day_start_balance} stroke="#e9b94a" strokeDasharray="2 3" strokeWidth={1} />
                <Line
                  type="monotone"
                  dataKey="equity"
                  stroke={dayGain >= 0 ? "#6ab0ff" : "#e57373"}
                  dot={false}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="muted" style={{ fontSize: 10, textAlign: "center", lineHeight: "110px" }}>no data yet</div>
          )}
        </div>
      </div>
      <div className="muted" style={{ textAlign: "center", marginTop: 4, fontSize: 10 }}>
        tap for details
      </div>
    </div>
  );
}

export default function Page() {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [isMobile, setIsMobile] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 900);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    let alive = true;
    const fetchOnce = async () => {
      try {
        const r = await fetch("/api/data", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as Resp;
        if (alive) {
          setData(j);
          setErr(null);
        }
      } catch (e: any) {
        if (alive) setErr(e?.message || "fetch failed");
      }
    };
    fetchOnce();
    const id = setInterval(() => {
      setTick((t) => t + 1);
      fetchOnce();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (isMobile && expanded && data) {
    const acct = data.accounts.find((a) => a.tag === expanded);
    return (
      <div className="container wide">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "8px 0" }}>
          <button className="back-btn" onClick={() => setExpanded(null)}>back</button>
          <div className="muted">
            {err ? <span className="neg">error: {err}</span> : data ? `updated ${tzShift(data.fetched_at).toISOString().substring(11, 19)} ${TZ_LABEL}` : "loading..."}
          </div>
        </div>
        {acct ? <AccountBlock acct={acct} /> : <div className="card muted">account not found</div>}
      </div>
    );
  }

  return (
    <div className="container wide">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <h1 style={{ fontSize: 20, margin: "8px 0" }}>RD11 Dashboard</h1>
        <div className="muted">
          {err ? <span className="neg">error: {err}</span> : data ? `updated ${tzShift(data.fetched_at).toISOString().substring(11, 19)} ${TZ_LABEL}` : "loading..."}
        </div>
      </div>
      {data?.accounts?.length === 0 && (
        <div className="card">
          <div className="muted">No telemetry yet. Attach Telemetry_V1.mq5 to a chart on each VPS.</div>
        </div>
      )}


      {isMobile ? (
        <div className="mobile-summary-grid">
          {data?.accounts?.map((a) => (
            <MobileSummaryCard key={a.tag} acct={a} onClick={() => setExpanded(a.tag)} />
          ))}
        </div>
      ) : (
        <div className="accounts-grid">
          {data?.accounts?.map((a) => (
            <div key={a.tag} className="account-col">
              <AccountBlock acct={a} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
