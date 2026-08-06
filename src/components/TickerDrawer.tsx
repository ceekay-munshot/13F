// src/components/TickerDrawer.tsx
//
// Ticker drill-down. Plan §6.6: a 480px right-side drawer, not a modal and not
// an in-place row expansion.
//
// WHY A DRAWER, AND WHY ABSOLUTE
// ------------------------------
// It is `position: absolute` inside the shell (see .drawer in styles.css), so
// opening it never reflows Zone 2 — which means no Recharts container
// re-measures and no chart replays its entrance behind it. In-place row
// expansion would also destroy the column alignment that makes the matrix
// readable, and a modal would cover the matrix you are trying to read against.
//
// WHERE THE DATA COMES FROM
// -------------------------
// Nowhere new. Everything here is derived from the rows ConsensusView has
// already loaded — the per-fund cells on a ConsensusRow, plus the holder
// history it computes for the sparklines. There is no `security/{issuer}` fetch
// and no extra artifact to build, so the drawer costs one render, not a round
// trip.
//
// NO CUSIP. The row carries issuerId and ticker; the licensed identifier never
// left the ingest, and `npm run guard` fails the build if it appears here.

import { useEffect, useMemo, useRef } from "react";
import { t, ACTION_COLORS } from "../theme";
import { usd, pct, pp, count } from "../lib/format";
import { periodLabel } from "../lib/format";
import type { ConsensusRow } from "../lib/consensus";
import type { FundInput } from "../lib/consensus";

const GLYPH: Record<string, string> = {
  NEW: "★", ADDED: "▲", HELD: "▪", TRIMMED: "▼", EXITED: "✕",
};

