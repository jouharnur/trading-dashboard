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
};

type Resp = { fetched_at: string; accounts: Account[] };

const POLL_MS = 10_000;

function fmt$(n: number | null | undefined) {
  if (n == null || isNaN(n as number)) return "—";
  const sign = n < 0 ? "-" : "";
  const v = Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  return `${sign}${v}`;
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

// Compute today's equity high and low from the equity_24h snapshot stream.
// Filters to >= start-of-day UTC, falls back to current equity if no data.
function DayHighLow({ acct }: { acct: Account }) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const sod = today.getTime();

  let high = acct.equity;
  let low = acct.equity;
  let hiTs: number | null = null;
  let loTs: number | null = null;

  for (const p of acct.equity_24h) {
    const t = new Date(p.ts).getTime();
    if (t < sod) continue;
    const e = Number(p.equity);
    if (e > high) { high = e; hiTs = t; }
    if (e < low)  { low  = e; loTs = t; }
  }

  const spread = high - low;
  const fmtTime = (t: number | null) =>
    t == null ? "" : new Date(t).toISOString().substring(11, 16) + " UTC";

  return (
    <div className="card" style={{ flex: 1, minWidth: 200 }}>
      <h3>Today High / Low</h3>
      <div className="muted">High</div>
      <div className="big pos">{fmt$(high)}</div>
      <div className="muted" style={{ fontSize: 11 }}>{fmtTime(hiTs)}</div>
      <div className="muted" style={{ marginTop: 8 }}>Low</div>
      <div className="big neg">{fmt$(low)}</div>
      <div className="muted" style={{ fontSize: 11 }}>{fmtTime(loTs)}</div>
      <div className="muted" style={{ marginTop: 6 }}>spread {fmt$(spread)}</div>
    </div>
  );
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Tick formatter that switches by chart-window mode.
//   24h → "HH:MM" UTC
//    7d → "Mon 14h" UTC (day-of-week + hour)
//   30d → "May 31" UTC (month + day)
function chartTickFormatter(mode: "24h" | "7d" | "30d") {
  return (v: number) => {
    const d = new Date(v);
    if (mode === "24h") {
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mm = String(d.getUTCMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    }
    if (mode === "7d") {
      const hh = String(d.getUTCHours()).padStart(2, "0");
      return `${DOW[d.getUTCDay()]} ${hh}h`;
    }
    // 30d
    return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
  };
}

function EquityChart({ data, title, mode }: { data: EquityPt[]; title: string; mode: "24h" | "7d" | "30d" }) {
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
                const d = new Date(v as number);
                return d.toISOString().replace("T", " ").substring(0, 19) + " UTC";
              }}
              formatter={(v: any) => fmt$(Number(v))}
            />
            <Line type="monotone" dataKey="equity" stroke="#38bdf8" dot={false} strokeWidth={2} />
            <Line type="monotone" dataKey="balance" stroke="#94a3b8" dot={false} strokeWidth={1} strokeDasharray="3 3" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function PositionsTable({ rows }: { rows: Position[] }) {
  return (
    <div className="card" style={{ flex: 2, minWidth: 480 }}>
      <h3>Open positions ({rows.length})</h3>
      {rows.length === 0 ? (
        <div className="muted">— no open positions —</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="desk-only">EA</th>
              <th>Symbol</th>
              <th className="desk-only">Side</th>
              <th>Vol</th>
              <th className="desk-only">Open</th>
              <th className="desk-only">Now</th>
              <th>P&amp;L</th>
              <th className="desk-only">Comment</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={i}>
                <td className="desk-only">{p.ea}</td>
                <td>{p.symbol}</td>
                <td className="desk-only">{p.side === 0 ? "BUY" : "SELL"}</td>
                <td>{Number(p.volume).toFixed(2)}</td>
                <td className="desk-only">{Number(p.open_price).toFixed(5)}</td>
                <td className="desk-only">{Number(p.current_price).toFixed(5)}</td>
                <td className={cls(Number(p.profit))}>{fmt$(Number(p.profit) + Number(p.swap ?? 0))}</td>
                <td className="muted desk-only">{p.comment}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DealsTable({ rows }: { rows: Deal[] }) {
  return (
    <div className="card" style={{ flex: 2, minWidth: 480 }}>
      <h3>Recent closed deals</h3>
      {rows.length === 0 ? (
        <div className="muted">— none in the last 30 days —</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>EA</th>
              <th>Symbol</th>
              <th>Side</th>
              <th>Vol</th>
              <th>P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d, i) => (
              <tr key={i}>
                <td className="muted">{new Date(d.closed_at).toLocaleString()}</td>
                <td>{d.ea}</td>
                <td>{d.symbol}</td>
                <td>{d.side === 0 ? "BUY" : "SELL"}</td>
                <td>{Number(d.volume).toFixed(2)}</td>
                <td className={cls(Number(d.profit))}>
                  {fmt$(Number(d.profit) + Number(d.swap ?? 0) + Number(d.commission ?? 0))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AccountBlock({ acct }: { acct: Account }) {
  const [chart, setChart] = useState<"24h" | "7d" | "30d">("24h");
  const chartData = chart === "24h" ? acct.equity_24h : chart === "7d" ? acct.equity_7d : acct.equity_30d;

  const eaRows = Object.entries(acct.by_ea_today);

  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 18, margin: "16px 0 12px 0" }}>
        {statusDot(acct.last_seen)} {acct.tag}{" "}
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
          #{acct.login} · {acct.server} · {acct.currency}
        </span>
      </h2>

      {/* Top strip */}
      <div className="row">
        <div className="card" style={{ flex: 1, minWidth: 160 }}>
          <h3>Equity</h3>
          <div className="big">{fmt$(acct.equity)}</div>
          <div className="muted">bal {fmt$(acct.balance)}</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 160 }}>
          <h3>Floating</h3>
          <div className={"big " + cls(acct.floating)}>{fmt$(acct.floating)}</div>
          <div className="muted">{acct.open_positions.length} open</div>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 160 }}>
          <h3>Today (closed)</h3>
          <div className={"big " + cls(acct.pnl_today)}>{fmt$(acct.pnl_today)}</div>
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
            <div className="muted">— none —</div>
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

      {/* Equity chart (full-width) */}
      <div style={{ marginTop: 12 }}>
        <div className="tabs">
          {(["24h", "7d", "30d"] as const).map((k) => (
            <div key={k} className={"tab " + (chart === k ? "active" : "")} onClick={() => setChart(k)}>
              {k}
            </div>
          ))}
        </div>
        <EquityChart data={chartData} mode={chart} title="Equity (blue) vs Balance (gray) — UTC" />
      </div>

      {/* Positions + Deals */}
      <div className="row" style={{ marginTop: 12 }}>
        <PositionsTable rows={acct.open_positions} />
        <DealsTable rows={acct.recent_deals} />
      </div>
    </div>
  );
}

function MobileSummaryCard({ acct, onClick }: { acct: Account; onClick: () => void }) {
  return (
    <div className="card mobile-summary" onClick={onClick} role="button">
      <div className="mobile-summary-header">
        {statusDot(acct.last_seen)} <strong>{acct.tag}</strong>
      </div>
      <div className="mobile-summary-row">
        <div>
          <div className="muted">Equity</div>
          <div className="big">{fmt$(acct.equity)}</div>
          <div className="muted">bal {fmt$(acct.balance)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="muted">Floating</div>
          <div className={"big " + cls(acct.floating)}>{fmt$(acct.floating)}</div>
          <div className={"muted " + cls(acct.pnl_today)}>today {fmt$(acct.pnl_today)}</div>
        </div>
      </div>
      <div className="muted" style={{ textAlign: "center", marginTop: 8, fontSize: 11 }}>
        tap for details
      </div>
    </div>
  );
}

export default function Page() {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [isMobile, setIsMobile] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Detect mobile viewport
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

  // Mobile expanded view: show only the selected account, with a back button
  if (isMobile && expanded && data) {
    const acct = data.accounts.find((a) => a.tag === expanded);
    return (
      <div className="container wide">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "8px 0" }}>
          <button className="back-btn" onClick={() => setExpanded(null)}>← back</button>
          <div className="muted">
            {err ? <span className="neg">error: {err}</span> : data ? `updated ${new Date(data.fetched_at).toLocaleTimeString()}` : "loading…"}
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
          {err ? <span className="neg">error: {err}</span> : data ? `updated ${new Date(data.fetched_at).toLocaleTimeString()}` : "loading…"}
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
