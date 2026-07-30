// src/views/FilingsView.tsx
//
// "Is the data current, and what just landed?" — the operational view.
//
// This is the one place the 45-day lag is stated as a fact rather than implied,
// because here it IS the subject: a filing's accepted-at, its lag, and how many
// managers are still outstanding.

import { useEffect, useMemo, useState } from "react";
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip, ReferenceLine, Cell as RCell } from "recharts";
import { WidgetCard, ViewToggle } from "../components/WidgetCard";
import { Kpi, KpiRow } from "../components/Kpi";
import { TableSkeleton, EmptyState, ErrorState } from "../components/states";
import { t, fundColor } from "../theme";
import { usd, count, periodLabel, dateLabel, utcStamp } from "../lib/format";
import { loadPeriodFilings, edgarUrl, type Manifest, type Filer, type FilingRow } from "../lib/data";
import { filingDeadline, recentPeriods } from "../../shared/calendar.mjs";

const GRID_WIDE: React.CSSProperties = {
  display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fill, minmax(480px, 1fr))",
};

/**
 * Whole days between two ISO dates, counted on the CALENDAR.
 *
 * Deliberately date-only. Deriving a lag from full timestamps makes a filing
 * accepted at 20:06 on day 45 round to 46, which pushed every punctual filer
 * past the 45-day deadline and painted the entire timeline amber. The deadline
 * is a date, so the comparison must be too.
 */
function lagDays(periodEnd: string, acceptedISO: string | null): number | null {
  if (!acceptedISO) return null;
  return Math.round(
    (Date.parse(`${acceptedISO.slice(0, 10)}T00:00:00Z`) - Date.parse(`${periodEnd}T00:00:00Z`)) / 86400000,
  );
}

type FormFilter = "All" | "13F-HR" | "Amendments";

function FormBadge({ row }: { row: FilingRow }) {
  const label = row.notice ? "13F-NT" : row.amendment ? `${row.form}` : row.form;
  const tone = row.notice
    ? { bg: "#f3f4f6", fg: t.textMuted, bd: "#e5e7eb" }
    : row.amendment
      ? { bg: t.warnBg, fg: "#92400e", bd: t.warnBorder }
      : { bg: t.primaryLight, fg: t.primaryText, bd: t.primaryBorder };
  return (
    <span
      title={row.amendment ? `Amendment ${row.amendmentNo ?? ""} — ${row.amendment}` : undefined}
      style={{
        fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 5,
        background: tone.bg, color: tone.fg, border: `1px solid ${tone.bd}`, whiteSpace: "nowrap",
      }}
    >
      {label}
      {row.amendment && row.amendmentNo ? ` ${row.amendmentNo}` : ""}
    </span>
  );
}

/** One dot per filing: how many days after the quarter end it arrived. */
function StatusDot({ row }: { row: FilingRow }) {
  const [color, title] =
    row.quarantined
      ? [t.errorRed, "Quarantined — the filing's rows do not sum to its own reported total"]
      : row.confidentialOmitted
        ? [t.warnAmber, "Confidential omissions — the reported value is a floor, not the full book"]
        : row.notice
          ? [t.textHint, "Notice filing — holdings are reported by another manager"]
          : row.reconciles === true
            ? ["#059669", "Reconciles exactly against the filing's own reported total"]
            : [t.textHint, "Not reconciled"];
  return <span title={title} style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block" }} />;
}

