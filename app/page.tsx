"use client";

import { useEffect, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
  PieChart, Pie, Cell,
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
    <div className="card card-wide" style={{ flex: 1, minWidth: 320 }}>
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
    <div className="card card-wide" style={{ flex: 1, minWidth: 360 }}>
      <h3>FTMO Phase 1 progress</h3>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4 }}>
        <div>
          {/* Equity itself is already shown in the main Equity card; here we
              only need the change-vs-initial figure that's specific to the
              challenge metric. */}
          <span style={{ fontSize: 18, fontWeight: 700, color: dollarFromInit >= 0 ? "#7ec99e" : "#e57373" }}>
            {sgn}{fmt$(dollarFromInit)}
          </span>
          <span className="muted" style={{ fontSize: 13, marginLeft: 6 }}>
            ({sgn}{pctFromInit.toFixed(2)}%)
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
  // Day open = broker-day-start EQUITY (balance + floating at midnight UTC+3).
  // Using equity, not balance, so the comparison stays consistent with the
  // equity high/low we render below.
  const dayOpen = Number(acct.day_start_equity) || Number(acct.day_start_balance) || 0;

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

function chartTickFormatter(mode: "24h" | "today" | "7d" | "30d") {
  return (v: number) => {
    const d = tzShift(v);
    if (mode === "24h" || mode === "today") {
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

function EquityChart({ data, title, mode, dayStart }: { data: EquityPt[]; title: string; mode: "24h" | "today" | "7d" | "30d"; dayStart?: number }) {
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
    <div className="card card-wide" style={{ flex: 1, minWidth: 360, width: "100%" }}>
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
              width={70}
              tickFormatter={(v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 })}
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

// Clickable sortable column header. First click sorts descending; clicking
// the active column again flips direction. Used in PositionsTable + DealsTable.
function SortableTh(props: { label: string; k: string; sort: { key: string; dir: number }; setSort: (s: { key: string; dir: number }) => void; className?: string }) {
  const { label, k, sort, setSort, className } = props;
  const active = sort.key === k;
  const arrow = active ? (sort.dir === 1 ? " ↑" : " ↓") : "";
  return (
    <th
      className={className}
      onClick={() => setSort({ key: k, dir: active ? -sort.dir : -1 })}
      style={{ cursor: "pointer", userSelect: "none" }}
      title="Click to sort"
    >
      {label}{arrow}
    </th>
  );
}

function PositionsTable({ rows }: { rows: Position[] }) {
  const [sort, setSort] = useState({ key: "open_time", dir: -1 });
  const getVal = (r: any) => {
    switch (sort.key) {
      case "ea": return r.ea || "";
      case "symbol": return r.symbol || "";
      case "side": return Number(r.side ?? 0);
      case "volume": return Number(r.volume ?? 0);
      case "pnl": return Number(r.profit ?? 0) + Number(r.swap ?? 0);
      case "open_time": return new Date(r.open_time || 0).getTime();
      case "comment": return r.comment || "";
      default: return 0;
    }
  };
  const sorted = (rows as any[]).slice().sort((a: any, b: any) => {
    const va = getVal(a), vb = getVal(b);
    if (va < vb) return -sort.dir;
    if (va > vb) return sort.dir;
    return 0;
  });

  return (
    <div className="card card-wide" style={{ flex: 2, minWidth: 480 }}>
      <h3>Open positions ({sorted.length})</h3>
      {sorted.length === 0 ? (
        <div className="muted">- no open positions -</div>
      ) : (
        <div className="scroll-6">
          <table>
            <thead>
              <tr>
                <SortableTh label="EA" k="ea" sort={sort} setSort={setSort} />
                <SortableTh label="Symbol" k="symbol" sort={sort} setSort={setSort} />
                <SortableTh label="Side" k="side" sort={sort} setSort={setSort} className="desk-only" />
                <SortableTh label="Vol" k="volume" sort={sort} setSort={setSort} />
                <SortableTh label="P&L" k="pnl" sort={sort} setSort={setSort} />
                <SortableTh label="Opened (UTC+3)" k="open_time" sort={sort} setSort={setSort} />
                <SortableTh label="Comment" k="comment" sort={sort} setSort={setSort} className="desk-only" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((p, i) => (
                <tr key={i}>
                  <td><EaBadge ea={p.ea} /></td>
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
  const [sort, setSort] = useState({ key: "closed_at", dir: -1 });
  const getVal = (r: any) => {
    switch (sort.key) {
      case "opened_at": return new Date((r as any).opened_at || 0).getTime();
      case "closed_at": return new Date(r.closed_at || 0).getTime();
      case "ea": return r.ea || "";
      case "symbol": return r.symbol || "";
      case "side": return Number(r.side ?? 0);
      case "volume": return Number(r.volume ?? 0);
      case "pnl": return Number(r.profit ?? 0) + Number(r.swap ?? 0) + Number(r.commission ?? 0);
      case "comment": return (r as any).comment || "";
      default: return 0;
    }
  };
  const sorted = (rows as any[]).slice().sort((a: any, b: any) => {
    const va = getVal(a), vb = getVal(b);
    if (va < vb) return -sort.dir;
    if (va > vb) return sort.dir;
    return 0;
  });
  return (
    <div className="card card-wide" style={{ flex: 2, minWidth: 480 }}>
      <h3>Recent closed deals</h3>
      {sorted.length === 0 ? (
        <div className="muted">- none in the last 30 days -</div>
      ) : (
        <div className="scroll-6">
        <table>
          <thead>
            <tr>
              <SortableTh label="Opened" k="opened_at" sort={sort} setSort={setSort} />
              <SortableTh label="Closed" k="closed_at" sort={sort} setSort={setSort} />
              <SortableTh label="EA" k="ea" sort={sort} setSort={setSort} />
              <SortableTh label="Symbol" k="symbol" sort={sort} setSort={setSort} />
              <SortableTh label="Side" k="side" sort={sort} setSort={setSort} />
              <SortableTh label="Vol" k="volume" sort={sort} setSort={setSort} />
              <SortableTh label="P&L" k="pnl" sort={sort} setSort={setSort} />
              <SortableTh label="Comment" k="comment" sort={sort} setSort={setSort} className="desk-only" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((d: any, i: number) => {
              const closedTs = d.closed_at ? new Date(d.closed_at) : null;
              const openedTs = (d as any).opened_at ? new Date((d as any).opened_at) : null;
              const fmtTs = (x: Date | null) =>
                x ? x.toISOString().replace("T", " ").substring(5, 16) : "-";
              return (
                <tr key={i}>
                  <td className="muted">{fmtTs(openedTs)}</td>
                  <td className="muted">{fmtTs(closedTs)}</td>
                  <td><EaBadge ea={d.ea} /></td>
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

// Color-coded EA badge so V5+ vs V52 trades/events are instantly recognizable
// when both EAs are running on the same FTMO account.
function EaBadge({ ea }: { ea: string | null | undefined }) {
  const label = (ea || "?").toString();
  const u = label.toUpperCase();
  let bg = "#1a3a5c"; let fg = "#6ab0ff"; // default = V5+ blue
  if (u === "V52" || u.startsWith("V52")) { bg = "#3d2914"; fg = "#ffba6e"; } // V52 orange
  else if (u.includes("MM") || u.includes("MARKET")) { bg = "#2a1f3d"; fg = "#c79bff"; } // MM purple
  return (
    <span style={{
      display: "inline-block",
      padding: "1px 7px",
      borderRadius: 3,
      fontSize: 10,
      fontWeight: 600,
      background: bg,
      color: fg,
      letterSpacing: 0.3,
      whiteSpace: "nowrap",
    }}>{label}</span>
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

// Parse a log message into key=value pairs. Handles heartbeats
// ("bal=X equity=Y free=Z open=N ... | BAR=... eval=N entry=N ...")
// and events ("OPEN EA_GA L z=3.85 R=1100 a=1.89 b=1.63").
type LogParse = { tag: string; pairs: Record<string, string>; raw: string };
function parseLogPairs(msg: string): LogParse {
  let tag = "";
  const firstWordMatch = msg.match(/^([A-Z][A-Z0-9_+]{1,})\b/);
  if (firstWordMatch) tag = firstWordMatch[1];
  const pairs: Record<string, string> = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)=([^\s|]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(msg)) !== null) {
    pairs[m[1]] = m[2];
  }
  return { tag, pairs, raw: msg };
}

type LogCol = { key: string; label: string; width: number; align?: "left" | "right" };

const V5_HB_COLS: LogCol[] = [
  { key: "equity",     label: "equity", width: 90,  align: "right" },
  { key: "bal",        label: "bal",    width: 90,  align: "right" },
  { key: "free",       label: "free",   width: 90,  align: "right" },
  { key: "open",       label: "open",   width: 40,  align: "right" },
  { key: "BAR",        label: "bar",    width: 110, align: "left" },
  { key: "eval",       label: "eval",   width: 36,  align: "right" },
  { key: "entry",      label: "ent",    width: 36,  align: "right" },
  { key: "quiet",      label: "quiet",  width: 36,  align: "right" },
  { key: "skip_vol",   label: "vol",    width: 36,  align: "right" },
  { key: "skip_lossz", label: "lossz",  width: 36,  align: "right" },
  { key: "skip_mkt",   label: "mkt",    width: 36,  align: "right" },
];
const V52_HB_COLS: LogCol[] = [
  { key: "open",   label: "open",   width: 50,  align: "right" },
  { key: "equity", label: "equity", width: 95,  align: "right" },
  { key: "R",      label: "R",      width: 75,  align: "right" },
  { key: "maxZ",   label: "maxZ",   width: 50,  align: "right" },
  { key: "need",   label: "need",   width: 40,  align: "right" },
  { key: "market", label: "market", width: 60,  align: "left" },
];
const EVENT_COLS: LogCol[] = [
  { key: "__tag",  label: "event",  width: 130, align: "left" },
  { key: "__rest", label: "detail", width: 380, align: "left" },
];

function classifyRow(p: LogParse): { cols: LogCol[]; rowColor?: string } {
  const u = p.raw.toUpperCase();
  if (u.includes("FAILED") || u.includes("ABS_KILL") || u.includes("DAILY_HALT") || u.startsWith("DASH_FAIL")) {
    return { cols: EVENT_COLS, rowColor: "#e57373" };
  }
  if (p.raw.startsWith("OPEN ") || u.includes("PROFIT_LOCK")) {
    return { cols: EVENT_COLS, rowColor: "#7ec99e" };
  }
  if (p.raw.startsWith("CLOSE ") || p.raw.startsWith("CORR_SKIP")) {
    return { cols: EVENT_COLS, rowColor: "#e9b94a" };
  }
  if ("equity" in p.pairs && "R" in p.pairs) return { cols: V52_HB_COLS };
  if ("equity" in p.pairs && "bal" in p.pairs) return { cols: V5_HB_COLS };
  return { cols: EVENT_COLS };
}

// Per-symbol P&L breakdown — twin pie charts (wins / losses).
// Aggregates net P&L (profit + swap + commission) per symbol from recent_deals,
// splits into positive/negative buckets, slice size = absolute contribution.
function SymbolPnLCard({ rows }: { rows: Deal[] }) {
  const bySymbol: Record<string, number> = {};
  for (const d of rows || []) {
    const sym = d.symbol || "?";
    const pnl = Number(d.profit ?? 0) + Number(d.swap ?? 0) + Number(d.commission ?? 0);
    bySymbol[sym] = (bySymbol[sym] || 0) + pnl;
  }
  const entries = Object.entries(bySymbol);
  const winners = entries.filter(([_, v]) => v > 0).map(([name, value]) => ({ name, value: Math.round(value) })).sort((a, b) => b.value - a.value);
  const losers = entries.filter(([_, v]) => v < 0).map(([name, value]) => ({ name, value: Math.round(-value) })).sort((a, b) => b.value - a.value);
  const totalWin = winners.reduce((s, w) => s + w.value, 0);
  const totalLoss = losers.reduce((s, l) => s + l.value, 0);
  const net = totalWin - totalLoss;
  const GREEN = ["#7ec99e","#9bd6b3","#b2dcc2","#c8e4d0","#aac6b6","#92b8a4","#79aa92","#60998a","#48887c","#33786e","#1c685f","#0a5852"];
  const RED   = ["#d68a85","#e0a09b","#e8b5b1","#eec7c4","#cf7973","#c46862","#b85852","#ad4843","#9d3a35","#8c2d28","#7a201c","#671513"];
  if (winners.length === 0 && losers.length === 0) {
    return (
      <div className="card card-wide" style={{ flex: 2, minWidth: 480 }}>
        <h3>P&amp;L by symbol (last 30d)</h3>
        <div className="muted">- no closed deals yet -</div>
      </div>
    );
  }
  const labelFn = (entry: any) => entry.percent > 0.04 ? entry.name : "";
  return (
    <div className="card card-wide" style={{ flex: 2, minWidth: 480 }}>
      <h3>P&amp;L by symbol (last 30d)</h3>
      <div style={{ display: "flex", gap: 8, fontSize: 12, marginBottom: 8, color: "#98a3b3", flexWrap: "wrap" }}>
        <span>Net <strong className={cls(net)}>{fmt$(net)}</strong></span>
        <span>·</span>
        <span>Wins <span className="pos">{fmt$(totalWin)}</span></span>
        <span>·</span>
        <span>Losses <span className="neg">{fmt$(-totalLoss)}</span></span>
        <span>·</span>
        <span>{winners.length} winning, {losers.length} losing</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: "#7ec99e", textAlign: "center", marginBottom: 4 }}>Profit contributors</div>
          {winners.length === 0 ? (
            <div className="muted" style={{ textAlign: "center", padding: 30, fontSize: 12 }}>- none -</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={winners} dataKey="value" nameKey="name" outerRadius={85} label={labelFn} labelLine={false}>
                  {winners.map((_, i) => <Cell key={i} fill={GREEN[i % GREEN.length]} />)}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "#1a2030", border: "1px solid #232938", fontSize: 12 }}
                  formatter={(v: any, _n: any, p: any) => [`${fmt$(Number(v))} (${(p.percent*100).toFixed(0)}%)`, p.payload.name]}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
        <div>
          <div style={{ fontSize: 11, color: "#d68a85", textAlign: "center", marginBottom: 4 }}>Loss contributors</div>
          {losers.length === 0 ? (
            <div className="muted" style={{ textAlign: "center", padding: 30, fontSize: 12 }}>- none -</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={losers} dataKey="value" nameKey="name" outerRadius={85} label={labelFn} labelLine={false}>
                  {losers.map((_, i) => <Cell key={i} fill={RED[i % RED.length]} />)}
                </Pie>
                <Tooltip
                  contentStyle={{ background: "#1a2030", border: "1px solid #232938", fontSize: 12 }}
                  formatter={(v: any, _n: any, p: any) => [`${fmt$(-Number(v))} (${(p.percent*100).toFixed(0)}%)`, p.payload.name]}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}

function LastLogsCard({ acct }: { acct: Account }) {
  const entries = Object.entries(acct.last_logs || {});

  return (
    <div className="card card-wide" style={{ flex: 2, minWidth: 360 }}>
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
      {entries.map(([ea, lines]) => {
        const parsed = lines.map((l) => parseLogPairs(l.message));
        // Header columns come from the first heartbeat row so they reflect the
        // dominant format. Event rows in the body still render with their own
        // wider event/detail columns.
        const firstHb = parsed.find((p) => "equity" in p.pairs);
        const headerCols = firstHb ? classifyRow(firstHb).cols : EVENT_COLS;
        return (
          <div key={ea} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: "#98a3b3", marginBottom: 4, display: "flex", alignItems: "center", gap: 8 }}>
              <EaBadge ea={ea} />
              <span>· {lines.length} entries · last {ageStr(lines[0]?.ts)}</span>
            </div>
            <div style={{
              maxHeight: 380,
              overflowY: "auto",
              overflowX: "auto",
              fontFamily: "ui-monospace, monospace",
              fontSize: 11,
              border: "1px solid #232938",
              borderRadius: 4,
              padding: 6,
            }}>
              <div style={{ display: "flex", gap: 6, padding: "2px 0 4px 0", borderBottom: "1px solid #1e2330", color: "#6e7787", position: "sticky", top: -6, background: "#141821" }}>
                <span style={{ minWidth: 70, fontSize: 10 }}>time</span>
                {headerCols.map((c) => (
                  <span key={c.key} style={{ minWidth: c.width, fontSize: 10, textAlign: c.align ?? "left" }}>{c.label}</span>
                ))}
              </div>
              {lines.map((l, i) => {
                const p = parsed[i];
                const cls = classifyRow(p);
                return (
                  <div key={i} style={{ display: "flex", gap: 6, padding: "2px 0", whiteSpace: "nowrap", borderBottom: i < lines.length - 1 ? "1px dotted #1a1f2a" : "none" }}>
                    <span className="muted" style={{ minWidth: 70, fontSize: 10 }}>{ageStr(l.ts)}</span>
                    {cls.cols.map((c) => {
                      let v: string;
                      if (c.key === "__tag") v = p.tag || (p.raw.split(" ")[0] ?? "-");
                      else if (c.key === "__rest") v = p.raw.replace(/^[A-Z][A-Z0-9_+]+\s*/, "").trim();
                      else v = p.pairs[c.key] ?? "-";
                      return (
                        <span key={c.key} style={{
                          minWidth: c.width,
                          fontSize: 11,
                          textAlign: c.align ?? "left",
                          color: cls.rowColor ?? "#cfd5de",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }} title={c.key === "__rest" ? p.raw : `${c.key}=${v}`}>{v}</span>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Parses configured EA settings out of recent heartbeat / init log messages.
// V52 init: "FIXED mode: $1000/R ... DailyHalt=$4000, 11 pairs M15"
// V5+ init: "[Init] ACCT10. Risk=1.00%, ML=0.00, MaxLayers=3, Trade=T, FTMO=T"
// V5+ DAY_OPEN: "DAY_OPEN equity=101748.67 halt_thresh=1000.00"
// Renders as collapsible <details> so it doesn't take screen space by default.
function SettingsCard({ acct }: { acct: Account }) {
  const allLogs = Object.values(acct.last_logs || {}).flat();
  const findMsg = (re: RegExp): string | null => {
    for (const l of allLogs) {
      if (l && typeof l.message === "string" && re.test(l.message)) return l.message;
    }
    return null;
  };
  const v52Init = findMsg(/DailyHalt=\$[\d,.]+.*pairs/i);
  const v5Init = findMsg(/\[Init\].*Risk=/i);
  const dayOpen = findMsg(/DAY_OPEN.*halt_thresh=/i);
  const kv = (msg: string | null, re: RegExp): string | null => {
    if (!msg) return null;
    const m = msg.match(re);
    return m ? m[1] : null;
  };
  const v52 = {
    mode: kv(v52Init, /^(\w+)\s+mode/),
    perR: kv(v52Init, /\$([\d,]+)\/R/),
    dailyHalt: kv(v52Init, /DailyHalt=\$([\d,]+)/),
    pairs: kv(v52Init, /(\d+)\s*pairs/),
  };
  const v5 = {
    risk: kv(v5Init, /Risk=([\d.]+)%/),
    maxLayers: kv(v5Init, /MaxLayers=(\d+)/),
    trade: kv(v5Init, /Trade=(\w)/),
    ftmo: kv(v5Init, /FTMO=(\w)/),
    haltThresh: kv(dayOpen, /halt_thresh=([\d.]+)/),
  };
  const hasV52 = Object.values(v52).some((x) => x !== null);
  const hasV5 = Object.values(v5).some((x) => x !== null);
  if (!hasV52 && !hasV5) return null;
  const row = (label: string, val: string | null) => (
    val ? (
      <div style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", borderBottom: "1px dashed #2a3340" }}>
        <span className="muted">{label}</span>
        <span style={{ fontWeight: 600 }}>{val}</span>
      </div>
    ) : null
  );
  return (
    <div className="card card-wide" style={{ flex: 2, minWidth: 480 }}>
      <details>
        <summary style={{ cursor: "pointer", userSelect: "none", padding: "4px 0", fontWeight: 600 }}>
          Strategy settings <span className="muted" style={{ fontSize: 11, fontWeight: "normal" }}>(parsed from heartbeats)</span>
        </summary>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 10, fontSize: 12 }}>
          {hasV52 && (
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>V52</div>
              {row("Mode", v52.mode)}
              {row("Per R ($)", v52.perR)}
              {row("Daily halt ($)", v52.dailyHalt)}
              {row("Pairs", v52.pairs)}
            </div>
          )}
          {hasV5 && (
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>V5+</div>
              {row("Risk %", v5.risk)}
              {row("Max layers", v5.maxLayers)}
              {row("Trade enabled", v5.trade)}
              {row("FTMO mode", v5.ftmo)}
              {row("Halt thresh ($)", v5.haltThresh)}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

function AccountBlock({ acct }: { acct: Account }) {
  const [chart, setChart] = useState<"24h" | "today" | "7d" | "30d">("24h");
  // The yellow ReferenceLine is pinned to broker-day-start equity. The line
  // is invariant to intraday trade closes (closes shift balance and floating
  // by equal-and-opposite amounts; equity is unaffected by the close itself).
  // "today" tab additionally trims the x-axis to the broker day. The default
  // "24h" tab shows a rolling 24-hour window for context.
  const sodMsForChart = (() => {
    const n = tzShift(Date.now());
    n.setUTCHours(0, 0, 0, 0);
    return n.getTime() - TZ_OFFSET_H * 3600 * 1000;
  })();
  const chartData =
    chart === "today"
      ? (acct.equity_24h || []).filter((p) => new Date(p.ts).getTime() >= sodMsForChart)
      : chart === "24h"
        ? acct.equity_24h
        : chart === "7d"
          ? acct.equity_7d
          : acct.equity_30d;

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
            day open: <span style={{ fontWeight: 600, color: "#e8ecf1" }}>{fmt$(acct.day_start_equity)}</span>
          </div>
          {(() => {
            // change = current equity vs equity at broker-day-start.
            // Using day_start_equity (not day_start_balance) so the comparison
            // is invariant to trades closing during the day: a trade close
            // simultaneously increases balance and decreases floating by the
            // same amount, so equity (= balance + floating) is unaffected by
            // the close itself — only by real PnL movement. The arrow direction
            // therefore stays pinned to the actual day's PnL.
            const baseline = acct.day_start_equity > 0 ? acct.day_start_equity : acct.day_start_balance;
            const dayGain = acct.equity - baseline;
            const dayPct = baseline > 0 ? (dayGain / baseline) * 100 : 0;
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
            {(() => {
              const base = acct.day_start_equity > 0 ? acct.day_start_equity : acct.day_start_balance;
              return base > 0 ? fmtPct((acct.floating / base) * 100) : "-";
            })()} of day start
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
          {(["24h", "today", "7d", "30d"] as const).map((k) => (
            <div key={k} className={"tab " + (chart === k ? "active" : "")} onClick={() => setChart(k)}>
              {k}
            </div>
          ))}
        </div>
        <EquityChart data={chartData} mode={chart} title="Equity (blue) vs Balance (green) - UTC+3" dayStart={acct.day_start_equity > 0 ? acct.day_start_equity : acct.day_start_balance} />
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <PositionsTable rows={acct.open_positions} />
        <DealsTable rows={acct.recent_deals} />
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <SymbolPnLCard rows={acct.recent_deals} />
      </div>

      {acct.tag === "FTMO" && (
        <div style={{ marginTop: 12 }}>
          <CrossCheckCard tag={acct.tag} />
        </div>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <SettingsCard acct={acct} />
      </div>

      <div style={{ marginTop: 12 }}>
        <LastLogsCard acct={acct} />
      </div>
    </div>
  );
}

type CrossCheck = {
  date: string;
  account: string;
  last_updated: string;
  v52: {
    bars_evaluated: number;
    bars_with_signals: number;
    max_z_today: number;
    signal_count: number;
    matched_count: number;
    match_rate_pct: number | null;
    trades_today: number;
    day_pnl_usd: number;
    expected_median_usd: number;
    vs_expected: number;
    signaling_pairs_today: string[];
    match_detail: Array<{ bar_time: string; pair: string; z: number; matched_deal: boolean; pnl_usd?: number }>;
  };
  v5plus: {
    trades_today: number;
    day_pnl_usd: number;
    expected_median_usd: number;
    vs_expected: number;
  };
  combined: {
    day_pnl_usd: number;
    expected_median_usd: number;
    vs_expected: number;
    ftmo_floor_distance_usd: number;
    ftmo_phase1_progress_pct: number;
  };
  flags: string[];
};

function CrossCheckCard({ tag }: { tag: string }) {
  const [data, setData] = useState<CrossCheck | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let abort = false;
    const load = async () => {
      try {
        const r = await fetch(`/api/cross-check?account=${tag}`, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as CrossCheck;
        if (!abort) { setData(j); setErr(null); }
      } catch (e: any) {
        if (!abort) setErr(String(e?.message ?? e));
      }
    };
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => { abort = true; clearInterval(id); };
  }, [tag]);

  if (err) return <div className="card"><div className="card-h">Live vs Backtest</div><div style={{ padding: 12, color: "#c66" }}>Error: {err}</div></div>;
  if (!data) return <div className="card"><div className="card-h">Live vs Backtest</div><div style={{ padding: 12, opacity: 0.6 }}>Loading...</div></div>;

  const pnlClass = (n: number) => (n >= 0 ? "pos" : "neg");
  const flagSeverity = data.flags.length === 0 ? "ok" : "warn";

  return (
    <div className="card">
      <div className="card-h">
        Live vs Backtest <span style={{ opacity: 0.5, fontWeight: "normal", fontSize: 12 }}>{data.date}</span>
        {flagSeverity === "ok" ? (
          <span style={{ marginLeft: 8, color: "#4caf50", fontSize: 12 }}>clean</span>
        ) : (
          <span style={{ marginLeft: 8, color: "#ef5350", fontSize: 12 }}>{data.flags.length} flag(s)</span>
        )}
      </div>
      <div style={{ padding: 12, fontSize: 13, lineHeight: 1.6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <div style={{ fontSize: 11, opacity: 0.6, textTransform: "uppercase", letterSpacing: 0.5 }}>Combined day P&amp;L</div>
          <div>
            <span className={pnlClass(data.combined.day_pnl_usd)} style={{ fontSize: 18, fontWeight: 600 }}>{fmt$(data.combined.day_pnl_usd)}</span>
            <span style={{ marginLeft: 6, opacity: 0.6 }}>vs median {fmt$(data.combined.expected_median_usd)}</span>
            <span className={pnlClass(data.combined.vs_expected)} style={{ marginLeft: 6, fontSize: 12 }}>
              ({data.combined.vs_expected >= 0 ? "+" : ""}{fmt$(data.combined.vs_expected)})
            </span>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 10 }}>
          <div style={{ background: "rgba(255,224,178,0.12)", padding: 8, borderRadius: 6, borderLeft: "3px solid #ffb74d" }}>
            <div style={{ fontSize: 11, opacity: 0.7, fontWeight: 600 }}>V52 (M15 stat-arb)</div>
            <div style={{ marginTop: 4 }}>
              {data.v52.trades_today} trade(s) <span className={pnlClass(data.v52.day_pnl_usd)}>{fmt$(data.v52.day_pnl_usd)}</span>
            </div>
            <div style={{ opacity: 0.6, fontSize: 11 }}>median {fmt$(data.v52.expected_median_usd)}</div>
            <div style={{ marginTop: 4, fontSize: 11 }}>
              {data.v52.bars_evaluated} bars, {data.v52.bars_with_signals} signal(s), peak |z|={data.v52.max_z_today}
            </div>
            {data.v52.match_rate_pct !== null && (
              <div style={{ fontSize: 11, opacity: 0.7 }}>
                match rate: <span style={{ color: data.v52.match_rate_pct >= 80 ? "#4caf50" : "#ef5350" }}>{data.v52.match_rate_pct}%</span>
                {" "}({data.v52.matched_count}/{data.v52.signal_count})
              </div>
            )}
          </div>

          <div style={{ background: "rgba(187,222,251,0.12)", padding: 8, borderRadius: 6, borderLeft: "3px solid #64b5f6" }}>
            <div style={{ fontSize: 11, opacity: 0.7, fontWeight: 600 }}>V5+ (H4 stat-arb)</div>
            <div style={{ marginTop: 4 }}>
              {data.v5plus.trades_today} trade(s) <span className={pnlClass(data.v5plus.day_pnl_usd)}>{fmt$(data.v5plus.day_pnl_usd)}</span>
            </div>
            <div style={{ opacity: 0.6, fontSize: 11 }}>median {fmt$(data.v5plus.expected_median_usd)}</div>
            <div style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }}>
              regime filter: <span style={{ opacity: 0.5 }}>monitored via logs</span>
            </div>
          </div>
        </div>

        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 8, fontSize: 11, opacity: 0.75 }}>
          FTMO floor distance: <span className={pnlClass(data.combined.ftmo_floor_distance_usd)}>{fmt$(data.combined.ftmo_floor_distance_usd)}</span>
          {" "}
          Phase 1 progress: {data.combined.ftmo_phase1_progress_pct}%
        </div>

        {data.flags.length > 0 && (
          <div style={{ marginTop: 10, borderTop: "1px solid #ef5350", paddingTop: 8 }}>
            {data.flags.map((f, i) => (
              <div key={i} style={{ color: "#ef5350", fontSize: 12, marginBottom: 2 }}>{f}</div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 8, fontSize: 10, opacity: 0.4 }}>
          Last update: {ageStr(data.last_updated)}, auto-refresh 5 min
        </div>
      </div>
    </div>
  );
}

function MobileSummaryCard({ acct, onClick }: { acct: Account; onClick: () => void }) {
  // Pin both the arrow and the chart reference line to broker-day-start equity.
  // This is invariant to intraday trade closes — a close shifts balance and
  // floating in opposite directions by the same amount, so equity (the
  // comparison value) is unaffected by the close itself.
  const baseline = acct.day_start_equity > 0 ? acct.day_start_equity : acct.day_start_balance;
  const dayGain = acct.equity - baseline;
  const dayPct = baseline > 0 ? (dayGain / baseline) * 100 : 0;
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
          {sparkData.length >= 2 && baseline > 0 ? (
            <ResponsiveContainer>
              <LineChart data={sparkData} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                {/* Domain must explicitly include the day-open baseline, otherwise
                    the ReferenceLine renders OUTSIDE the chart's auto-fit range. */}
                <YAxis
                  hide
                  domain={[
                    (dataMin: number) => Math.min(dataMin, baseline) - Math.abs(baseline) * 0.0005,
                    (dataMax: number) => Math.max(dataMax, baseline) + Math.abs(baseline) * 0.0005,
                  ]}
                />
                <ReferenceLine y={baseline} stroke="#e9b94a" strokeDasharray="2 3" strokeWidth={1} />
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