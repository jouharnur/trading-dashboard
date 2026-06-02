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

// Compute today's FLOATING (unrealized) PnL high and low from the
// equity_24h snapshot stream. floating = equity - balance per snapshot.
function DayHighLow({ acct }: { acct: Account }) {
  // Start of broker-day (UTC+3) = today's UTC midnight + offset, shifted back
  const nowShifted = tzShift(Date.now());
  nowShifted.setUTCHours(0, 0, 0, 0);
  const sod = nowShifted.getTime() - TZ_OFFSET_H * 3600 * 1000;

  let high = acct.floating;
  let low = acct.floating;
  let hiTs: number | null = null;
  let loTs: number | null = null;

  for (const p of acct.equity_24h) {
    const t = new Date(p.ts).getTime();
    if (t < sod) continue;
    const f = Number(p.equity) - Number(p.balance);
    if (f > high) { high = f; hiTs = t; }
    if (f < low)  { low  = f; loTs = t; }
  }

  const spread = high - low;
  const fmtTime = (t: number | null) =>
    t == null ? "" : tzShift(t).toISOString().substring(11, 16) + " " + TZ_LABEL;

  return (
    <div className="card" style={{ flex: 1, minWidth: 200 }}>
      <h3>Today Floating High / Low</h3>
      <div className="muted">High</div>
      <div className={"big " + cls(high)}>{fmt$(high)}</div>
      <div className="muted" style={{ fontSize: 11 }}>{fmtTime(hiTs)}</div>
      <div className="muted" style={{ marginTop: 8 }}>Low</div>
      <div className={"big " + cls(low)}>{fmt$(low)}</div>
      <div className="muted" style={{ fontSize: 11 }}>{fmtTime(loTs)}</div>
      <div className="muted" style={{ marginTop: 6 }}>swing {fmt$(spread)}</div>
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
            <YAxis tick={{ fill: "#98a3b3", fontSize: 11 }} domain={["auto", "auto"]} />
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
            <Line type="monotone" dataKey="equity" stroke="#6ab0ff" dot={false} strokeWidth={2} />
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
  // Hide entirely when no EA on this account has posted logs.
  // (Only V52 is patched to POST; other accounts will have no entries.)
  if (entries.length === 0) return null;

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
      <h3>Recent EA events (V52)</h3>
      {entries.map(([ea, lines]) => (
        <div key={ea} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#98a3b3", marginBottom: 4 }}>
            <strong style={{ color: "#e8ecf1" }}>{ea}</strong> - last update {ageStr(lines[0]?.ts)}
          </div>
          <div style={{
            maxHeight: 220,
            overflowY: "auto",
            fontFamily: "ui-monospace, monospace",
            fontSize: 12,
            border: "1px solid #232938",
            borderRadius: 4,
            padding: 6,
          }}>
            {lines.map((l, i) => (
              <div key={i} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
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

      <div style={{ marginTop: 12 }}>
        <LastLogsCard acct={acct} />
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="tabs">
          {(["24h", "7d", "30d"] as const).map((k) => (
            <div key={k} className={"tab " + (chart === k ? "active" : "")} onClick={() => setChart(k)}>
              {k}
            </div>
          ))}
        </div>
        <EquityChart data={chartData} mode={chart} title="Equity (blue) vs Balance (green) - UTC+3" dayStart={acct.day_start_equity} />
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <PositionsTable rows={acct.open_positions} />
        <DealsTable rows={acct.recent_deals} />
      </div>
    </div>
  );
}

function MobileSummaryCard({ acct, onClick }: { acct: Account; onClick: () => void }) {
  const dayGain = (acct.balance - acct.day_start_balance) + acct.floating;
  const dayPct = acct.day_start_balance > 0 ? (dayGain / acct.day_start_balance) * 100 : 0;
  const arrow = dayGain > 0 ? "↑" : dayGain < 0 ? "↓" : "→";
  const ea = primaryEA(acct);

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
      <div className="mobile-summary-row" style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        <div>
          <div className="muted" style={{ fontSize: 10 }}>Equity</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{fmt$(acct.equity)}</div>
          <div className="muted" style={{ fontSize: 10 }}>bal {fmt$(acct.balance)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="muted" style={{ fontSize: 10 }}>Floating</div>
          <div className={cls(acct.floating)} style={{ fontSize: 15, fontWeight: 600 }}>{fmt$(acct.floating)}</div>
          <div className={"muted " + cls(acct.pnl_today)} style={{ fontSize: 10 }}>today {fmt$(acct.pnl_today)}</div>
        </div>
      </div>
      {sparkData.length >= 2 && acct.day_start_equity > 0 && (
        <div style={{ height: 50, marginTop: 8 }}>
          <ResponsiveContainer>
            <LineChart data={sparkData} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
              <YAxis hide domain={["auto", "auto"]} />
              <ReferenceLine y={acct.day_start_equity} stroke="#e9b94a" strokeDasharray="2 3" strokeWidth={1} />
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
        </div>
      )}
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
