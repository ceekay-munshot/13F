// src/views/ConsensusView.tsx
//
// The client's core ask: what these funds agree on, what moved, and — the stated
// "anchor" — what was newly bought and what was sold out of.

import { useEffect, useMemo, useState } from "react";
import { WidgetCard, ViewToggle, CaveatStrip } from "../components/WidgetCard";
import { Kpi, KpiRow } from "../components/Kpi";
import { ConsensusMatrix, MatrixLegend } from "../components/ConsensusMatrix";
import { MatrixSkeleton, EmptyState, ErrorState, TableSkeleton } from "../components/states";
import { t, fundColor, ACTION_COLORS } from "../theme";
import { usd, pct, pp, count, periodLabel } from "../lib/format";
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

/**
 * The orderings the overlap list can be read in.
 *
 * "Funds" and "Total weight" are the client's two stated questions — how many
 * of my funds own this, and how much of their books does it add up to — so they
 * lead. One list, re-sorted, rather than two lists that would then have to be
 * kept consistent with each other.
 */
/**
 * `dir` is NOT decoration — it is what the caret and `aria-sort` announce.
 *
 * Three of these rank high-to-low, but "Net move" deliberately does not: its
 * job is to surface the name the group sold hardest, so sortConsensus puts the
 * most negative netDirection first. A shared header that always claimed
 * "descending" told a screen reader the exact opposite of the order on screen
 * for that one column.
 */
const SORTS = [
  { key: "funds", label: "Funds", dir: "desc" },
  { key: "weight", label: "Total weight", dir: "desc" },
  { key: "value", label: "Value", dir: "desc" },
  { key: "net", label: "Net move", dir: "asc" },
] as const satisfies readonly { key: SortKey; label: string; dir: "asc" | "desc" }[];

const sortLabel = (key: SortKey) => SORTS.find((s) => s.key === key)?.label ?? "Funds";
const sortDir = (key: SortKey) => SORTS.find((s) => s.key === key)?.dir ?? "desc";

/**
 * A column header that sorts the list it heads.
 *
 * Clicking the thing you want to sort by is the whole interaction — no menu, no
 * second control to find. It drives the SAME sort state as the toggle in the
 * matrix header above, so the two can never disagree about what order the page
 * is in.
 */