/** Holder count over the trailing quarters — "is the herd arriving or leaving". */
function HolderTrend({ counts, total }: { counts: number[]; total: number }) {
  if (counts.length < 2) return null;
  const max = Math.max(total, ...counts, 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 46 }}>
      {counts.map((c, i) => {
        const last = i === counts.length - 1;
        return (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
            <div
              style={{
                width: "100%",
                height: Math.max(2, (c / max) * 34),
                background: last ? t.primary : "#c7d2fe",
                borderRadius: 2,
              }}
              title={`${c} of ${total} funds`}
            />
            <span style={{ fontSize: 9, color: last ? t.textSecondary : t.textHint, fontVariantNumeric: "tabular-nums" }}>
              {c}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function TickerDrawer({
  row, funds, history, period, open, onClose, onFund,
}: {
  row: ConsensusRow | null;
  funds: FundInput[];
  /** issuerId -> holder count per quarter, oldest first. */
  history: Map<string, number[]>;
  period: string;
  open: boolean;
  onClose: () => void;
  onFund: (cik: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes. Bound on the document so it works wherever focus sits, and
  // only while open so it cannot swallow Escape from anything else.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Move focus in on open so the panel is immediately keyboard-operable.
  useEffect(() => { if (open) closeRef.current?.focus(); }, [open, row?.issuerId]);

  const holders = useMemo(() => {
    if (!row) return [];
    return funds
      .map((f) => ({ fund: f, cell: row.cells[f.cik] }))
      .filter((h) => h.cell)
      .sort((a, b) => (b.cell!.weight ?? 0) - (a.cell!.weight ?? 0));
  }, [row, funds]);

  const trend = row ? history.get(row.issuerId) ?? [] : [];
  const qoqHolders = trend.length >= 2 ? trend[trend.length - 1] - trend[trend.length - 2] : null;
  const present = funds.filter((f) => !f.missing).length;

  return (
    <>
      <div className="scrim" data-state={open ? "open" : "closed"} onClick={onClose} aria-hidden="true" />
      <aside
        className="drawer"
        data-state={open ? "open" : "closed"}
        role="dialog"
        aria-label={row ? `${row.ticker ?? row.name} detail` : "Security detail"}
        aria-hidden={!open}
      >
        {row && (
          <>
            <header
              style={{
                display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12,
                padding: "14px 16px", borderBottom: "1px solid #e5e7eb", flexShrink: 0,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 16, fontWeight: 700, color: t.textPrimary }}>{row.ticker ?? "—"}</span>
                  {row.shareClasses > 1 && (
                    <span style={{ fontSize: 10, fontWeight: 600, color: t.textMuted, background: "#f3f4f6", padding: "1px 6px", borderRadius: 5 }}>
                      {row.shareClasses} share classes
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11.5, color: t.textHint, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {row.name}
                </div>
              </div>
              <button
                ref={closeRef}
                className="pressable"
                onClick={onClose}
                aria-label="Close"
                style={{
                  border: "1px solid #e5e7eb", background: "#fff", borderRadius: 8, width: 26, height: 26,
                  cursor: "pointer", color: t.textMuted, fontSize: 14, lineHeight: 1, flexShrink: 0,
                }}
              >
                ✕
              </button>
            </header>

            <div style={{ flex: 1, overflow: "auto" }}>
              {/* The single most valuable sentence this product can say about a
                  name: how many of the tracked managers own it, and whether
                  that number is rising. */}
              <div style={{ padding: "12px 16px", borderBottom: "1px solid #f3f4f6", display: "flex", gap: 18, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: t.textHint, letterSpacing: "0.05em" }}>HELD BY</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: t.textPrimary }}>
                    {row.fundCount}<span style={{ fontSize: 12, color: t.textMuted, fontWeight: 500 }}> of {present}</span>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: t.textHint, letterSpacing: "0.05em" }}>COMBINED</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: t.textPrimary }}>{usd(row.combinedValue)}</div>
                </div>
                {/* The same "total weight" the overlap list ranks by, so a name
                    opened from that list shows the number it was ranked on. */}
                <div title="Each holder's own portfolio weight, added up — not a share of the group's money.">
                  <div style={{ fontSize: 10, fontWeight: 600, color: t.textHint, letterSpacing: "0.05em" }}>TOTAL WEIGHT</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: t.textPrimary }}>
                    {pct(row.sumWeight)}
                    <span style={{ fontSize: 12, color: t.textMuted, fontWeight: 500 }}> · {pct(row.avgWeight)} avg</span>
                  </div>
                </div>
                {qoqHolders != null && (
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 600, color: t.textHint, letterSpacing: "0.05em" }}>HOLDERS QoQ</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: qoqHolders > 0 ? "#059669" : qoqHolders < 0 ? "#dc2626" : t.textMuted }}>
                      {qoqHolders > 0 ? "+" : ""}{qoqHolders}
                    </div>
                  </div>
                )}
              </div>

              {trend.length >= 2 && (
                <div style={{ padding: "12px 16px", borderBottom: "1px solid #f3f4f6" }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, marginBottom: 8 }}>
                    Funds holding, last {trend.length} quarters
                  </div>
                  <HolderTrend counts={trend} total={present} />
                </div>
              )}

              {/* WHO HOLDS IT — the reason the drawer exists. */}
              <div style={{ padding: "12px 16px 4px" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: t.textSecondary, marginBottom: 6 }}>
                  Holders in {periodLabel(period)}
                </div>
              </div>
              <div style={{ paddingBottom: 12 }}>
                {holders.map(({ fund, cell }) => {
                  const action = cell!.action;
                  const color = action ? ACTION_COLORS[action] : t.textMuted;
                  return (
                    <button
                      key={fund.cik}
                      className="pressable"
                      onClick={() => onFund(fund.cik)}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, width: "100%",
                        padding: "8px 16px", border: "none", background: "transparent",
                        cursor: "pointer", textAlign: "left", fontFamily: "inherit",
                        borderBottom: "1px solid #f9fafb",
                      }}
                    >
                      <span style={{ width: 4, height: 24, background: fund.color, borderRadius: 2, flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: 12, fontWeight: 600, color: t.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {fund.name}
                        </span>
                        <span style={{ fontSize: 10.5, color: t.textHint }}>
                          {cell!.classes.join(" · ") || "—"}
                        </span>
                      </span>
                      <span style={{ color, fontSize: 12, fontWeight: 700, minWidth: 16, textAlign: "center" }}>
                        {action ? GLYPH[action] : "·"}
                      </span>
                      <span style={{ fontSize: 11.5, color: t.textSecondary, minWidth: 46, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {pct(cell!.weight)}
                      </span>
                      <span style={{ fontSize: 11, color: t.textMuted, minWidth: 54, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {cell!.dWeightPp == null ? "—" : pp(cell!.dWeightPp)}
                      </span>
                      <span style={{ fontSize: 11, color: t.textMuted, minWidth: 62, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {usd(cell!.value)}
                      </span>
                    </button>
                  );
                })}
                {!holders.length && (
                  <div style={{ padding: "18px 16px", fontSize: 12, color: t.textHint }}>
                    No tracked manager reported this name for {periodLabel(period)}.
                  </div>
                )}
              </div>

              <div style={{ padding: "10px 16px 20px", fontSize: 10.5, color: t.textHint, lineHeight: 1.6, borderTop: "1px solid #f3f4f6" }}>
                Weights are of each manager's reported long US equity book, not of their total assets.
                A dash in the change column means the comparison was withheld — most often because the
                manager's prior quarter is missing, was a notice, or the whole book moved by one
                structural event. Ticker and issuer name only; {count(row.shareClasses)} share
                class{row.shareClasses === 1 ? "" : "es"} aggregated at the issuer.
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
