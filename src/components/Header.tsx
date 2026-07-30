// src/components/Header.tsx
//
// Zone 1. Exactly 48px, and that budget is the reason the fund picker and
// quarter stepper live in Zone 2 instead: at 48px there is room for a title, a
// pill and four controls, and 9,300 searchable filers is not one of them.

import { t } from "../theme";

export type ViewId = "consensus" | "fund" | "filings";

const VIEWS: { id: ViewId; label: string }[] = [
  { id: "consensus", label: "Consensus" },
  { id: "fund", label: "Fund" },
  { id: "filings", label: "Filings" },
];

export type Freshness = "fresh" | "partial" | "nosession";

function FreshnessPill({ state, detail }: { state: Freshness; detail: string }) {
  // One dot, three meanings — green complete, amber the latest quarter is still
  // filling in, grey no host session.
  const color = state === "fresh" ? "#059669" : state === "partial" ? "#d97706" : "#9ca3af";
  return (
    <span
      title={detail}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px",
        borderRadius: 99, background: "#f9fafb", border: `1px solid ${t.borderSolid}`,
        fontSize: 11, color: t.textMuted, whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      {detail}
    </span>
  );
}

/**
 * The ticker pill shows the FUND COUNT rather than the company name.
 *
 * The issuer name is already in the matrix row and the drawer header; how many
 * of the tracked funds own it is the one thing this dashboard knows that
 * nothing else on the user's screen does.
 */
function TickerPill({ ticker, funds, onClick }: { ticker: string; funds?: number | null; onClick?: () => void }) {
  return (
    <button
      className="pressable"
      onClick={onClick}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "2px 10px",
        background: t.primaryLight, color: t.primaryText, borderRadius: 99,
        fontSize: 12, fontWeight: 600, border: `1px solid ${t.primaryBorder}`,
        cursor: onClick ? "pointer" : "default", fontFamily: "inherit",
      }}
    >
      <span style={{ width: 6, height: 6, background: "#6366f1", borderRadius: "50%" }} />
      {ticker}
      {funds != null && <span style={{ color: "#818cf8", fontWeight: 400 }}>· {funds} of 7 funds</span>}
    </button>
  );
}

export function Header({
  view, onView, context, ticker, tickerFunds, onTickerClick,
  freshness, freshnessDetail, onRefresh, refreshing,
}: {
  view: ViewId;
  onView: (v: ViewId) => void;
  context: string;
  ticker?: string | null;
  tickerFunds?: number | null;
  onTickerClick?: () => void;
  freshness: Freshness;
  freshnessDetail: string;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  return (
    <header
      style={{
        position: "sticky", top: 0, zIndex: 30,
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
        padding: "0 24px", height: 48, flexShrink: 0,
        background: t.headerBar, backdropFilter: "blur(8px)",
        borderBottom: `1px solid ${t.borderSolid}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span
          style={{
            width: 22, height: 22, borderRadius: 6, background: t.primary, color: "#fff",
            display: "grid", placeItems: "center", fontSize: 9, fontWeight: 800, flexShrink: 0,
          }}
        >
          13F
        </span>
        <h1 style={{ fontSize: 15, fontWeight: 700, color: t.textPrimary, margin: 0, whiteSpace: "nowrap" }}>
          13F Fund Tracker
        </h1>
        <span style={{ fontSize: 12, color: t.textHint, whiteSpace: "nowrap" }}>{context}</span>
        {ticker && <TickerPill ticker={ticker} funds={tickerFunds} onClick={onTickerClick} />}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <div style={{ display: "inline-flex", background: "#f3f4f6", borderRadius: 8, padding: 2, gap: 2 }}>
          {VIEWS.map((v) => {
            const active = v.id === view;
            return (
              <button
                key={v.id}
                className="pressable"
                onClick={() => onView(v.id)}
                aria-pressed={active}
                style={{
                  border: "none", cursor: "pointer", borderRadius: 6, padding: "4px 12px",
                  fontSize: 12, fontWeight: 600, fontFamily: "inherit",
                  background: active ? "#fff" : "transparent",
                  color: active ? t.textPrimary : t.textMuted,
                  boxShadow: active ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
                }}
              >
                {v.label}
              </button>
            );
          })}
        </div>

        <FreshnessPill state={freshness} detail={freshnessDetail} />

        <button
          className="pressable"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label="Refresh"
          title="Refresh"
          style={{
            width: 30, height: 30, borderRadius: 8, border: `1px solid ${t.borderSolid}`,
            background: "#fff", color: t.textMuted, cursor: refreshing ? "default" : "pointer",
            display: "grid", placeItems: "center", fontSize: 14, opacity: refreshing ? 0.5 : 1,
            fontFamily: "inherit",
          }}
        >
          {/* 600ms exceeds the 300ms UI budget on purpose: this is a status
              indicator showing work in flight, not a UI transition. */}
          <span style={refreshing ? { display: "inline-block", animation: "spin 600ms linear infinite" } : undefined}>
            ↻
          </span>
        </button>
      </div>
    </header>
  );
}
