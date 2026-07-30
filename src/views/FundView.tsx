// src/views/FundView.tsx
//
// Everything the reference products show for one manager, deduplicated into
// nine widgets. Content order follows the mandated hierarchy: filters, KPIs,
// primary analysis, insights, detail, sources.

import { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Cell, Tooltip, Treemap,
} from "recharts";
import { WidgetCard, ViewToggle, CaveatStrip } from "../components/WidgetCard";
import { Kpi, KpiRow } from "../components/Kpi";
import { ChartSkeleton, TableSkeleton, EmptyState, ErrorState, PartialNotice } from "../components/states";
import { t, ACTION_COLORS, type Action } from "../theme";
import { usd, pct, pp, deltaPct, shares as fmtShares, count, periodLabel, dateLabel, utcStamp } from "../lib/format";
import {
  loadFundSummary, loadFundPeriodAll, edgarUrl,
  type Manifest, type FundSummary, type FundPeriod, type Holding,
} from "../lib/data";

const GRID_WIDE: React.CSSProperties = {
  display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fill, minmax(480px, 1fr))",
};

function ActionChip({ action }: { action: Action | null }) {
  if (!action) return <span style={{ color: t.textHint }}>—</span>;
  const color = ACTION_COLORS[action];
  return (
    <span
      style={{
        display: "inline-block", padding: "1px 7px", borderRadius: 5, fontSize: 10,
        fontWeight: 700, letterSpacing: "0.03em", color, background: `${color}14`,
      }}
    >
      {action}
    </span>
  );
}

/** A delta cell that renders an em-dash when the value was suppressed, with the
 *  reason on hover. A withheld number beats a wrong one, but only if the reader
 *  can find out why it was withheld. */
function Delta({ value, unit = "pct", reason }: { value: number | null; unit?: "pct" | "pp"; reason?: string }) {
  if (value == null) {
    return (
      <span title={reason || "Not comparable"} style={{ color: t.textHint, cursor: reason ? "help" : "default" }}>
        —
      </span>
    );
  }
  const color = value > 0 ? "#059669" : value < 0 ? "#dc2626" : t.textMuted;
  return <span style={{ color }}>{unit === "pp" ? pp(value) : deltaPct(value)}</span>;
}

/**
 * Treemap tile. Area is position value; FILL is the change in portfolio weight.
 *
 * Encoding change rather than sector or a flat brand colour is what makes one
 * treemap answer both "what do they own" and "what moved" — which is why there
 * is no separate change-heatmap widget. Green grew, amber shrank, indigo is new,
 * grey held.
 */
function TreemapTile(props: {
  x?: number; y?: number; width?: number; height?: number;
  ticker?: string | null; name?: string; dWeightPp?: number | null; action?: string | null;
}) {
  const { x = 0, y = 0, width = 0, height = 0, ticker, name, dWeightPp, action } = props;
  const d = dWeightPp ?? 0;
  const fill =
    action === "NEW" ? "#4f46e5"
    : d > 0.05 ? `rgba(5,150,105,${Math.min(0.25 + d / 8, 0.85).toFixed(2)})`
    : d < -0.05 ? `rgba(217,119,6,${Math.min(0.25 + Math.abs(d) / 8, 0.85).toFixed(2)})`
    : "rgba(156,163,175,0.35)";

  // Below roughly 34x16 a label is unreadable and only adds visual noise; the
  // tooltip carries it instead.
  const showLabel = width > 34 && height > 16;
  const showSub = width > 70 && height > 34;

  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} stroke="#fff" strokeWidth={1.5} rx={2} />
      {showLabel && (
        <text x={x + width / 2} y={y + height / 2 + (showSub ? -3 : 3)} textAnchor="middle" fill="#111827" fontSize={11} fontWeight={700}>
          {ticker ?? "—"}
        </text>
      )}
      {showSub && (
        <text x={x + width / 2} y={y + height / 2 + 11} textAnchor="middle" fill="#374151" fontSize={9}>
          {d === 0 ? "" : `${d > 0 ? "+" : ""}${d.toFixed(1)}pp`}
        </text>
      )}
      {!showLabel && <title>{`${ticker ?? name}`}</title>}
    </g>
  );
}