function SortTh({
  label, sortKey: key, active, onSort, hint,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  onSort: (k: SortKey) => void;
  hint?: string;
}) {
  const on = active === key;
  const asc = sortDir(key) === "asc";
  return (
    <th aria-sort={on ? (asc ? "ascending" : "descending") : "none"} title={hint}>
      <button
        className="pressable"
        onClick={() => onSort(key)}
        style={{
          border: "none", background: "transparent", padding: 0, cursor: "pointer",
          font: "inherit", color: on ? t.primaryText : "inherit",
          fontWeight: on ? 700 : undefined,
          display: "inline-flex", alignItems: "center", gap: 3,
        }}
      >
        {label}
        {/* The caret only appears on the active column, and points the way the
            column is actually ordered. A permanent set of up/down arrows on
            every header is chrome that says nothing. */}
        <span aria-hidden="true" style={{ fontSize: 8, opacity: on ? 1 : 0 }}>{asc ? "▲" : "▼"}</span>
      </button>
    </th>
  );
}

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
            // Two different absences, kept distinct — and they need TWO flags,
            // not one. `missing` means the column has no holdings and must be
            // dimmed; `failed` means the reason was a fetch error rather than a
            // non-filing. They used to be the same boolean, so a fund we simply
            // could not download was reported to the user, in the caveat strip
            // and in the KPI, as one that "has not filed for Q1 2026" — a
            // sentence about the manager that was actually about our network.
            const notFiled = e instanceof MissingArtifactError;
            if (!notFiled) failed.push(f.name);
            inputs[i] = { ...blank, missing: true, failed: !notFiled };
          }
        }),
      );
      if (cancelled) return;
      setFailedFunds(failed);
      setFunds(inputs.filter(Boolean));
      // PAINT NOW. Everything below this line only DECORATES the matrix with a
      // holder-count sparkline; the matrix itself is fully determined by what
      // was just set. Leaving `loading` true until the history finished meant
      // the grid sat as skeletons through dozens of extra requests — with the
      // caveat strips and KPI subtitles already rendered around it, which is
      // what made it look hung rather than loading.
      setLoading(false);

      // Holder history, best-effort: it decorates the matrix and must never
      // block or fail it.
      //
      // FOUR quarters, not six, and all of them in flight at once. Line items
      // are retained for four quarters, so the fifth and sixth were 404s for
      // almost every fund — dozens of requests whose only possible answer was
      // "no data", which the coverage filter then discarded anyway. Walking the
      // periods with a sequential `for` also serialised them, so the wait was
      // the SUM of six round trips rather than the slowest one.
      const periods = (recentPeriods(period, 4) as string[]).slice().reverse();
      // Every (quarter, fund) pair in flight at once, then assembled in order.
      const perQuarter = await Promise.all(
        periods.map(async (p) => {
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
              } catch { /* did not file that quarter — contributes nothing */ }
            }),
          );
          return { tally, covered };
        }),
      );
      if (cancelled) return;

      const counts = new Map<string, number[]>();
      for (const { tally, covered } of perQuarter) {
        // DROP QUARTERS WE BARELY COVER, rather than plotting them as a dip.
        //
        // Below half the funds the number is measuring our retention window,
        // not the herd. Counting them produced a trend like 9, 1, 1, 1, 10, 11,
        // which reads as "everyone sold out and piled back in" when what
        // actually happened is that we stopped keeping their line items.
        if (covered * 2 < filers.length) continue;
        const perIssuer = new Set<string>();
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

  // "Has not filed" is a claim about the MANAGER. A fund we failed to fetch is
  // absent for a reason of our own, so it belongs in the failure sentence and
  // nowhere else — otherwise one fund produces two contradictory statements.
  const notFiled = (funds ?? []).filter((f) => f.missing && !f.failed);
  const suppressed = (funds ?? []).filter((f) => f.suppressed);

  return (
    <>
      <KpiRow>
        <Kpi
          label="Funds filed"
          value={loading ? "…" : `${present.length} of ${funds?.length ?? 0}`}
          scope={
            failedFunds.length
              ? `${failedFunds.length} could not be loaded${notFiled.length ? `, ${notFiled.length} not yet filed` : ""}`
              : notFiled.length
                ? `${notFiled.length} not yet filed`
                : "All tracked funds"
          }
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
                options={SORTS.map((s) => s.label) as unknown as readonly string[]}
                value={sortLabel(sortKey)}
                onChange={(label) => setSortKey(SORTS.find((s) => s.label === label)!.key)}
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
                      // Summed, then averaged — the export carries both so a
                      // spreadsheet does not have to re-derive one from the other
                      // and get the exit-cell handling wrong.
                      // Empty, not "0.00", when no holder reported a weight —
                      // a spreadsheet averaging this column must not be fed a
                      // zero we never measured.
                      { header: "Total weight across funds (pct points)", cell: (r) => r.sumWeight?.toFixed(2) ?? "" },
                      { header: "Average weight per holder (pct)", cell: (r) => r.avgWeight?.toFixed(2) ?? "" },
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
            // THREE DIFFERENT ABSENCES, AND THEY ARE NOT THE SAME SENTENCE.
            //
            // A fund that has not FILED is ordinary. A fund whose quarter was a
            // structural event is filed but not comparable. A fund that FAILED
            // TO LOAD means every figure on this page is computed over fewer
            // funds than the column headers imply — the only one of the three
            // that makes the numbers themselves suspect, and the one that used
            // to live at the bottom of the page in the provenance card.
            notFiled.length || suppressed.length || failedFunds.length ? (
              <CaveatStrip>
                {failedFunds.length > 0 && `${failedFunds.join(", ")} could not be loaded — every figure here is computed over the ${present.length} funds that did. Refresh to try again. `}
                {notFiled.length > 0 && `${notFiled.map((f) => f.name).join(", ")} ${notFiled.length === 1 ? "has" : "have"} not filed for ${periodLabel(period)}. `}
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

        {/* The "Sources & provenance" card that used to sit here was removed at
            the client's request — it was a standing block of explanation on a
            page they read every day. Nothing it carried was lost: the
            issuer-level grouping is stated in the matrix cell tooltips and the
            drawer, and the two facts that CHANGE — funds that failed to load and
            funds that have not filed — moved into the matrix caveat strip above,
            where they appear only when they are true. */}

        {/* OVERLAPPING HOLDINGS — §6.4. The matrix answers "who agrees on what"
            in a grid; this answers the same question as a ranked list, which is
            what you want when the question is "give me the top ten".

            Every row here is BY DEFINITION an overlap: `rows` comes from
            buildConsensus at the current threshold, which is ≥2 funds unless the
            user raises it. So the list needs no filter of its own — the
            threshold chips, search box and move chips above govern it. */}
        <WidgetCard
          refreshing={refreshing}
          title="Overlapping holdings"
          subtitle={`Names held by ${minFunds}+ of the favourite funds · click a column heading to re-rank`}
          span={2}
          bodyMinHeight={220}
          actions={
            <span style={{ fontSize: 11, color: t.textHint }}>
              {count(rows.length)} of {count(allMatching.length)} names · by {sortLabel(sortKey).toLowerCase()}
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
                    <th>Security</th>
                    <SortTh
                      label="Funds"
                      sortKey="funds"
                      active={sortKey}
                      onSort={setSortKey}
                      hint="How many of the favourite funds hold this name. Share classes count once."
                    />
                    <SortTh
                      label="Total weight"
                      sortKey="weight"
                      active={sortKey}
                      onSort={setSortKey}
                      hint="Each holder's portfolio weight, added up. Not a percentage of the group — a conviction score."
                    />
                    <SortTh
                      label="Combined value"
                      sortKey="value"
                      active={sortKey}
                      onSort={setSortKey}
                      hint="Total dollars the group holds in this name."
                    />
                    <SortTh
                      label="Net move"
                      sortKey="net"
                      active={sortKey}
                      onSort={setSortKey}
                      hint="+1 per fund that added or opened, −1 per fund that trimmed or exited."
                    />
                    <th>New</th><th>Exited</th>
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
                      <td
                        style={{ fontVariantNumeric: "tabular-nums" }}
                        title={`${pct(r.avgWeight)} average per holder`}
                      >
                        {pct(r.sumWeight)}
                      </td>
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
              {/* Say what the column MEANS, once, under the column — not in a
                  glossary. "Total weight" is the one number here a reader can
                  confidently misread, because it looks like a share of the
                  group's money and is not one. */}
              <div style={{ padding: "8px 14px", fontSize: 11, color: t.textHint, lineHeight: 1.5 }}>
                Total weight adds each holder's own portfolio weight together — five funds at 5% each
                is 25%. It ranks conviction across the group; it is not a share of the group's money.
                Hover a figure for the average per holder.
                {rows.length > 400 && (
                  <> Showing the first 400 of {count(rows.length)} — narrow with the search box above, or export the full set.</>
                )}
              </div>
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