export function FilingsView({
  filers, period, mf, onFund,
}: {
  filers: Filer[];
  period: string;
  mf: Manifest;
  onFund: (cik: string) => void;
}) {
  const [rows, setRows] = useState<FilingRow[] | null>(null);
  const [timeline, setTimeline] = useState<{ cik: string; fund: string; lag: number; period: string; color: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FormFilter>("All");
  const [excludedAmendments, setExcludedAmendments] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);

    const colorOf = new Map(filers.map((f, i) => [f.cik, fundColor(i)]));

    (async () => {
      const current = await loadPeriodFilings(period, mf);
      if (cancelled) return;
      setRows(current);

      // Six quarters of arrival times, so "does this manager file early or on
      // the deadline?" becomes visible rather than folklore.
      const periods = recentPeriods(period, 6) as string[];
      const pts: typeof timeline = [];
      let lateAmendments = 0;
      await Promise.all(
        periods.map(async (p) => {
          try {
            const fs = await loadPeriodFilings(p, mf);
            for (const r of fs) {
              if (!r.accepted) continue;
              // ORIGINAL filings only. Amendments arrive arbitrarily late —
              // Cantillon restated three 2025 quarters on one day in Feb 2026,
              // landing 140, 230 and 323 days after those quarter ends. Mixing
              // those into "when does this manager file" stretches the axis to
              // 323 days and squashes the 30-60 day band where the real signal
              // lives. Lateness of amendments is its own question, answered by
              // the Amendments card.
              if (r.amendment) { lateAmendments++; continue; }
              const lag = lagDays(p, r.accepted);
              if (lag == null) continue;
              pts.push({ cik: r.cik, fund: r.fund, lag, period: p, color: colorOf.get(r.cik) ?? t.textMuted });
            }
          } catch { /* period not ingested */ }
        }),
      );
      if (!cancelled) { setTimeline(pts); setExcludedAmendments(lateAmendments); }
    })()
      .catch((e) => !cancelled && setErr(String(e.message ?? e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [period, mf, filers]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const r = filter === "13F-HR" ? rows.filter((x) => !x.amendment && !x.notice)
      : filter === "Amendments" ? rows.filter((x) => Boolean(x.amendment))
      : rows;
    return [...r].sort((a, b) => String(b.accepted).localeCompare(String(a.accepted)));
  }, [rows, filter]);

  const deadline = filingDeadline(period) as string;
  const filedCiks = new Set((rows ?? []).map((r) => r.cik));
  const outstanding = filers.filter((f) => !filedCiks.has(f.cik));
  const amendments = (rows ?? []).filter((r) => r.amendment);
  const notices = (rows ?? []).filter((r) => r.notice);
  const latest = (rows ?? []).reduce<string | null>((a, r) => (r.accepted && (!a || r.accepted > a) ? r.accepted : a), null);

  // Chart lanes: one per fund, so a dot's vertical position identifies the manager.
  const lanes = useMemo(() => filers.map((f, i) => ({ ...f, y: i + 1, color: fundColor(i) })), [filers]);
  const laneOf = useMemo(() => new Map(lanes.map((l) => [l.cik, l.y])), [lanes]);

  if (err) {
    return <div style={GRID_WIDE}><WidgetCard title="Filings" span={2}><ErrorState message={err} /></WidgetCard></div>;
  }

  return (
    <>
      {/* WhaleWisdom's callout box, compressed from a box into a line. */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
          background: t.primaryLight, border: `1px solid ${t.primaryBorder}`,
          borderRadius: 10, padding: "9px 14px", marginBottom: 20,
        }}
      >
        <span style={{ fontSize: 12.5, color: t.primaryText, fontWeight: 600 }}>
          {periodLabel(period)} filings due {dateLabel(deadline)}
        </span>
        <span style={{ fontSize: 12, color: t.textMuted }}>
          · {filedCiks.size} of {filers.length} tracked funds filed
        </span>
        <div style={{ flex: 1, minWidth: 80, height: 3, background: "#e0e7ff", borderRadius: 2, overflow: "hidden" }}>
          <div
            className="flow-bar"
            style={{
              height: "100%", width: "100%", background: t.primary,
              transform: `scaleX(${filers.length ? filedCiks.size / filers.length : 0})`,
            }}
          />
        </div>
      </div>

      <KpiRow>
        <Kpi label="Filed this period" value={loading ? "…" : `${filedCiks.size} of ${filers.length}`} scope={outstanding.length ? `${outstanding.length} outstanding` : "Complete"} />
        <Kpi label="Due date" value={dateLabel(deadline)} scope="45 days after quarter end" />
        <Kpi label="Most recent filing" value={latest ? dateLabel(latest.slice(0, 10)) : "—"} scope={latest ? utcStamp(latest) : undefined} />
        <Kpi label="Amendments" value={loading ? "…" : count(amendments.length)} scope={notices.length ? `${notices.length} notice filing${notices.length === 1 ? "" : "s"}` : "Restatements & additions"} />
      </KpiRow>

      <div style={{ ...GRID_WIDE, marginTop: 22 }}>
        {/* PRIMARY — the feed */}
        <WidgetCard
          title="Latest 13F filings"
          subtitle="Newest first, by the timestamp the SEC accepted the submission"
          span={2}
          bodyMinHeight={280}
          actions={<ViewToggle options={["All", "13F-HR", "Amendments"] as const} value={filter} onChange={setFilter} />}
        >
          {loading ? (
            <TableSkeleton rows={8} cols={6} />
          ) : filtered.length === 0 ? (
            <EmptyState icon="◷" message={`No ${filter === "All" ? "" : filter + " "}filings for ${periodLabel(period)}`} hint="Step back a quarter, or wait for the deadline." />
          ) : (
            <div style={{ maxHeight: 400, overflow: "auto" }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Filer</th><th>Form</th><th>Accepted (UTC)</th><th>Lag</th>
                    <th>Positions</th><th>Reported value</th><th>Accession</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const lag = lagDays(period, r.accepted);
                    return (
                      <tr key={r.accession}>
                        <td>
                          <button
                            className="pressable"
                            onClick={() => onFund(r.cik)}
                            style={{
                              border: "none", background: "transparent", cursor: "pointer", padding: 0,
                              fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: "inherit",
                              display: "inline-flex", alignItems: "center", gap: 6,
                            }}
                          >
                            <StatusDot row={r} />
                            {r.fund}
                          </button>
                        </td>
                        <td><FormBadge row={r} /></td>
                        <td>{r.accepted ? utcStamp(r.accepted) : "—"}</td>
                        <td>{lag != null ? `${lag}d` : "—"}</td>
                        <td>{r.notice ? "—" : count(r.positions)}</td>
                        <td>{r.value != null ? usd(r.value) : "—"}</td>
                        <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 10.5, color: t.textMuted }}>{r.accession}</td>
                        <td>
                          <a
                            href={edgarUrl(r.cik, r.accession)}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: t.primaryText, fontWeight: 600, textDecoration: "none", fontSize: 11 }}
                          >
                            EDGAR ↗
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </WidgetCard>

        {/* INSIGHT — arrival timing. A dot-lane, not a Gantt: the question is
            "how late", and one axis answers it. */}
        <WidgetCard
          title="Filing timeline"
          subtitle={
            `Days after quarter end, last 6 quarters — the line is the 45-day deadline` +
            (excludedAmendments ? ` · ${excludedAmendments} amendment${excludedAmendments === 1 ? "" : "s"} excluded` : "")
          }
          span={2}
          bodyMinHeight={240}
        >
          {loading ? (
            <TableSkeleton rows={6} cols={3} />
          ) : timeline.length === 0 ? (
            <EmptyState icon="◷" message="No filing timestamps yet" />
          ) : (
            <div style={{ padding: "14px 12px 4px", height: 260 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 6, right: 16, left: 4, bottom: 4 }}>
                  <CartesianGrid stroke={t.gridline} />
                  <XAxis
                    type="number" dataKey="lag" domain={[0, 60]} allowDataOverflow
                    tick={{ fontSize: 10, fill: t.textHint }} axisLine={false} tickLine={false}
                    label={{ value: "days after quarter end", position: "insideBottom", offset: -2, fontSize: 10, fill: t.textHint }}
                  />
                  <YAxis
                    type="number" dataKey="y" domain={[0, lanes.length + 1]}
                    ticks={lanes.map((l) => l.y)}
                    tickFormatter={(v) => lanes.find((l) => l.y === v)?.code ?? ""}
                    tick={{ fontSize: 10, fill: t.textHint }} axisLine={false} tickLine={false} width={40}
                  />
                  <ReferenceLine x={45} stroke={t.warnAmber} strokeDasharray="4 3" />
                  <Tooltip
                    contentStyle={{ background: "#fff", border: `1px solid ${t.borderSolid}`, borderRadius: 8, fontSize: 12 }}
                    formatter={(_v, _n, p) => [`${p.payload.lag} days`, `${p.payload.fund} · ${periodLabel(p.payload.period)}`]}
                  />
                  <Scatter
                    data={timeline.map((p) => ({ ...p, y: laneOf.get(p.cik) ?? 0 }))}
                    isAnimationActive={false}
                  >
                    {timeline.map((p, i) => (
                      // Amber past the deadline: 13F has no grace period, so a
                      // dot right of the line is a genuinely late filing.
                      <RCell key={i} fill={p.lag > 45 ? t.warnAmber : p.color} />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          )}
        </WidgetCard>

        {/* INSIGHT — who is missing. A dashboard that says what is MISSING
            cannot go silently stale, which is the worst failure mode here. */}
        <WidgetCard title="Outstanding" subtitle={`Tracked funds with no ${periodLabel(period)} filing`} bodyMinHeight={200}>
          {loading ? (
            <TableSkeleton rows={4} cols={2} />
          ) : outstanding.length === 0 ? (
            <EmptyState icon="✓" message="Every tracked fund has filed" hint={`All ${filers.length} managers reported for ${periodLabel(period)}.`} />
          ) : (
            <div style={{ maxHeight: 240, overflow: "auto" }}>
              <table className="data-table">
                <thead><tr><th>Fund</th><th>Last filed</th></tr></thead>
                <tbody>
                  {outstanding.map((f) => (
                    <tr key={f.cik}>
                      <td>
                        <button
                          className="pressable"
                          onClick={() => onFund(f.cik)}
                          style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: "inherit" }}
                        >
                          {f.name}
                        </button>
                      </td>
                      <td>{f.latestPeriod ? periodLabel(f.latestPeriod) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </WidgetCard>

        {/* INSIGHT — amendments. Worth its own card because a restatement
            rewrites history a client may already have screenshotted. */}
        <WidgetCard title="Amendments &amp; notices" subtitle="Restatements, added holdings, and notice filings" bodyMinHeight={200}>
          {loading ? (
            <TableSkeleton rows={4} cols={3} />
          ) : amendments.length + notices.length === 0 ? (
            <EmptyState icon="—" message="No amendments this period" hint="Restatements often arrive months later, so this can change." />
          ) : (
            <div style={{ maxHeight: 240, overflow: "auto" }}>
              <table className="data-table">
                <thead><tr><th>Fund</th><th>Type</th><th>Positions</th></tr></thead>
                <tbody>
                  {[...amendments, ...notices].map((r) => (
                    <tr key={r.accession}>
                      <td>{r.fund}</td>
                      <td><FormBadge row={r} /></td>
                      <td>{r.notice ? "—" : count(r.positions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </WidgetCard>

        {/* SOURCE */}
        <WidgetCard title="Sources &amp; provenance" subtitle="How this feed is built" span={2}>
          <div style={{ padding: "12px 16px", fontSize: 11.5, color: t.textSecondary, lineHeight: 1.65 }}>
            <p style={{ margin: "0 0 8px" }}>
              Filings are discovered through the SEC submissions API, which returns every accession
              for a manager regardless of who submitted it. That matters: amendments are frequently
              filed under a third-party filer agent's accession prefix, so scanning prefixes would
              miss them entirely.
            </p>
            <p style={{ margin: "0 0 8px" }}>
              Each filing is checked against its own reported total before it is trusted — a green
              dot means the information table sums exactly to the value the manager declared on the
              cover page. Filings that fail are kept but excluded from the holdings views.
            </p>
            <p style={{ margin: 0 }}>
              Positions are as of {dateLabel(period)}, filed up to 45 days later. There is no grace
              period, so a dot right of the dashed line in the timeline is genuinely late.
            </p>
            <div
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                borderTop: `1px solid ${t.border}`, paddingTop: 10, marginTop: 12, fontSize: 11, color: t.textHint,
              }}
            >
              <span>Data © SEC EDGAR (public domain) · build {mf.buildId}</span>
              <a href="https://www.sec.gov/edgar" target="_blank" rel="noopener noreferrer" style={{ color: t.primaryText, fontWeight: 600, textDecoration: "none" }}>
                sec.gov/edgar ↗
              </a>
            </div>
          </div>
        </WidgetCard>
      </div>
    </>
  );
}
