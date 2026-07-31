// src/views/ConsensusView.tsx
//
// The client's core ask: what these funds agree on, what moved, and — the stated
// "anchor" — what was newly bought and what was sold out of.

import { useEffect, useMemo, useState } from "react";
import { WidgetCard, ViewToggle, CaveatStrip } from "../components/WidgetCard";
import { Kpi, KpiRow } from "../components/Kpi";
import { ConsensusMatrix, MatrixLegend } from "../components/ConsensusMatrix";
import { MatrixSkeleton, EmptyState, ErrorState, PartialNotice, TableSkeleton } from "../components/states";
import { t, fundColor, ACTION_COLORS } from "../theme";
import { usd, pp, count, periodLabel, dateLabel } from "../lib/format";
import { buildConsensus, sortConsensus, buildAnchor, type FundInput, type SortKey } from "../lib/consensus";
import { TickerDrawer } from "../components/TickerDrawer";
import { downloadCsv } from "../lib/csv";
import { loadFundPeriodAll, MissingArtifactError, type Manifest, type Filer } from "../lib/data";
import { recentPeriods } from "../../shared/calendar.mjs";

const GRID_WIDE: React.CSSProperties = {
  display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fill, minmax(480px, 1fr))",
};

const THRESHOLDS = [
  { key: "2", label: "≥2 funds", min: 2 },
  { key: "3", label: "≥3 funds", min: 3 },
  { key: "all", label: "Unanimous", min: 0 }, // resolved against fund count
] as const;

function FundDot({ color, code }: { color: string; code: string }) {
  return (
    <span
      title={code}
      style={{
        display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9.5, fontWeight: 700,
        color: t.textMuted, whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0 }} />
      {code}
    </span>
  );
}

