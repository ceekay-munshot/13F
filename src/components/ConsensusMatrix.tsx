// src/components/ConsensusMatrix.tsx
//
// The product's primary widget: which names this group of funds agrees on, and
// which way each fund moved.
//
// A hand-rolled DOM grid, deliberately not a charting library. Recharts 2.x has
// no heatmap, and coercing a ScatterChart into one costs a sticky row header,
// real selectable text, native keyboard focus and tooltips — everything that
// makes a lookup grid usable. Divs give all of that for free and cost nothing.
//
// Three encoding channels so a row is READABLE WITHOUT HOVERING:
//   background tint  that fund's portfolio weight in the name
//   glyph            direction this quarter
//   number           the weight itself, printed only when it is worth printing
//
// "4 of 7 hold NVDA, 2 added, 1 trimmed, 1 is new" is then literally the row.

import { useState } from "react";
import { t, ACTION_COLORS, ACTION_GLYPH, type Action } from "../theme";
import { usd, pct, pp } from "../lib/format";
import type { ConsensusRow, FundInput } from "../lib/consensus";

const NAME_COL = 210;
const GROUP_COL = 148;
const CELL_W = 62;
const ROW_H = 30;

/** Tint saturates at a 10% position: above that the eye cannot tell 12% from 18%
 *  anyway, and letting one mega-position define the scale flattens everything else. */
function tintFor(weight: number | null): string {
  if (weight == null || weight <= 0) return "transparent";
  const a = Math.min(weight / 10, 1) * 0.18;
  return `rgba(79, 70, 229, ${a.toFixed(3)})`;
}

function Glyph({ action }: { action: Action | null }) {
  if (!action) return <span style={{ color: "#e5e7eb", fontSize: 9 }}>·</span>;
  return (
    <span style={{ color: ACTION_COLORS[action], fontSize: 10, lineHeight: 1 }}>
      {ACTION_GLYPH[action]}
    </span>
  );
}

/** Six-quarter trend in HOW MANY funds held the name. The single best
 *  "is the herd arriving or leaving" signal available, and it costs 44px. */