export function FundView({
  cik, period, mf, longsOnly,
}: {
  cik: string;
  period: string;
  mf: Manifest;
  longsOnly: boolean;
}) {
  const [summary, setSummary] = useState<FundSummary | null>(null);
  const [fp, setFp] = useState<FundPeriod | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [valueView, setValueView] = useState<"Chart" | "Filings">("Chart");
  const [moverView, setMoverView] = useState<"Δ Weight" | "Δ Value">("Δ Weight");
  const [q, setQ] = useState("");
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setShowRaw(false);
    setFp(null);

    // Load the summary first and use it to decide whether this manager has a
    // filing for the requested quarter. Asking for the artifact blind and
    // treating a miss as an error would mislabel the single most common state
    // in the product: during filing season most managers simply have not filed
    // the newest quarter yet.
    loadFundSummary(cik, mf)
      .then(async (s) => {
        if (cancelled) return;
        setSummary(s);
        if (!s.series.some((x) => x.period === period)) return; // not filed — not an error
        const p = await loadFundPeriodAll(cik, period, mf);
        if (!cancelled) setFp(p);
      })
      .catch((e) => !cancelled && setErr(String(e.message ?? e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [cik, period, mf]);

  const holdings = useMemo(() => {
    if (!fp) return [];
    return longsOnly ? fp.holdings.filter((h) => h.type === "" && h.unit === "SH") : fp.holdings;
  }, [fp, longsOnly]);

  const meta = fp?.meta;
  const suppressed = Boolean(meta?.deltasSuppressed) && !showRaw;

  const movers = useMemo(() => {
    const key = moverView === "Δ Weight" ? "dWeightPp" : "dValue";
    const withDelta = holdings.filter((h) => h[key as keyof Holding] != null);
    const sorted = [...withDelta].sort(
      (a, b) => Number(b[key as keyof Holding] ?? 0) - Number(a[key as keyof Holding] ?? 0),
    );
    return { up: sorted.slice(0, 8), down: sorted.slice(-8).reverse() };
  }, [holdings, moverView]);

  // Long equity only, and Recharts' Treemap cannot render negative values, so
  // zero-value rows are dropped rather than silently distorting the layout.
  const treemapData = useMemo(
    () =>
      holdings
        .filter((h) => h.type === "" && h.unit === "SH" && h.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 50)
        .map((h) => ({
          name: h.name,
          ticker: h.ticker,
          value: h.value,
          weight: h.weight,
          dWeightPp: suppressed ? null : h.dWeightPp,
          action: h.action,
        })),
    [holdings, suppressed],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return holdings;
    return holdings.filter((h) => h.name.toLowerCase().includes(needle) || (h.ticker ?? "").toLowerCase().includes(needle));
  }, [holdings, q]);

  // `series` is stored OLDEST-FIRST because that is the order the bar chart
  // needs. Deriving "latest" and "prior" from raw indices against that array is
  // an easy way to get them backwards — index + 1 is the NEWER quarter, not the
  // older one. Name the orderings explicitly so neither can be read the wrong
  // way round.
  const seriesAsc = summary?.series ?? [];
  const seriesDesc = useMemo(() => [...seriesAsc].reverse(), [seriesAsc]);
  const latestPoint = seriesDesc[0];
  const point = seriesAsc.find((s) => s.period === period);
  const priorPoint = useMemo(() => {
    const i = seriesAsc.findIndex((s) => s.period === period);
    return i > 0 ? seriesAsc[i - 1] : undefined;
  }, [seriesAsc, period]);
  const series = seriesAsc;

  if (err) {
    return <div style={GRID_WIDE}><WidgetCard title="Fund" span={2}><ErrorState message={err} /></WidgetCard></div>;
  }

  // Not filed for this quarter. A real, expected state — and the one that most
  // of the universe is in for six weeks after every quarter closes. Say so, and
  // offer the latest quarter this manager actually has.
  if (!loading && summary && !point) {
    const latest = latestPoint;
    return (
      <div style={{ ...GRID_WIDE, marginTop: 22 }}>
        <WidgetCard
          title={summary.name}
          subtitle={`No 13F filing for ${periodLabel(period)}`}
          span={2}
          bodyMinHeight={220}
        >
          <EmptyState
            icon="◷"
            message={`${summary.name} has not filed for ${periodLabel(period)}`}
            hint={
              latest
                ? `Their most recent filing is ${latest.label} — use the quarter stepper to go back. 13F is due 45 days after each quarter ends, and most managers file close to the deadline.`
                : "No filings found for this manager in the covered window."
            }
          />
        </WidgetCard>
      </div>
    );
  }

  const suppressionReason = meta?.structuralDetail?.message ?? "Not comparable to the prior quarter.";

  return (
    <>
      <KpiRow>
        <Kpi
          label="Reported value"
          value={loading ? "…" : usd(point?.valueLongUsd ?? null)}
          delta={
            point && priorPoint && !point.deltasSuppressed
              ? deltaPct(((point.valueLongUsd - priorPoint.valueLongUsd) / priorPoint.valueLongUsd) * 100)
              : undefined
          }
          deltaTone={
            point && priorPoint && point.valueLongUsd >= priorPoint.valueLongUsd ? "up" : "down"
          }
          scope={`${periodLabel(period)} · 13F equity longs`}
        />
        <Kpi
          label="Positions"
          value={loading ? "…" : count(point?.positions ?? null)}
          delta={point && priorPoint ? `${point.positions - priorPoint.positions >= 0 ? "+" : ""}${point.positions - priorPoint.positions} QoQ` : undefined}
          scope={point ? `${count(point.positionsLong)} long · ${count(point.positionsOptions)} options` : undefined}
        />
        <Kpi
          label="Top 10 weight"
          value={loading ? "…" : pct(point?.top10WeightPct ?? null)}
          scope="Concentration"
        />
        <Kpi
          label="Turnover"
          value={loading ? "…" : pct(point?.turnover_position_pct ?? null)}
          scope="(entries + exits) ÷ positions"
        />
        <Kpi
          label="Filing lag"
          value={point?.filingLagDays != null ? `${point.filingLagDays} days` : "—"}
          scope={point?.acceptedAt ? `Filed ${dateLabel(point.acceptedAt.slice(0, 10))}` : undefined}
        />
      </KpiRow>

      <div style={{ ...GRID_WIDE, marginTop: 22 }}>
        {/* PRIMARY — the holdings treemap. Top 50 only: 100 tiles in a 480px
            card is ~40 unlabelled slivers, which is decoration rather than data. */}
        <WidgetCard
          title="Holdings map"
          subtitle="Area is position size · colour is change in portfolio weight"
          span={2}
          bodyMinHeight={300}
        >
          {loading ? (
            <ChartSkeleton bars={12} height={280} />
          ) : treemapData.length === 0 ? (
            <EmptyState icon="▦" message="No long equity positions to map" />
          ) : (
            <>
              <div style={{ padding: "12px 12px 0", height: 300 }}>
                <ResponsiveContainer width="100%" height="100%">
                  {/* aspectRatio 1, not the 4/3 default, which produces slivers.
                      Animation off — Treemap's own transition is janky, and the
                      card's opacity carries the entrance instead. */}
                  <Treemap
                    data={treemapData}
                    dataKey="value"
                    aspectRatio={1}
                    stroke="#fff"
                    isAnimationActive={false}
                    content={<TreemapTile />}
                  >
                    <Tooltip
                      contentStyle={{ background: "#fff", border: `1px solid ${t.borderSolid}`, borderRadius: 8, fontSize: 12 }}
                      formatter={(v: number, _n, p) => [
                        `${usd(v)} · ${pct(p.payload?.weight)}${p.payload?.dWeightPp != null ? ` · ${pp(p.payload.dWeightPp)}` : ""}`,
                        p.payload?.name ?? "",
                      ]}
                    />
                  </Treemap>
                </ResponsiveContainer>
              </div>
              <div
                style={{
                  display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center",
                  padding: "8px 16px", borderTop: `1px solid ${t.border}`, fontSize: 10.5, color: t.textMuted,
                }}
              >
                {[["#4f46e5", "new"], ["rgba(5,150,105,0.6)", "weight up"], ["rgba(217,119,6,0.6)", "weight down"], ["rgba(156,163,175,0.35)", "flat"]].map(
                  ([c, label]) => (
                    <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: c }} />
                      {label}
                    </span>
                  ),
                )}
                <span style={{ color: t.textHint }}>
                  · top {treemapData.length} long positions{suppressed ? " · weight changes withheld this quarter" : ""}
                </span>
              </div>
            </>
          )}
        </WidgetCard>

        {/* PRIMARY — reported value history.
            Bars, not an area chart: 13F is a discrete quarterly snapshot with
            real gaps, and an area would interpolate between filings, asserting
            continuous knowledge the data does not have. */}
        <WidgetCard
          title="Reported 13F value"
          subtitle="Long equity at each quarter end. Never labelled AUM — it excludes shorts, cash and non-US holdings."
          span={2}
          bodyMinHeight={260}
          actions={<ViewToggle options={["Chart", "Filings"] as const} value={valueView} onChange={setValueView} />}
        >
          {loading ? (
            <ChartSkeleton bars={8} height={240} />
          ) : valueView === "Chart" ? (
            <div style={{ padding: "14px 12px 4px", height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={series} margin={{ top: 6, right: 12, left: 4, bottom: 4 }}>
                  <CartesianGrid stroke={t.gridline} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: t.textHint }} axisLine={false} tickLine={false} />
                  <YAxis
                    tick={{ fontSize: 10, fill: t.textHint }} axisLine={false} tickLine={false}
                    tickFormatter={(v) => usd(v)} width={58}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(79,70,229,0.06)" }}
                    contentStyle={{
                      background: "#fff", border: `1px solid ${t.borderSolid}`, borderRadius: 8,
                      fontSize: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
                    }}
                    formatter={(v: number) => [usd(v), "Long equity"]}
                  />
                  <Bar dataKey="valueLongUsd" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                    {series.map((s) => {
                      const flagged = Boolean(s.structuralEvent || s.confidentialOmitted);
                      // FILL carries the data quality; STROKE carries selection.
                      // They must not compete for the same channel: making
                      // "selected" win would hide the amber warning at exactly
                      // the moment the user is looking at the flagged quarter,
                      // which is when it matters most. The stepper already says
                      // which quarter is selected, so selection is the cheaper
                      // signal to move.
                      return (
                        <Cell
                          key={s.period}
                          fill={flagged ? "#fcd34d" : s.period === period ? t.primary : "#c7d2fe"}
                          stroke={s.period === period ? t.primary : "none"}
                          strokeWidth={s.period === period ? 2 : 0}
                        />
                      );
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div style={{ maxHeight: 300, overflow: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Period</th><th>Filed</th><th>Positions</th><th>Reported value</th>
                    <th>Lag</th><th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {series.map((s) => (
                    <tr key={s.period}>
                      <td style={{ fontWeight: 600 }}>{s.label}</td>
                      <td>{s.acceptedAt ? dateLabel(s.acceptedAt.slice(0, 10)) : "—"}</td>
                      <td>{count(s.positions)}</td>
                      <td>{usd(s.valueLongUsd)}</td>
                      <td>{s.filingLagDays != null ? `${s.filingLagDays}d` : "—"}</td>
                      <td style={{ color: t.warnAmber, fontSize: 11 }}>
                        {s.structuralEvent ?? (s.confidentialOmitted ? "CONFIDENTIAL OMISSION" : "")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </WidgetCard>

        {/* PRIMARY — position changes. Fintel's two cards and WhaleWisdom's two
            cards merged into one: increases left, decreases right, split by a
            hairline rather than nested cards. */}
        <WidgetCard
          title="Position changes"
          subtitle="Ranked by change in portfolio weight — moves can be trades or price."
          span={2}
          bodyMinHeight={240}
          actions={<ViewToggle options={["Δ Weight", "Δ Value"] as const} value={moverView} onChange={setMoverView} />}
          caveat={
            suppressed ? (
              <CaveatStrip
                action={
                  <button
                    className="pressable"
                    onClick={() => setShowRaw(true)}
                    style={{
                      border: "none", background: "transparent", color: "#92400e", cursor: "pointer",
                      fontSize: 11, fontWeight: 700, textDecoration: "underline", fontFamily: "inherit",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Show raw deltas anyway
                  </button>
                }
              >
                {suppressionReason}
              </CaveatStrip>
            ) : showRaw && meta?.deltasSuppressed ? (
              <CaveatStrip>Showing raw deltas. These are misleading — see the note above.</CaveatStrip>
            ) : undefined
          }
        >
          {loading ? (
            <TableSkeleton rows={6} cols={4} />
          ) : suppressed ? (
            <EmptyState
              icon="⊘"
              message="Quarter-on-quarter changes are hidden"
              hint="They would describe one structural event as many separate trades."
            />
          ) : movers.up.length === 0 ? (
            <EmptyState icon="≡" message="No comparable changes" hint="This is the first quarter of coverage for this manager." />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1px 1fr" }}>
              {[movers.up, null, movers.down].map((group, gi) =>
                group === null ? (
                  <div key="rule" style={{ background: t.border }} />
                ) : (
                  <div key={gi}>
                    <div
                      style={{
                        fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
                        color: gi === 0 ? "#059669" : "#dc2626", padding: "9px 14px 4px",
                      }}
                    >
                      {gi === 0 ? "Increases" : "Decreases"}
                    </div>
                    <table className="data-table">
                      <thead>
                        <tr><th>Security</th><th>Value</th><th>Weight</th><th>{moverView}</th></tr>
                      </thead>
                      <tbody>
                        {group.map((h, i) => (
                          <tr key={`${h.issuerId}-${h.type}-${i}`}>
                            <td style={{ maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              <span style={{ fontWeight: 600 }}>{h.ticker ?? h.name}</span>
                              {h.type && <span style={{ color: t.warnAmber, fontSize: 10, marginLeft: 5 }}>{h.type.toUpperCase()}</span>}
                            </td>
                            <td>{usd(h.value)}</td>
                            <td>{pct(h.weight)}</td>
                            <td>
                              {moverView === "Δ Weight"
                                ? <Delta value={h.dWeightPp} unit="pp" />
                                : <span style={{ color: (h.dValue ?? 0) >= 0 ? "#059669" : "#dc2626" }}>{usd(h.dValue)}</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ),
              )}
            </div>
          )}
        </WidgetCard>

        {/* DETAIL — full holdings. */}
        <WidgetCard
          title="Holdings"
          subtitle={
            fp
              ? `${count(filtered.length)} of ${count(fp.total)} positions${longsOnly ? " · long equity only" : " · including options"}`
              : undefined
          }
          span={2}
          bodyMinHeight={320}
          actions={
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              style={{
                height: 26, width: 150, borderRadius: 7, border: `1px solid ${t.borderSolid}`,
                padding: "0 9px", fontSize: 11.5, outline: "none", fontFamily: "inherit",
              }}
            />
          }
          caveat={
            meta?.confidentialOmitted ? (
              <CaveatStrip>
                This filing has confidential omissions — some positions were withheld. The reported
                value is a floor, not the full book.
              </CaveatStrip>
            ) : undefined
          }
        >
          {loading ? (
            <TableSkeleton rows={8} cols={7} />
          ) : filtered.length === 0 ? (
            <EmptyState icon="⌕" message={q ? `Nothing matches “${q}”` : "No holdings reported"} />
          ) : (
            <div style={{ maxHeight: 460, overflow: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Security</th><th>Type</th><th>Implied price</th><th>Shares</th>
                    <th>Δ Shares</th><th>Value</th><th>Δ Value</th><th>Weight</th><th>Δ Weight</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 400).map((h, i) => (
                    <tr key={`${h.issuerId}-${h.type}-${i}`}>
                      <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ fontWeight: 600 }}>{h.ticker ?? h.name}</span>
                        {h.ticker && <span style={{ color: t.textHint, marginLeft: 6, fontSize: 11 }}>{h.name}</span>}
                      </td>
                      <td style={{ color: h.type ? t.warnAmber : t.textHint, fontSize: 10.5, fontWeight: 600 }}>
                        {h.type ? h.type.toUpperCase() : h.unit === "PRN" ? "PRN" : "—"}
                      </td>
                      {/* Named "implied price", not "avg share price": it is
                          value ÷ shares at period end, not a cost basis. */}
                      <td>{h.price != null ? `$${h.price.toFixed(2)}` : "—"}</td>
                      <td>{h.unit === "PRN" ? `${fmtShares(h.shares)} face` : fmtShares(h.shares)}</td>
                      <td>
                        <Delta
                          value={suppressed ? null : h.dSharesPct}
                          reason={
                            h.flags?.includes("SUSPECTED_SPLIT")
                              ? "Share count moved by a simple ratio while value held steady — likely a stock split, not a trade."
                              : h.unit === "PRN"
                                ? "Principal amount, not shares."
                                : suppressionReason
                          }
                        />
                      </td>
                      <td>{usd(h.value)}</td>
                      <td><Delta value={suppressed ? null : h.dValuePct} reason={suppressionReason} /></td>
                      <td>{pct(h.weight)}</td>
                      <td><Delta value={suppressed ? null : h.dWeightPp} unit="pp" reason={suppressionReason} /></td>
                      <td><ActionChip action={h.action} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length > 400 && (
                <div style={{ padding: "9px 14px", fontSize: 11, color: t.textHint, textAlign: "center" }}>
                  Showing the largest 400 of {count(filtered.length)} positions. Search to narrow.
                </div>
              )}
            </div>
          )}
        </WidgetCard>

        {/* INSIGHT — exits. A table, not a chart: the payload is names, and
            names are text. A dumbbell chart would hide the answer behind a hover. */}
        <WidgetCard
          title="Exited this quarter"
          subtitle="Positions closed since the prior filing — half of the anchor."
          bodyMinHeight={200}
        >
          {loading ? (
            <TableSkeleton rows={5} cols={2} />
          ) : !fp?.exits?.length ? (
            <EmptyState
              icon="○"
              message={meta?.priorState === "PRIOR_OK" ? "No positions exited" : "Changes not comparable"}
              hint={meta?.priorState === "PRIOR_OK" ? undefined : "The prior quarter is missing or was a 13F notice."}
            />
          ) : (
            <div style={{ maxHeight: 260, overflow: "auto" }}>
              <table className="data-table">
                <thead><tr><th>Security</th><th>Value held</th><th>Weight</th></tr></thead>
                <tbody>
                  {fp.exits.map((e, i) => (
                    <tr key={`${e.issuerId}-${i}`}>
                      <td style={{ maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {e.name}
                        {e.type && <span style={{ color: t.warnAmber, fontSize: 10, marginLeft: 5 }}>{e.type.toUpperCase()}</span>}
                      </td>
                      <td>{usd(e.valuePrior)}</td>
                      <td>{pct(e.weightPrior)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </WidgetCard>

        {/* INSIGHT — longs vs options. Rendered even at zero, so the grid does
            not reflow when the user switches between a plain long-only manager
            and one that is half derivatives. */}
        <WidgetCard title="Longs vs options" subtitle="Option values are notional, not exposure." bodyMinHeight={200}>
          {loading || !meta ? (
            <ChartSkeleton bars={3} height={160} />
          ) : meta.value_options_usd === 0 ? (
            <EmptyState icon="—" message="No derivative positions reported" hint="This manager filed long equity only." />
          ) : (
            <div style={{ padding: "18px 16px" }}>
              {[
                ["Long equity", meta.value_long_usd, t.primary],
                ["Options (notional)", meta.value_options_usd, t.warnAmber],
                ["Debt (principal)", meta.value_prn_usd, t.textMuted],
              ].map(([label, value, color]) => {
                const total = meta.value_long_usd + meta.value_options_usd + meta.value_prn_usd;
                const w = total > 0 ? ((value as number) / total) * 100 : 0;
                return (
                  <div key={label as string} style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 5 }}>
                      <span style={{ color: t.textSecondary, fontWeight: 600 }}>{label as string}</span>
                      <span style={{ color: t.textMuted, fontVariantNumeric: "tabular-nums" }}>
                        {usd(value as number)} · {w.toFixed(1)}%
                      </span>
                    </div>
                    <div style={{ height: 8, background: "#f3f4f6", borderRadius: 4, overflow: "hidden" }}>
                      <div
                        className="flow-bar"
                        style={{ height: "100%", width: "100%", background: color as string, transform: `scaleX(${w / 100})` }}
                      />
                    </div>
                  </div>
                );
              })}
              <p style={{ fontSize: 11, color: t.textHint, margin: "14px 0 0", lineHeight: 1.5 }}>
                Every weight and total on this page uses long equity as the denominator. Mixing in
                option notional would inflate the book and deflate every position weight.
              </p>
            </div>
          )}
        </WidgetCard>

        {/* SOURCE */}
        <WidgetCard title="Sources &amp; provenance" subtitle="Every filing folded into this view" span={2}>
          {loading || !meta ? (
            <TableSkeleton rows={3} cols={3} />
          ) : (
            <div style={{ padding: "12px 16px" }}>
              {meta.priorState !== "PRIOR_OK" && (
                <PartialNotice>
                  {meta.priorState === "PRIOR_IS_NT"
                    ? "The prior quarter was a 13F notice — this manager's holdings were reported by another manager, so changes cannot be computed."
                    : meta.priorState === "PRIOR_MISSING"
                      ? "No filing found for the prior quarter, so changes cannot be computed."
                      : "First quarter of coverage — there is nothing to compare against yet."}
                </PartialNotice>
              )}
              <table className="data-table" style={{ marginBottom: 12 }}>
                <thead><tr><th>Accession</th><th>Accepted (UTC)</th><th>EDGAR</th></tr></thead>
                <tbody>
                  {meta.accessions.map((a) => (
                    <tr key={a}>
                      <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{a}</td>
                      <td>{fp?.acceptedAt ? utcStamp(fp.acceptedAt) : "—"}</td>
                      <td>
                        <a
                          href={edgarUrl(cik, a)}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: t.primaryText, fontWeight: 600, textDecoration: "none" }}
                        >
                          View filing ↗
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.65 }}>
                <p style={{ margin: "0 0 8px" }}>
                  13F reports long US-listed equity and option positions only — no shorts, no cash,
                  no bonds, no non-US listings. Positions are as of {dateLabel(period)} and were
                  filed up to 45 days later, so these are not current positions.
                </p>
                <p style={{ margin: 0 }}>
                  Values before 2023-01-03 were filed in thousands and after in dollars; all figures
                  here are normalized to dollars. Security identifiers are ticker and issuer name
                  only — CUSIPs are licensed by CGS/ABA and are neither displayed nor exported.
                </p>
              </div>
              <div
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  borderTop: `1px solid ${t.border}`, paddingTop: 10, marginTop: 12,
                  fontSize: 11, color: t.textHint,
                }}
              >
                <span>Data © SEC EDGAR (public domain) · build {mf.buildId}</span>
                <a
                  href="https://www.sec.gov/edgar"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: t.primaryText, fontWeight: 600, textDecoration: "none" }}
                >
                  sec.gov/edgar ↗
                </a>
              </div>
            </div>
          )}
        </WidgetCard>
      </div>
    </>
  );
}