function AnchorList({
  items, tone, emptyMessage,
}: {
  items: ReturnType<typeof buildAnchor>["entries"];
  tone: "new" | "exit";
  emptyMessage: string;
}) {
  if (!items.length) {
    return <EmptyState icon={tone === "new" ? "★" : "○"} message={emptyMessage} />;
  }
  const accent = tone === "new" ? ACTION_COLORS.NEW : ACTION_COLORS.EXITED;
  return (
    <div style={{ maxHeight: 420, overflow: "auto" }}>
      {items.slice(0, 200).map((e) => (
        <div
          key={e.issuerId}
          style={{
            display: "flex", alignItems: "center", gap: 10, padding: "7px 14px",
            borderBottom: "1px solid #f3f4f6",
          }}
        >
          <span style={{ width: 3, height: 22, background: accent, borderRadius: 2, flexShrink: 0 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: t.textPrimary }}>{e.ticker ?? "—"}</div>
            <div style={{ fontSize: 10.5, color: t.textHint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {e.name}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: 160 }}>
            {e.funds.map((f) => <FundDot key={f.cik} color={f.color} code={f.code} />)}
          </div>
          <div style={{ fontSize: 11, color: t.textMuted, minWidth: 62, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
            {tone === "new" ? usd(e.value) : pp(-(e.weight ?? 0))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ConsensusView({
  filers, period, mf, longsOnly, refreshing, onFund,
}: {
  filers: Filer[];
  period: string;
  mf: Manifest;
  longsOnly: boolean;
  /** A manual refresh is in flight. Data stays mounted and dims; it never
      unmounts to skeletons, which would throw away the reading position. */
  refreshing?: boolean;
  onFund: (cik: string) => void;
}) {
  const [funds, setFunds] = useState<FundInput[] | null>(null);
  const [failedFunds, setFailedFunds] = useState<string[]>([]);
  const [history, setHistory] = useState<Map<string, number[]>>(new Map());
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [threshold, setThreshold] = useState<string>("2");
  const [sortKey, setSortKey] = useState<SortKey>("funds");
  const [query, setQuery] = useState("");
  // §6.3 move filters. These are the highest-signal questions the grid can
  // answer — "show me only what somebody newly bought" — and they were the
  // one part of the chip row that was never built.
  const [moveFilter, setMoveFilter] = useState<"" | "new" | "exit" | "buys" | "sells">("");
  const [openIssuer, setOpenIssuer] = useState<string | null>(null);
  // Render a fast default and let the user ask for the rest.
  //
  // Across the full universe there are thousands of consensus names; at 12 fund
  // columns that is ~67,000 cells, which took 18 seconds to lay out and froze
  // interaction. "Show everything" stops being show-everything at the point the
  // page cannot be used — so the default is the top slice, sorted, with the full
  // count one click away.
  const [showAll, setShowAll] = useState(false);
  const DEFAULT_ROWS = 60;

  // Load every watchlist fund for this quarter, plus the five quarters behind it
  // for the holder-count sparkline. Fourteen-odd cached file reads and a
  // client-side group-by — no server, no precomputed per-watchlist table, so any
  // arbitrary fund set answers immediately.
  useEffect(() => {
    let cancelled = false;
    // Keep whatever is already on screen mounted while reloading. Blanking to
    // skeletons on every refresh throws away the user's reading position to
    // repaint, usually, the identical numbers. WidgetCard's `refreshing` state
    // (dim + a 2px indeterminate bar) exists precisely for this.
    setLoading((prev) => prev || funds === null);
    setErr(null);

    const load = async () => {
      const inputs: FundInput[] = [];
      const failed: string[] = [];
      await Promise.all(
        filers.map(async (f, i) => {
          const color = fundColor(i);
          const code = f.code ?? f.name.slice(0, 3).toUpperCase();
          const blank = { cik: f.cik, name: f.name, code, color, holdings: [], exits: [], suppressed: false };
          try {
            const fp = await loadFundPeriodAll(f.cik, period, mf);
            inputs[i] = {
              ...blank,
              holdings: fp.holdings, exits: fp.exits ?? [],
              suppressed: Boolean(fp.meta.deltasSuppressed), missing: false,
            };
          } catch (e) {
            // ONE FUND MUST NOT TAKE DOWN THE VIEW.
            //
            // This is a Promise.all over twelve funds. It used to rethrow
            // anything that was not a MissingArtifactError, so a single R2 5xx
            // or truncated body rejected the whole batch and the entire page —
            // KPIs, matrix, entries and exits, sources — collapsed to one
            // "Couldn't load this widget" card while eleven funds had loaded
            // perfectly well.
            //
            // Two different absences, kept distinct: `missing` means the
            // manager did not file this quarter, which is ordinary and gets a
            // dimmed column; a genuine failure is counted and named, so the
            // matrix can say which funds are absent rather than pretending
            // they hold nothing.
            const missing = e instanceof MissingArtifactError;
            if (!missing) failed.push(f.name);
            inputs[i] = { ...blank, missing: true };
          }
        }),
      );
      if (cancelled) return;
      setFailedFunds(failed);
      setFunds(inputs.filter(Boolean));

      // Holder history, best-effort: it decorates the matrix and must never
      // block or fail it.
      const periods = (recentPeriods(period, 6) as string[]).slice().reverse();
      const counts = new Map<string, number[]>();
      for (const p of periods) {
        const perIssuer = new Set<string>();
        const tally = new Map<string, number>();
        let covered = 0;
        await Promise.all(
          filers.map(async (f) => {
            try {
              const fp = await loadFundPeriodAll(f.cik, p, mf);
              covered++;
              const seen = new Set<string>();
              for (const h of fp.holdings) {
                if (!h.issuerId || (longsOnly && (h.type !== "" || h.unit !== "SH"))) continue;
                if (seen.has(h.issuerId)) continue;
                seen.add(h.issuerId);
                tally.set(h.issuerId, (tally.get(h.issuerId) ?? 0) + 1);
              }
            } catch { /* missing quarter — contributes zero */ }
          }),
        );

        // DROP QUARTERS WE BARELY COVER, rather than plotting them as a dip.
        //
        // Holdings are retained for 4 quarters across the whole universe, so
        // the 5th and 6th quarters back exist for almost nobody. Counting those
        // the same way produced a trend like 9, 1, 1, 1, 10, 11 — which reads
        // as "every manager sold out and then piled back in" when what actually
        // happened is that we stopped keeping their line items. A sparkline
        // that shows a collapse which did not occur is worse than a shorter
        // sparkline.
        //
        // Half the funds is the bar: below that the number is measuring our
        // retention window, not the herd.
        if (covered * 2 < filers.length) continue;

        for (const [id, n] of tally) {
          if (!counts.has(id)) counts.set(id, []);
          counts.get(id)!.push(n);
          perIssuer.add(id);
        }
        // Keep series aligned: an issuer nobody held that quarter gets a 0.
        for (const [id, arr] of counts) if (!perIssuer.has(id)) arr.push(0);
      }
      if (!cancelled) setHistory(counts);
    };

    load()
      .catch((e) => !cancelled && setErr(String(e.message ?? e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mf is keyed by buildId on purpose; see below
  }, [filers, period, mf.buildId, longsOnly]);

  const present = useMemo(() => (funds ?? []).filter((f) => !f.missing), [funds]);

  const minFunds = useMemo(() => {
    const th = THRESHOLDS.find((x) => x.key === threshold);
    if (!th) return 2;
    return th.key === "all" ? Math.max(2, present.length) : th.min;
  }, [threshold, present.length]);

  const allMatching = useMemo(() => {
    if (!funds) return [];
    return sortConsensus(buildConsensus(funds, { minFunds, longsOnly }), sortKey);
  }, [funds, minFunds, longsOnly, sortKey]);

  /**
   * Search + move filters, applied over the sorted set.
   *
   * Before this, the only way to find one name among thousands was to expand
   * the matrix to 1,500 rows x 12 columns and use the browser's own Ctrl-F.
   * The plan mandates one search box per view and this was the view without
   * one — in the product's primary view.
   *
   * Matching is on TICKER and ISSUER NAME, the two things a user actually
   * knows. Not on issuerId, which is an internal hash, and emphatically not on
   * CUSIP, which never reaches the client at all.
   */
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allMatching.filter((r) => {
      if (q && !(r.ticker?.toLowerCase().includes(q) || r.name.toLowerCase().includes(q))) return false;
      switch (moveFilter) {
        case "new":   return r.nNew > 0;
        case "exit":  return r.nExited > 0;
        // "Consensus buys/sells" is about AGREEMENT, not a single mover: the
        // group has to lean one way on balance. netDirection is +1 per
        // add-or-new and -1 per trim-or-exit, so its sign is exactly that lean.
        case "buys":  return r.netDirection > 0;
        case "sells": return r.netDirection < 0;
        default:      return true;
      }
    });
  }, [allMatching, query, moveFilter]);

  // Anchor + distribution pass: every name any fund touched, INCLUDING names
  // the whole group exited (zero holders, which no holder threshold would keep).
  const allRows = useMemo(() => {
    if (!funds) return [];
    return buildConsensus(funds, { minFunds: 1, longsOnly, includeExitOnly: true });
  }, [funds, longsOnly]);

  const anchor = useMemo(() => (funds ? buildAnchor(funds, allRows) : null), [funds, allRows]);

  const combinedValue = useMemo(
    () => present.reduce((a, f) => a + f.holdings.filter((h) => h.type === "" && h.unit === "SH").reduce((s, h) => s + h.value, 0), 0),
    [present],
  );

  if (err) {
    return <div style={GRID_WIDE}><WidgetCard title="Consensus" span={2}><ErrorState message={err} /></WidgetCard></div>;
  }

  const missing = (funds ?? []).filter((f) => f.missing);
  const suppressed = (funds ?? []).filter((f) => f.suppressed);

  return (
    <>
      <KpiRow>
        <Kpi
          label="Funds filed"
          value={loading ? "…" : `${present.length} of ${funds?.length ?? 0}`}
          scope={missing.length ? `${missing.length} not yet filed` : "All tracked funds"}
        />
        <Kpi
          label="Consensus names"
          value={loading ? "…" : count(rows.length)}
          scope={`Held by ${minFunds}+ of ${present.length}`}
        />
        <Kpi
          label="New this quarter"
          value={loading ? "…" : count(anchor?.entries.length ?? 0)}
          scope="First appearance in any fund"
        />
        <Kpi
          label="Exited this quarter"
          value={loading ? "…" : count(anchor?.exits.length ?? 0)}
          scope={anchor?.suppressedExits ? `${anchor.suppressedExits} withheld` : "Position closed"}
        />
        <Kpi
          label="Combined long value"
          value={loading ? "…" : usd(combinedValue)}
          scope="13F equity longs only"
        />
      </KpiRow>

      <div style={{ ...GRID_WIDE, marginTop: 22 }}>
        {/* PRIMARY */}
        <WidgetCard
          refreshing={refreshing}
          title="Consensus matrix"
          subtitle={
            `Comparing ${funds?.length ?? filers.length} active managers · names held by ${minFunds}+ · ` +
            `shading is portfolio weight, glyph is this quarter's move`
          }
          span={2}
          // Only reserve height while loading or when there is enough content to
          // fill it. A fixed 300px min-height left a ~400px void under a
          // single-row result, which reads as a broken widget rather than as a
          // narrow filter.
          bodyMinHeight={loading ? 300 : undefined}
          actions={
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <ViewToggle
                options={THRESHOLDS.map((x) => x.label) as unknown as readonly string[]}
                value={THRESHOLDS.find((x) => x.key === threshold)!.label}
                onChange={(label) => setThreshold(THRESHOLDS.find((x) => x.label === label)!.key)}
              />
              <ViewToggle
                options={["Funds", "Value", "Net move"] as const}
                value={sortKey === "funds" ? "Funds" : sortKey === "value" ? "Value" : "Net move"}
                onChange={(v) => setSortKey(v === "Funds" ? "funds" : v === "Value" ? "value" : "net")}
              />
              {/* §6.3 move chips. Toggling, not radio: clicking the active one
                  clears it, so there is always a way back to everything. */}
              {([
                ["new", "Has NEW"], ["exit", "Has EXIT"],
                ["buys", "Consensus buys"], ["sells", "Cons. sells"],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  className="pressable"
                  onClick={() => setMoveFilter((v) => (v === key ? "" : key))}
                  aria-pressed={moveFilter === key}
                  style={{
                    fontSize: 11, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
                    padding: "4px 9px", borderRadius: 7,
                    border: `1px solid ${moveFilter === key ? t.primaryBorder : t.border}`,
                    background: moveFilter === key ? t.primaryLight : "#fff",
                    color: moveFilter === key ? t.primaryText : t.textMuted,
                  }}
                >
                  {label}
                </button>
              ))}
              <label style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span className="sr-only">Search consensus names</span>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search ticker or issuer…"
                  style={{
                    fontSize: 11.5, fontFamily: "inherit", padding: "5px 9px", borderRadius: 7,
                    border: `1px solid ${t.border}`, width: 168, color: t.textPrimary, outline: "none",
                  }}
                />
              </label>
              <button
                className="pressable"
                onClick={() =>
                  downloadCsv(
                    `13f-consensus-${period}.csv`,
                    rows,
                    // Export mirrors the view-model, so it inherits the CUSIP
                    // exclusion and the suppressed-delta rules automatically.
                    [
                      { header: "Ticker", cell: (r) => r.ticker ?? "" },
                      { header: "Issuer", cell: (r) => r.name },
                      { header: "Funds holding", cell: (r) => r.fundCount },
                      { header: "Combined value (USD)", cell: (r) => Math.round(r.combinedValue) },
                      { header: "Net direction", cell: (r) => r.netDirection },
                      { header: "New", cell: (r) => r.nNew },
                      { header: "Exited", cell: (r) => r.nExited },
                      { header: "Share classes", cell: (r) => r.shareClasses },
                      ...(funds ?? []).map((f) => ({
                        header: `${f.code} weight %`,
                        cell: (r: typeof rows[number]) => r.cells[f.cik]?.weight ?? "",
                      })),
                    ],
                  )
                }
                style={{
                  fontSize: 11, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
                  padding: "4px 9px", borderRadius: 7, border: `1px solid ${t.border}`,
                  background: "#fff", color: t.textMuted,
                }}
              >
                Export CSV
              </button>
            </div>
          }
          caveat={
            missing.length || suppressed.length ? (
              <CaveatStrip>
                {missing.length > 0 && `${missing.map((f) => f.name).join(", ")} ${missing.length === 1 ? "has" : "have"} not filed for ${periodLabel(period)}. `}
                {suppressed.length > 0 && `${suppressed.map((f) => f.name).join(", ")} filed a structural change, so ${suppressed.length === 1 ? "its" : "their"} moves are excluded from group totals.`}
              </CaveatStrip>
            ) : undefined
          }
        >
          {loading ? (
            <MatrixSkeleton
              funds={(funds ?? []).length
                ? funds!.map((f) => f.code)
                : filers.map((f) => f.code ?? f.name.slice(0, 3).toUpperCase())}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon="▦"
              message={`No names held by ${minFunds} or more funds`}
              hint="Lower the overlap threshold, or step back a quarter."
            />
          ) : (
            <>
              <ConsensusMatrix
                rows={rows}
                funds={funds ?? []}
                holderHistory={history}
                maxRows={showAll ? 1500 : DEFAULT_ROWS}
                onFund={onFund}
                onTicker={setOpenIssuer}
              />
              <div
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                  padding: "8px 14px", borderTop: `1px solid ${t.border}`, flexWrap: "wrap",
                }}
              >
                <MatrixLegend />
                {rows.length > DEFAULT_ROWS && (
                  <button
                    className="pressable"
                    onClick={() => setShowAll((v) => !v)}
                    style={{
                      border: "none", background: "transparent", color: t.primaryText, cursor: "pointer",
                      fontSize: 11, fontWeight: 700, fontFamily: "inherit", textDecoration: "underline",
                    }}
                  >
                    {showAll ? `Collapse to top ${DEFAULT_ROWS}` : `Show all ${count(rows.length)} consensus names`}
                  </button>
                )}
              </div>
            </>
          )}
        </WidgetCard>

        {/* THE ANCHOR — both halves visible at once, no toggle: "what are they
            focused on" is a comparison question, and hiding one side behind a
            tab breaks the comparison. */}
        <WidgetCard
          refreshing={refreshing}
          title="Entries &amp; exits"
          subtitle="New positions and closed positions across the group — the anchor"
          span={2}
          bodyMinHeight={260}
          caveat={
            // Only surface this when something was ACTUALLY withheld. "0 moves
            // withheld" is noise that trains the reader to skip the strip, which
            // costs us the one time it matters.
            anchor && anchor.suppressedExits > 0 ? (
              <CaveatStrip>
                {anchor.suppressedExits} move{anchor.suppressedExits === 1 ? "" : "s"} withheld from{" "}
                {anchor.suppressedFunds.join(", ")} — a structural change, not trading.
              </CaveatStrip>
            ) : undefined
          }
        >
          {loading || !anchor ? (
            <TableSkeleton rows={6} cols={3} />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1px 1fr" }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: ACTION_COLORS.NEW, padding: "9px 14px 4px" }}>
                  New positions ({anchor.entries.length})
                </div>
                <AnchorList items={anchor.entries} tone="new" emptyMessage="No new positions this quarter" />
              </div>
              <div style={{ background: t.border }} />
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: ACTION_COLORS.EXITED, padding: "9px 14px 4px" }}>
                  Exited ({anchor.exits.length})
                </div>
                <AnchorList items={anchor.exits} tone="exit" emptyMessage="No positions exited this quarter" />
              </div>
            </div>
          )}
        </WidgetCard>

        {/* SOURCE */}
        <WidgetCard title="Sources &amp; provenance" subtitle="What this view is built from" span={2} refreshing={refreshing}>
          <div style={{ padding: "12px 16px" }}>
            {/* A fund that did not FILE and a fund that failed to LOAD are
                different facts and must not share one sentence. The first is
                ordinary and expected; the second means the numbers on screen
                are computed over fewer funds than the user thinks. */}
            {failedFunds.length > 0 && (
              <PartialNotice>
                {failedFunds.length} of {funds?.length ?? 0} funds could not be loaded
                ({failedFunds.join(", ")}). Every figure on this page is computed over the
                {" "}{present.length} that did load. Refresh to try again.
              </PartialNotice>
            )}
            {missing.length > 0 && (
              <PartialNotice>
                Showing {present.length} of {funds?.length ?? 0} funds. 13F is due 45 days after each
                quarter ends and most managers file close to the deadline, so a just-closed quarter is
                always incomplete.
              </PartialNotice>
            )}
            <div style={{ fontSize: 11.5, color: t.textSecondary, lineHeight: 1.65 }}>
              <p style={{ margin: "0 0 8px" }}>
                Overlap is computed per <strong>issuer</strong>, not per share class — GOOG and GOOGL
                are one company, and comparing them separately would report zero overlap on Alphabet.
                Class counts appear in each cell's tooltip.
              </p>
              <p style={{ margin: 0 }}>
                Positions are as of {dateLabel(period)}. 13F covers long US-listed equity and options
                only — no shorts, cash, bonds or non-US listings. Ticker and issuer name only; CUSIPs
                are licensed by CGS/ABA and are neither displayed nor exported.
              </p>
            </div>
            <div
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                borderTop: `1px solid ${t.border}`, paddingTop: 10, marginTop: 12, fontSize: 11, color: t.textHint,
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
        </WidgetCard>

        {/* COMBINED HOLDINGS — §6.4. The matrix answers "who agrees on what" in
            a grid; this answers "what does the group own, in order" as a list.
            Same filtered set, so the search box and chips above govern both. */}
        <WidgetCard
          refreshing={refreshing}
          title="Combined holdings"
          subtitle="Every name the group holds, aggregated across funds — searchable above"
          span={2}
          bodyMinHeight={220}
          actions={
            <span style={{ fontSize: 11, color: t.textHint }}>
              {count(rows.length)} of {count(allMatching.length)} names
            </span>
          }
        >
          {loading ? (
            <TableSkeleton rows={6} cols={5} />
          ) : !rows.length ? (
            <EmptyState icon="▤" message="Nothing matches" hint="Clear the search or the move filter." />
          ) : (
            <div style={{ maxHeight: 420, overflow: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Security</th><th>Funds</th><th>Combined value</th>
                    <th>Net move</th><th>New</th><th>Exited</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 400).map((r) => (
                    <tr key={r.issuerId}>
                      <td>
                        <button
                          className="pressable"
                          onClick={() => setOpenIssuer(r.issuerId)}
                          style={{
                            border: "none", background: "transparent", cursor: "pointer",
                            fontFamily: "inherit", fontSize: 12, textAlign: "left", padding: 0,
                            color: t.textPrimary,
                          }}
                        >
                          <span style={{ fontWeight: 700 }}>{r.ticker ?? "—"}</span>
                          <span style={{ color: t.textHint, marginLeft: 7 }}>{r.name}</span>
                        </button>
                      </td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.fundCount}</td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{usd(r.combinedValue)}</td>
                      <td
                        style={{
                          fontVariantNumeric: "tabular-nums",
                          color: r.netDirection > 0 ? "#059669" : r.netDirection < 0 ? "#dc2626" : t.textMuted,
                        }}
                      >
                        {r.netDirection > 0 ? "+" : ""}{r.netDirection}
                      </td>
                      <td style={{ color: r.nNew ? ACTION_COLORS.NEW : t.textHint }}>{r.nNew || "—"}</td>
                      <td style={{ color: r.nExited ? ACTION_COLORS.EXITED : t.textHint }}>{r.nExited || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 400 && (
                <div style={{ padding: "8px 14px", fontSize: 11, color: t.textHint }}>
                  Showing the first 400 of {count(rows.length)}. Narrow with the search box above, or export the full set.
                </div>
              )}
            </div>
          )}
        </WidgetCard>
      </div>

      {/* Ticker drill-down. Rendered from `rows` and `history` that are already
          in memory, so opening it costs a render rather than a round trip.
          Absolutely positioned (see .drawer), so Zone 2 never reflows and no
          chart behind it re-measures or replays its entrance. */}
      <TickerDrawer
        row={allMatching.find((r) => r.issuerId === openIssuer) ?? null}
        funds={funds ?? []}
        history={history}
        period={period}
        open={Boolean(openIssuer)}
        onClose={() => setOpenIssuer(null)}
        onFund={(c) => { setOpenIssuer(null); onFund(c); }}
      />
    </>
  );
}