function HolderSparkline({ counts, max }: { counts: number[]; max: number }) {
  if (counts.length < 2) return null;
  const w = 44;
  const h = 14;
  const step = w / (counts.length - 1);
  const pts = counts
    .map((c, i) => `${(i * step).toFixed(1)},${(h - (c / Math.max(1, max)) * h).toFixed(1)}`)
    .join(" ");
  const rising = counts[counts.length - 1] > counts[0];
  return (
    <svg width={w} height={h} style={{ flexShrink: 0, display: "block" }} aria-hidden="true">
      <polyline
        points={pts}
        fill="none"
        stroke={rising ? "#059669" : counts[counts.length - 1] < counts[0] ? "#d97706" : t.textHint}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ConsensusMatrix({
  rows, funds, holderHistory, onTicker, onFund, maxRows,
}: {
  rows: ConsensusRow[];
  funds: FundInput[];
  holderHistory?: Map<string, number[]>;
  onTicker?: (issuerId: string) => void;
  onFund?: (cik: string) => void;
  maxRows: number;
}) {
  const [hoverCol, setHoverCol] = useState<string | null>(null);
  const shown = rows.slice(0, maxRows);
  const maxHolders = funds.length;

  return (
    <div
      className="matrix"
      data-hover-col={hoverCol ?? undefined}
      // Cap only when there is enough to scroll; otherwise size to content.
      style={{ overflow: "auto", maxHeight: shown.length > 14 ? 560 : undefined }}
      onMouseLeave={() => setHoverCol(null)}
    >
      <div style={{ minWidth: NAME_COL + funds.length * CELL_W + GROUP_COL }}>
        {/* header */}
        <div
          style={{
            display: "flex", position: "sticky", top: 0, zIndex: 3,
            background: "rgba(255,255,255,0.97)", backdropFilter: "blur(8px)",
            borderBottom: `1px solid ${t.borderSolid}`,
          }}
        >
          <div
            style={{
              width: NAME_COL, flexShrink: 0, position: "sticky", left: 0, zIndex: 4,
              background: "rgba(255,255,255,0.97)", padding: "7px 12px",
              fontSize: 10, fontWeight: 700, color: t.textHint, textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Name
          </div>
          {funds.map((f) => (
            <button
              key={f.cik}
              onClick={() => onFund?.(f.cik)}
              onMouseEnter={() => setHoverCol(f.cik)}
              // A dimmed column has two possible causes and the tooltip is the
              // only place that can tell them apart: the manager did not file,
              // or we could not fetch what they did file.
              title={`${f.name}${f.failed ? " — could not be loaded" : f.missing ? " — no filing this quarter" : ""}`}
              style={{
                width: CELL_W, flexShrink: 0, border: "none", background: "transparent",
                cursor: onFund ? "pointer" : "default", padding: "7px 0 5px",
                fontSize: 10.5, fontWeight: 700, fontFamily: "inherit",
                color: f.missing ? t.textHint : t.textSecondary,
                textDecoration: f.missing ? "line-through" : "none",
                borderBottom: `3px solid ${f.missing ? "#e5e7eb" : f.color}`,
                opacity: f.missing ? 0.5 : 1,
              }}
            >
              {f.code}
              {f.suppressed && <span title="Structural event — deltas withheld" style={{ color: t.warnAmber }}> ⚠</span>}
            </button>
          ))}
          <div
            style={{
              width: GROUP_COL, flexShrink: 0, padding: "7px 12px", textAlign: "right",
              fontSize: 10, fontWeight: 700, color: t.textHint, textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Group
          </div>
        </div>

        {/* rows */}
        {shown.map((r) => (
          <div
            key={r.issuerId}
            style={{ display: "flex", alignItems: "stretch", borderBottom: `1px solid #f3f4f6`, height: ROW_H }}
          >
            <button
              onClick={() => onTicker?.(r.issuerId)}
              style={{
                width: NAME_COL, flexShrink: 0, position: "sticky", left: 0, zIndex: 1,
                background: "#fff", border: "none", cursor: onTicker ? "pointer" : "default",
                display: "flex", alignItems: "center", gap: 7, padding: "0 12px",
                textAlign: "left", fontFamily: "inherit", overflow: "hidden",
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary, flexShrink: 0 }}>
                {r.ticker ?? "—"}
              </span>
              <span
                style={{
                  fontSize: 10.5, color: t.textHint, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
              >
                {r.name}
              </span>
            </button>

            {funds.map((f) => {
              const cell = r.cells[f.cik];
              const exited = cell?.action === "EXITED";
              // Print the number only when it carries information. Below 0.5%
              // the tint already says "small", and a wall of "0.1" would bury
              // the positions that matter.
              const showNum = cell && cell.weight != null && (cell.weight >= 0.5 || cell.action === "NEW");
              return (
                <div
                  key={f.cik}
                  className="matrix-cell"
                  data-active={hoverCol === null || hoverCol === f.cik ? "" : undefined}
                  onMouseEnter={() => setHoverCol(f.cik)}
                  onClick={() => cell && onTicker?.(r.issuerId)}
                  title={
                    cell
                      ? `${f.name} — ${r.ticker ?? r.name}\n` +
                        `${cell.action ?? "held"} · ${pct(cell.weight)} of portfolio · ${usd(cell.value)}` +
                        (cell.dWeightPp != null ? `\n${pp(cell.dWeightPp)} QoQ` : "") +
                        (cell.classes.length > 1 ? `\nclasses: ${cell.classes.join(", ")}` : "")
                      : `${f.name} — does not hold ${r.ticker ?? r.name}`
                  }
                  style={{
                    width: CELL_W, flexShrink: 0, display: "flex", alignItems: "center",
                    justifyContent: "center", gap: 3, cursor: cell ? "pointer" : "default",
                    // An exited cell is tinted red and hatched, not left blank:
                    // who LEFT is half the anchor, and a blank cell would read
                    // as "never held".
                    background: exited
                      ? "repeating-linear-gradient(45deg, #fef2f2, #fef2f2 3px, #fee2e2 3px, #fee2e2 6px)"
                      : tintFor(cell?.weight ?? null),
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <Glyph action={(cell?.action as Action) ?? null} />
                  {showNum && (
                    <span style={{ fontSize: 10.5, color: t.textSecondary }}>{cell!.weight!.toFixed(1)}</span>
                  )}
                </div>
              );
            })}

            <div
              style={{
                width: GROUP_COL, flexShrink: 0, display: "flex", alignItems: "center",
                justifyContent: "flex-end", gap: 9, padding: "0 12px", overflow: "hidden",
              }}
            >
              <HolderSparkline counts={holderHistory?.get(r.issuerId) ?? []} max={maxHolders} />
              <span
                style={{
                  fontSize: 10, fontWeight: 700, color: t.primaryText, background: t.primaryLight,
                  border: `1px solid ${t.primaryBorder}`, borderRadius: 5, padding: "1px 5px",
                }}
              >
                {r.fundCount}/{funds.filter((f) => !f.missing).length}
              </span>
              <span style={{ fontSize: 10.5, color: t.textMuted, fontVariantNumeric: "tabular-nums", minWidth: 46, textAlign: "right" }}>
                {usd(r.combinedValue)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Legend. Small, and it earns its space: five glyphs are not self-evident. */
export function MatrixLegend() {
  const items: [Action, string][] = [
    ["NEW", "new"], ["ADDED", "added"], ["HELD", "held"], ["TRIMMED", "trimmed"], ["EXITED", "exited"],
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      {items.map(([a, label]) => (
        <span key={a} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, color: t.textMuted }}>
          <span style={{ color: ACTION_COLORS[a], fontSize: 10 }}>{ACTION_GLYPH[a]}</span>
          {label}
        </span>
      ))}
      <span style={{ fontSize: 10.5, color: t.textHint }}>· shading = portfolio weight</span>
    </div>
  );
}
