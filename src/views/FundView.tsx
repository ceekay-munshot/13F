// src/views/FundView.tsx
//
// Everything the reference products show for one manager, deduplicated into
// nine widgets. Content order follows the mandated hierarchy: filters, KPIs,
// primary analysis, insights, detail, sources.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Cell, Tooltip, Treemap,
} from "recharts";
import { WidgetCard, ViewToggle, CaveatStrip } from "../components/WidgetCard";
import { Kpi, KpiRow } from "../components/Kpi";
import { ChartSkeleton, TableSkeleton, EmptyState, ErrorState, PartialNotice } from "../components/states";
import { t, ACTION_COLORS, type Action } from "../theme";
import { usd, pct, pp, deltaPct, shares as fmtShares, count, periodLabel, dateLabel, utcStamp } from "../lib/format";
import {
  loadFundSummary, loadFundPeriod, edgarUrl,
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
 * Diverging scale for change in portfolio weight.
 *
 * Fixed hex steps rather than an alpha ramp over white. An rgba ramp produces a
 * mid-tone whose final lightness depends on whatever is behind it, so you cannot
 * know in advance whether dark or light text will be readable on it — which is
 * how the first version ended up with illegible labels. With a known set of
 * fills, each one carries the text colour that actually contrasts with it.
 *
 * Two steps per direction, not a continuous ramp: a treemap already encodes
 * magnitude as AREA, so colour only needs to say direction and roughly how much.
 */
const WEIGHT_SCALE = [
  { min: 2.0, fill: "#047857", text: "#ffffff", sub: "#d1fae5" },   // strongly up
  { min: 0.1, fill: "#a7f3d0", text: "#065f46", sub: "#047857" },   // up
  { min: -0.1, fill: "#eef0f2", text: "#4b5563", sub: "#9ca3af" },  // flat
  { min: -2.0, fill: "#fed7aa", text: "#9a3412", sub: "#c2410c" },  // down
  { min: -Infinity, fill: "#c2410c", text: "#ffffff", sub: "#ffedd5" }, // strongly down
] as const;

const NEW_TILE = { fill: "#4f46e5", text: "#ffffff", sub: "#c7d2fe" };

/**
 * The "Note" cell on a quarter row.
 *
 * Two different things used to share this cell and its amber colour: real
 * data-quality warnings, and the ordinary fact that a quarter has no prior to
 * compare against. Since the second is by far the more common — 16,414 NO_PRIOR
 * against 41 genuine structural events across the universe — the amber channel
 * was 99.8% noise and stopped carrying meaning.
 *
 * Warnings stay amber. Coverage facts are grey and written in words.
 */
type QuarterNote = {
  structuralEvent?: string | null;
  confidentialOmitted?: boolean;
  priorState?: string | null;
};

const STRUCTURAL_COPY: Record<string, string> = {
  PRO_RATA_REDUCTION: "Uniform reduction across positions",
  UNIT_SCALE_CHANGE: "Reported unit scale changed",
};

const PRIOR_COPY: Record<string, string> = {
  NO_PRIOR: "First covered quarter",
  PRIOR_MISSING: "No prior quarter on file",
  PRIOR_IS_NT: "Prior quarter was a notice",
};

function noteFor(s: QuarterNote): string {
  if (s.structuralEvent) return STRUCTURAL_COPY[s.structuralEvent] ?? s.structuralEvent;
  if (s.confidentialOmitted) return "Positions withheld pending confidential treatment";
  if (s.priorState && s.priorState !== "PRIOR_OK") return PRIOR_COPY[s.priorState] ?? s.priorState;
  return "";
}

function noteStyle(s: QuarterNote): React.CSSProperties {
  const warn = Boolean(s.structuralEvent || s.confidentialOmitted);
  return { color: warn ? t.warnAmber : t.textHint };
}

function tileStyle(dWeightPp: number | null, action: string | null) {
  if (action === "NEW") return NEW_TILE;
  const d = dWeightPp ?? 0;
  return WEIGHT_SCALE.find((s) => d >= s.min) ?? WEIGHT_SCALE[2];
}

/**
 * Treemap tile. Area is position value; fill is the change in portfolio weight.
 *
 * Encoding change rather than sector or a flat brand colour is what lets one
 * treemap answer both "what do they own" and "what moved", which is why there is
 * no separate change-heatmap widget.
 */
function TreemapTile(props: {
  x?: number; y?: number; width?: number; height?: number;
  ticker?: string | null; name?: string; dWeightPp?: number | null; action?: string | null;
}) {
  const { x = 0, y = 0, width = 0, height = 0, ticker, name, dWeightPp = null, action = null } = props;
  const s = tileStyle(dWeightPp, action);
  const d = dWeightPp ?? 0;

  // Below roughly 30x18 a label is noise rather than information; the tooltip
  // carries it instead.
  const showLabel = width > 30 && height > 18;
  const showSub = width > 62 && height > 36 && dWeightPp != null;

  // aria-label, NOT <title>.
  //
  // An SVG <title> is both the accessible name AND a native browser tooltip, so
  // hovering a tile popped the OS tooltip on top of the Recharts one — two
  // boxes, different shapes, overlapping each other and the map underneath.
  // aria-label gives screen readers the same string with no second popup.
  const label = `${ticker ?? name}${dWeightPp != null ? ` · ${d > 0 ? "+" : ""}${d.toFixed(2)}pp` : ""}`;

  return (
    <g role="img" aria-label={label}>
      <rect
        x={x} y={y} width={Math.max(0, width - 2)} height={Math.max(0, height - 2)}
        fill={s.fill} rx={3}
        // 1px seam in the page background rather than a heavy white border: the
        // old 1.5px white stroke visually ate the small tiles.
        stroke="rgba(255,255,255,0.85)" strokeWidth={1}
      />
      {showLabel && (
        <text
          x={x + width / 2} y={y + height / 2 + (showSub ? -2 : 4)}
          textAnchor="middle" fill={s.text} fontSize={11.5} fontWeight={700}
          // Explicit stroke:none. Recharts passes its own `stroke` prop down to
          // custom content, and inheriting it outlined every label and made the
          // text unreadable.
          stroke="none" style={{ paintOrder: "stroke" }}
        >
          {ticker ?? "—"}
        </text>
      )}
      {showSub && (
        <text
          x={x + width / 2} y={y + height / 2 + 12}
          textAnchor="middle" fill={s.sub} fontSize={9.5} fontWeight={600} stroke="none"
        >
          {`${d > 0 ? "+" : ""}${d.toFixed(1)}pp`}
        </text>
      )}
    </g>
  );
}

export function FundView({
  cik, period, mf, longsOnly, refreshing, group = [], onPeriod,
}: {
  cik: string;
  period: string;
  mf: Manifest;
  longsOnly: boolean;
  /** Reload in flight: dim in place, never unmount to skeletons. */
  refreshing?: boolean;
  /** The curated comparison set, so the Fund view can relate this manager back
      to the group instead of being a one-way trip. Same bounded list the
      Consensus view uses — never the full 9,000-filer universe. */
  group?: { cik: string; name: string }[];
  /** Select a quarter. The value chart is a quarter picker as much as it is a
      chart — the bars already say which quarter is selected, so not letting the
      user click the one they are looking at is a dead end. */
  onPeriod?: (period: string) => void;
}) {
  // Distinguishes a FIRST load (skeletons are right) from a reload (keep the
  // data mounted and dim it). A ref, not state: it must not itself retrigger.
  const hasData = useRef(false);
  const [summary, setSummary] = useState<FundSummary | null>(null);
  // issuerId -> how many OTHER tracked managers hold it this quarter.
  const [groupHolders, setGroupHolders] = useState<Map<string, number>>(new Map());
  const [fp, setFp] = useState<FundPeriod | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [valueView, setValueView] = useState<"Chart" | "Filings">("Chart");
  const [moverView, setMoverView] = useState<"Δ Weight" | "Δ Value">("Δ Weight");
  const [q, setQ] = useState("");
  // Private use: show every number by default. The structural-event note still
  // appears so the reader knows a -95.4% is one redemption rather than 27
  // trades, but the figures themselves are never hidden behind a click.
  const [showRaw, setShowRaw] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Only blank on a FIRST load; a reload dims in place (see WidgetCard).
    setLoading((prev) => prev || !hasData.current);
    setErr(null);
    setShowRaw(true);
    // Deliberately NOT setFp(null): clearing it here is what blanked the whole
    // fund page on every refresh. Stale-but-labelled beats a flash of skeleton.

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

        // PAINT ON PAGE 0, THEN BACKFILL.
        //
        // Books are paged because they vary enormously: the median manager has
        // a few hundred positions and Citadel has 12,857 across seven files.
        // Awaiting all of them before the first render meant switching to a big
        // manager sat on skeletons for the slowest of seven requests, to render
        // a treemap that shows the top 100 and a table showing a screenful.
        //
        // Page 0 carries the metadata and the first screenful, so it is enough
        // to draw everything above the fold. The rest merge in behind it, and
        // page 0's `total` is the true position count throughout — so no number
        // on screen is ever wrong, only briefly incomplete.
        const first = await loadFundPeriod(cik, period, mf, 0);
        if (cancelled) return;
        setFp(first);
        if (first.pages > 1) {
          const rest = await Promise.all(
            Array.from({ length: first.pages - 1 }, (_, i) => loadFundPeriod(cik, period, mf, i + 1)),
          );
          if (!cancelled) {
            setFp({ ...first, holdings: first.holdings.concat(...rest.map((r) => r.holdings)) });
          }
        }
      })
      .catch((e) => !cancelled && setErr(String(e.message ?? e)))
      .finally(() => {
        if (cancelled) return;
        hasData.current = true;
        setLoading(false);
      });
    return () => { cancelled = true; };
    // Key on the BUILD ID, not the manifest object. loadManifest(true) returns
    // a fresh object on every refresh even when the build has not changed, so
    // depending on `mf` retriggered this loader and remounted the view to
    // skeletons in order to repaint identical numbers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cik, period, mf.buildId]);

  const holdings = useMemo(() => {
    if (!fp) return [];
    return longsOnly ? fp.holdings.filter((h) => h.type === "" && h.unit === "SH") : fp.holdings;
  }, [fp, longsOnly]);

  /** The manager's own book has arrived. Stable across the page-0 -> full-book
   *  update, so effects that only need "is it here yet" do not run twice. */
  const bookReady = fp != null;

  // Group overlap, loaded separately and best-effort: it is one card, and it
  // must never be able to delay or break the manager's own numbers. Failures
  // per fund are swallowed — a missing fund simply does not contribute.
  useEffect(() => {
    let cancelled = false;
    const others = group.filter((g) => g.cik !== cik);
    // WAIT FOR THE MANAGER'S OWN DATA FIRST.
    //
    // This card needs eleven OTHER funds' books, which is more network than
    // everything else on the page combined. Firing it alongside the main load
    // made both slower: switching funds stalled on requests for a card at the
    // bottom of the page while the treemap and holdings table — the reason the
    // user clicked — waited behind them in the connection queue.
    //
    // Gated on `bookReady`, the page paints first and this fills in after.
    // Where the user came via the Consensus view these are already memoised and
    // it is free; where they came straight here it is late instead of blocking.
    //
    // The gate is a BOOLEAN, not `fp` itself. `fp` is set twice per fund — once
    // with page 0 so the page can paint, then again with the merged book — so
    // depending on the object identity ran this whole twelve-fund pass twice
    // for every fund switch. Nothing here reads the manager's own holdings; it
    // only needs to know they have arrived.
    if (!bookReady || !others.length) { setGroupHolders(new Map()); return; }
    (async () => {
      const tally = new Map<string, number>();
      await Promise.all(
        others.map(async (g) => {
          try {
            // PAGE 0 ONLY, not the whole book.
            //
            // Page 0 is the largest positions by value. Overlap is a "do these
            // managers own the same things" question, and a name sitting in the
            // tail of an 12,000-line book is not a shared conviction — so the
            // long tail costs three-quarters of the requests and changes almost
            // nothing. Fetching every page of eleven funds to decorate one card
            // is what made switching funds feel heavy.
            const p = await loadFundPeriod(g.cik, period, mf, 0);
            const seen = new Set<string>();
            for (const h of p.holdings) {
              if (h.type !== "" || h.unit !== "SH") continue;
              seen.add(h.issuerId);
            }
            for (const id of seen) tally.set(id, (tally.get(id) ?? 0) + 1);
          } catch { /* did not file, or unavailable — contributes nothing */ }
        }),
      );
      if (!cancelled) setGroupHolders(tally);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cik, period, mf.buildId, group, bookReady]);

  /**
   * Names this manager shares with the rest of the tracked set, biggest weight
   * first. Computed at ISSUER level, so GOOG and GOOGL count once — two CUSIPs
   * of one company are one overlapping idea, not two.
   */
  const overlap = useMemo(() => {
    if (!holdings.length || !groupHolders.size) return [];
    const byIssuer = new Map<string, { issuerId: string; ticker: string | null; name: string; weight: number }>();
    for (const h of holdings) {
      if (h.type !== "" || h.unit !== "SH") continue;
      const prev = byIssuer.get(h.issuerId);
      if (prev) prev.weight += h.weight ?? 0;
      else byIssuer.set(h.issuerId, { issuerId: h.issuerId, ticker: h.ticker, name: h.name, weight: h.weight ?? 0 });
    }
    return [...byIssuer.values()]
      .map((x) => ({ ...x, others: groupHolders.get(x.issuerId) ?? 0 }))
      .filter((x) => x.others > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 40);
  }, [holdings, groupHolders]);

  const meta = fp?.meta;
  const suppressed = Boolean(meta?.deltasSuppressed) && !showRaw;

  /**
   * Names opened this quarter — the other half of the anchor.
   *
   * Read off the SAME `holdings` array the rest of the page uses, so the
   * long-only toggle governs it and an option sleeve does not quietly appear in
   * a list of new stock positions.
   *
   * Grouped by issuer for the same reason the consensus view is: a manager who
   * already owned GOOGL and opened a small GOOG sleeve did not newly buy
   * Alphabet, and listing it here would say they did. Only issuers where EVERY
   * reported class is NEW survive — matching `dominantAction` in lib/consensus.
   */
  const entries = useMemo(() => {
    if (!holdings.length) return [];
    const byIssuer = new Map<
      string,
      { issuerId: string; ticker: string | null; name: string; type: string; value: number; weight: number; allNew: boolean }
    >();
    for (const h of holdings) {
      const prev = byIssuer.get(h.issuerId);
      if (prev) {
        prev.value += h.value;
        prev.weight += h.weight ?? 0;
        prev.allNew &&= h.action === "NEW";
        if (h.name.length < prev.name.length) prev.name = h.name;
      } else {
        byIssuer.set(h.issuerId, {
          issuerId: h.issuerId,
          ticker: h.ticker,
          name: h.name,
          type: h.type,
          value: h.value,
          weight: h.weight ?? 0,
          allNew: h.action === "NEW",
        });
      }
    }
    return [...byIssuer.values()].filter((x) => x.allNew).sort((a, b) => b.value - a.value);
  }, [holdings]);

  /**
   * Exits, on the SAME scope as the entries beside them.
   *
   * `fp.exits` used to render unfiltered while every other figure on the page
   * honoured the long-only toggle. On its own that was a quiet inconsistency;
   * sitting next to a new-names list that does honour it, it would read as a
   * discrepancy in the DATA rather than in the filter — "why is this option in
   * one column and not the other".
   */
  const exits = useMemo(() => {
    const all = fp?.exits ?? [];
    // Both halves of the predicate, matching `holdings` exactly. An exited
    // convertible note carries put_call "" just like exited common stock, so
    // filtering on type alone would keep the note — the unit is the only thing
    // that separates them. Artifacts predating the `unit` field read as SH:
    // wrongly showing a bond is a much smaller error than wrongly hiding a
    // stock, and it self-corrects as the ingest rewrites each artifact.
    return longsOnly ? all.filter((e) => e.type === "" && (e.unit ?? "SH") === "SH") : all;
  }, [fp, longsOnly]);

  /**
   * A position absent from the prior filing is INFERRED to be new — that is the
   * only evidence 13F offers (shared/fold.mjs, `if (!p) action = "NEW"`). If the
   * prior filing withheld positions under a confidential treatment request, the
   * inference does not hold: the manager may have owned the name all along and
   * simply not reported it. The exits card already refuses to guess in the
   * mirror-image case; this is the same refusal, pointed at the other quarter.
   */
  const priorConfidential = useMemo(
    () =>
      Boolean(meta?.priorPeriod) &&
      Boolean(summary?.series.find((s) => s.period === meta!.priorPeriod)?.confidentialOmitted),
    [meta, summary],
  );

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
        .slice(0, 100)
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

  // `series` arrives OLDEST-FIRST because loadFundSummary sorts it on arrival.
  // It is NOT safe to assume the artifact was written that way — the two ingest
  // paths emit opposite orders, and the universe ingest that serves production
  // emits newest-first. Trusting the file put the bars in reverse chronological
  // order and diffed each quarter against the one AFTER it.
  //
  // Deriving "latest" and "prior" from raw indices is still easy to get
  // backwards, so name both orderings explicitly.
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

  // Filed, but its holdings are outside the stored detail set. Distinct from
  // "has not filed" — the filing exists and is on EDGAR, we simply do not carry
  // the line items for every one of ~8,500 managers. Saying "has not filed" here
  // would be a plain factual error.
  if (!loading && summary && point && point.hasHoldings === false) {
    return (
      <div style={{ ...GRID_WIDE, marginTop: 22 }}>
        <WidgetCard
          refreshing={refreshing}
          title={summary.name}
          subtitle={`${periodLabel(period)} · reported ${usd(point.valueLongUsd)} across ${count(point.positions)} positions`}
          span={2}
          bodyMinHeight={220}
        >
          <EmptyState
            icon="◲"
            message="Line-item holdings are not stored for this manager"
            hint={`${summary.name} filed for ${periodLabel(period)} and its totals are shown above, but detailed holdings are kept for the largest managers only. The filing itself is on EDGAR.`}
          />
        </WidgetCard>
      </div>
    );
  }

  // Not filed for this quarter. A real, expected state — and the one that most
  // of the universe is in for six weeks after every quarter closes. Say so, and
  // offer the latest quarter this manager actually has.
  if (!loading && summary && !point) {
    const latest = latestPoint;
    return (
      <div style={{ ...GRID_WIDE, marginTop: 22 }}>
        <WidgetCard
          refreshing={refreshing}
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

  /**
   * `origin_missing`: the earliest filing we hold for this quarter is an
   * AMENDMENT, so the original was never ingested and this "book" is only the
   * rows that amendment happened to add.
   *
   * foldFilings has emitted this warning since it was written and nothing ever
   * consumed it — 146 of 1,864 fund-period artifacts carry it. The quarter was
   * published with the same confidence and the same total-value stat as a
   * complete one, and the following quarter then diffed against the stub and
   * reported nearly every position as newly bought.
   *
   * It cannot be fixed at read time; the missing original is simply not in the
   * data set. What it can do is stop presenting a fragment as a portfolio.
   */
  const originMissing = meta?.foldWarnings?.some((w) => w.code === "origin_missing") ?? false;

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
          refreshing={refreshing}
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
                      // Sit CLEAR of the cursor and above the map. A treemap is
                      // wall-to-wall tiles, so a tooltip anchored on the pointer
                      // always covers a neighbour — and often the tile being
                      // read. Offsetting it up and to the right keeps the tile
                      // under the cursor visible, and allowEscapeViewBox lets it
                      // leave the plot rather than being shoved back over the
                      // map at the edges.
                      offset={16}
                      allowEscapeViewBox={{ x: true, y: true }}
                      wrapperStyle={{ zIndex: 5, pointerEvents: "none" }}
                      contentStyle={{
                        background: "#fff", border: `1px solid ${t.borderSolid}`, borderRadius: 8,
                        fontSize: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.10)", padding: "6px 10px",
                      }}
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
                {[["#4f46e5", "new"], ["#047857", "up >2pp"], ["#a7f3d0", "up"], ["#eef0f2", "flat"], ["#fed7aa", "down"], ["#c2410c", "down >2pp"]].map(
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
          refreshing={refreshing}
          title="Reported 13F value"
          subtitle="Long equity at each quarter end. Never labelled AUM — it excludes shorts, cash and non-US holdings."
          span={2}
          bodyMinHeight={260}
          actions={
            <ViewToggle
              options={["Chart", "Filings"] as const}
              value={valueView}
              onChange={setValueView}
              hints={{
                Chart: "Reported value each quarter as bars. Click any bar to jump to that quarter.",
                Filings: "The same quarters as a table, with the note explaining anything unusual about each one.",
              }}
            />
          }
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
                  <Bar
                    dataKey="valueLongUsd"
                    radius={[4, 4, 0, 0]}
                    isAnimationActive={false}
                    // The bars ALREADY encode which quarter is selected, so a
                    // user who wants a different one naturally reaches for the
                    // bar rather than walking the stepper to it. Honour that.
                    cursor={onPeriod ? "pointer" : undefined}
                    // Recharts hands the click a WRAPPER, not the datum: the
                    // row lives on `.payload`. Reading `.period` off the top
                    // level silently yielded undefined and the click did
                    // nothing, which looks identical to "not wired up".
                    onClick={(d: { period?: string; payload?: { period?: string } } | undefined) => {
                      const next = d?.payload?.period ?? d?.period;
                      if (next && next !== period) onPeriod?.(next);
                    }}
                  >
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
                      {/* Amber is for WARNINGS about the data. "No prior
                          quarter to compare with" is not a warning, it is a
                          fact about coverage, so it renders grey and in plain
                          words. When every row said NO_PRIOR in amber the
                          channel meant nothing. */}
                      <td style={{ fontSize: 11, ...noteStyle(s) }}>{noteFor(s)}</td>
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
          refreshing={refreshing}
          title="Position changes"
          subtitle="Ranked by change in portfolio weight — moves can be trades or price."
          span={2}
          bodyMinHeight={240}
          actions={
            <ViewToggle
              options={["Δ Weight", "Δ Value"] as const}
              value={moverView}
              onChange={setMoverView}
              hints={{
                "Δ Weight": "Rank by change in share of the portfolio — how much more, or less, of the book this name takes up.",
                "Δ Value": "Rank by change in dollars. A price move alone can do this without the manager trading at all.",
              }}
            />
          }
          caveat={
            suppressed ? (
              <CaveatStrip
                action={
                  <button
                    className="pressable"
                    onClick={() => setShowRaw(false)}
                    style={{
                      border: "none", background: "transparent", color: "#92400e", cursor: "pointer",
                      fontSize: 11, fontWeight: 700, textDecoration: "underline", fontFamily: "inherit",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Hide the misleading deltas
                  </button>
                }
              >
                {suppressionReason}
              </CaveatStrip>
            ) : showRaw && meta?.deltasSuppressed ? (
              <CaveatStrip>Deltas hidden — they would describe one structural event as many separate trades.</CaveatStrip>
            ) : originMissing ? (
              <CaveatStrip>
                The original filing for this quarter is not in the data set — what is shown was
                reconstructed from a later amendment, so it is a fragment of the book rather than
                all of it. Totals and changes for this quarter understate the real portfolio.
              </CaveatStrip>
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
          refreshing={refreshing}
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
            <div style={{ maxHeight: 620, overflow: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Security</th><th>Class</th><th>Implied price</th><th>Shares</th>
                    <th>Δ Shares</th><th>Value</th><th>Δ Value</th><th>Weight</th><th>Δ Weight</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((h, i) => (
                    <tr key={`${h.issuerId}-${h.type}-${i}`}>
                      <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ fontWeight: 600 }}>{h.ticker ?? h.name}</span>
                        {h.ticker && <span style={{ color: t.textHint, marginLeft: 6, fontSize: 11 }}>{h.name}</span>}
                      </td>
                      <td
                        title={h.cls ?? undefined}
                        style={{
                          color: h.type ? t.warnAmber : h.unit === "PRN" ? t.textMuted : t.textSecondary,
                          fontSize: 10.5, fontWeight: 600, maxWidth: 120,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}
                      >
                        {/* Options and debt override the class, because "CALL" is
                            the more important fact about the row than "COM". */}
                        {h.type ? h.type.toUpperCase() : h.unit === "PRN" ? "PRN" : (h.cls || "COM")}
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
            </div>
          )}
        </WidgetCard>

        {/* INSIGHT — the anchor, both halves, side by side.

            These two cards are each half-width and adjacent on purpose: "what
            did they buy into and what did they get out of" is one question asked
            twice, and the client asked for the entries to sit next to the exits
            rather than being reachable only as a count in the Activity card. */}
        <WidgetCard
          refreshing={refreshing}
          title="New names this quarter"
          subtitle="Positions opened since the prior filing — the other half of the anchor."
          bodyMinHeight={200}
          caveat={
            priorConfidential ? (
              <CaveatStrip>
                The prior filing withheld positions pending confidential treatment, so a name here may
                have been held all along rather than newly bought.
              </CaveatStrip>
            ) : undefined
          }
        >
          {loading ? (
            <TableSkeleton rows={5} cols={2} />
          ) : !entries.length ? (
            /* The same three-way distinction the exits card makes, for the same
               reason. With no comparable prior quarter the ingest emits no
               actions at all, so an empty list here means "we cannot tell",
               never "they opened nothing". */
            <EmptyState
              icon={meta?.priorState === "PRIOR_OK" ? "○" : "◐"}
              message={meta?.priorState === "PRIOR_OK" ? "No new positions" : "Changes not comparable"}
              hint={meta?.priorState === "PRIOR_OK" ? undefined : "The prior quarter is missing or was a 13F notice, so nothing can be called new."}
            />
          ) : (
            <div style={{ maxHeight: 260, overflow: "auto" }}>
              <table className="data-table">
                <thead><tr><th>Security</th><th>Value now</th><th>Weight</th></tr></thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.issuerId}>
                      <td style={{ maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ fontWeight: 700 }}>{e.ticker ?? "—"}</span>
                        <span style={{ color: t.textHint, marginLeft: 6 }}>{e.name}</span>
                        {e.type && <span style={{ color: t.warnAmber, fontSize: 10, marginLeft: 5 }}>{e.type.toUpperCase()}</span>}
                      </td>
                      <td>{usd(e.value)}</td>
                      <td>{pct(e.weight)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* RECONCILE WITH THE COUNT ON THE SAME SCREEN.
                  Activity counts LINE ITEMS; this counts NAMES. A manager who
                  already owned GOOGL and opened a GOOG sleeve adds one new line
                  and no new name — the correct answer, and one that reads as a
                  bug if the two numbers sit a card apart with nothing joining
                  them. Shown only when they actually differ. */}
              {meta && meta.n_new !== entries.length && (
                <div style={{ padding: "8px 14px", fontSize: 11, color: t.textHint, lineHeight: 1.5 }}>
                  Activity counts {count(meta.n_new)} new line item{meta.n_new === 1 ? "" : "s"}; grouped by
                  issuer{longsOnly ? " and limited to long equity" : ""} that is {count(entries.length)}
                  {" "}new name{entries.length === 1 ? "" : "s"}. A new share class of a company already
                  held is not a new name.
                </div>
              )}
            </div>
          )}
        </WidgetCard>

        {/* INSIGHT — exits. A table, not a chart: the payload is names, and
            names are text. A dumbbell chart would hide the answer behind a hover. */}
        <WidgetCard
          refreshing={refreshing}
          title="Exited this quarter"
          subtitle="Positions closed since the prior filing — half of the anchor."
          bodyMinHeight={200}
        >
          {loading ? (
            <TableSkeleton rows={5} cols={2} />
          ) : !exits.length ? (
            /* Three genuinely different reasons for an empty list, and saying
               "No positions exited" for all of them is a lie in two of them.
               The confidential case matters most: positions were withheld, so
               an exit cannot be inferred at all — see shared/fold.mjs. */
            meta?.exitsWithheld ? (
              <EmptyState
                icon="◐"
                message={`${count(meta.exitsWithheld)} positions not reported this quarter`}
                hint="This filing withholds positions pending a confidential treatment request, so a position's absence is not evidence it was sold. Exits are not inferred for this quarter."
              />
            ) : (
              <EmptyState
                icon="○"
                message={meta?.priorState === "PRIOR_OK" ? "No positions exited" : "Changes not comparable"}
                hint={meta?.priorState === "PRIOR_OK" ? undefined : "The prior quarter is missing or was a 13F notice."}
              />
            )
          ) : (
            <div style={{ maxHeight: 260, overflow: "auto" }}>
              <table className="data-table">
                <thead><tr><th>Security</th><th>Value held</th><th>Weight</th></tr></thead>
                <tbody>
                  {exits.map((e, i) => (
                    <tr key={`${e.issuerId}-${i}`}>
                      {/* Ticker first, name after — matching the new-names table
                          beside it, so the eye can run down both columns and
                          compare them without re-learning the layout. */}
                      <td style={{ maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ fontWeight: 700 }}>{e.ticker ?? "—"}</span>
                        <span style={{ color: t.textHint, marginLeft: 6 }}>{e.name}</span>
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

        {/* ACTIVITY — §6.4. Every one of these numbers was already in the
            artifact and none of them reached the screen; only turnover did, as
            a single KPI. This is the merged WhaleWisdom 13-row stat table, cut
            to what is actually actionable and drawn as CSS flow bars rather
            than a chart (five bars do not justify a ResponsiveContainer). */}
        <WidgetCard
          refreshing={refreshing}
          title="Activity"
          subtitle="How the book changed, by position count"
          bodyMinHeight={200}
        >
          {loading || !meta ? (
            <ChartSkeleton bars={5} height={160} />
          ) : meta.deltasSuppressed ? (
            <EmptyState
              icon="—"
              message="Activity not comparable"
              hint={
                meta.priorState !== "PRIOR_OK"
                  ? "There is no prior quarter to measure this one against."
                  : "The whole book moved by one structural event, so counting it as trades would mislead."
              }
            />
          ) : (
            <div style={{ padding: "14px 16px" }}>
              {(() => {
                const bars = [
                  { label: "New", n: meta.n_new, color: ACTION_COLORS.NEW },
                  { label: "Added to", n: meta.n_added, color: ACTION_COLORS.ADDED },
                  { label: "Held flat", n: meta.n_held, color: ACTION_COLORS.HELD },
                  { label: "Trimmed", n: meta.n_trimmed, color: ACTION_COLORS.TRIMMED },
                  { label: "Exited", n: meta.n_exited, color: ACTION_COLORS.EXITED },
                ];
                const peak = Math.max(1, ...bars.map((b) => b.n ?? 0));
                return bars.map((b) => (
                  <div key={b.label} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 4 }}>
                      <span style={{ color: t.textSecondary, fontWeight: 600 }}>{b.label}</span>
                      <span style={{ color: t.textMuted, fontVariantNumeric: "tabular-nums" }}>{count(b.n ?? 0)}</span>
                    </div>
                    <div style={{ height: 8, background: "#f3f4f6", borderRadius: 4, overflow: "hidden" }}>
                      <div
                        className="flow-bar"
                        style={{ height: "100%", width: "100%", background: b.color, transform: `scaleX(${(b.n ?? 0) / peak})` }}
                      />
                    </div>
                  </div>
                ));
              })()}
              {/* Turnover always with its formula. Never an unexplained "34%". */}
              <p style={{ fontSize: 11, color: t.textHint, margin: "14px 0 0", lineHeight: 1.55 }}>
                Turnover {meta.turnover_position_pct == null ? "—" : `${meta.turnover_position_pct.toFixed(1)}%`} is
                (entries + exits) ÷ positions this quarter. Counts are of POSITIONS, not dollars: a manager
                can exit twenty small names and still be barely changed by value.
              </p>
            </div>
          )}
        </WidgetCard>

        {/* OVERLAP WITH GROUP — §6.4 calls this out specifically "so the Fund
            view is not a dead end". Without it, drilling into a manager is a
            one-way trip: nothing on the page relates them back to the others. */}
        <WidgetCard
          refreshing={refreshing}
          title="Overlap with the group"
          subtitle="Largest names shared with the tracked comparison set"
          bodyMinHeight={200}
        >
          {loading ? (
            <TableSkeleton rows={5} cols={2} />
          ) : !overlap.length ? (
            <EmptyState
              icon="○"
              message="No shared names"
              hint="Nothing in this book is also held by another tracked manager this quarter."
            />
          ) : (
            <div style={{ maxHeight: 260, overflow: "auto" }}>
              <table className="data-table">
                <thead><tr><th>Security</th><th>Also held by</th><th>Weight here</th></tr></thead>
                <tbody>
                  {overlap.map((o) => (
                    <tr key={o.issuerId}>
                      <td style={{ maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ fontWeight: 700 }}>{o.ticker ?? "—"}</span>
                        <span style={{ color: t.textHint, marginLeft: 6 }}>{o.name}</span>
                      </td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{o.others} other{o.others === 1 ? "" : "s"}</td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{pct(o.weight)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
