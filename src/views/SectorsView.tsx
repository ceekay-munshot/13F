// src/views/SectorsView.tsx
//
// Which focused managers bought or sold each sector this quarter, and who.
//
// Two panels and nothing else: sectors on the left, the managers behind the
// selected one on the right. "Focused" is the only setting, because it is the
// only one the question depends on.

import { useEffect, useMemo, useState } from "react";
import { WidgetCard, ViewToggle } from "../components/WidgetCard";
import { EmptyState, ErrorState, TableSkeleton } from "../components/states";
import { t, ACTION_COLORS } from "../theme";
import { usd, periodLabel } from "../lib/format";
import { loadMovers, loadSectorMap, type Manifest, type Movers, type MoverMove } from "../lib/data";

const CAPS = ["20", "30", "40"] as const;
type Cap = (typeof CAPS)[number];
type Side = "Sellers" | "Buyers";
type SectorSort = "sold" | "bought" | "net" | "sellers" | "buyers";

interface Manager {
  cik: string;
  name: string;
  value: number;
  positions: number;
  bought: number;
  sold: number;
  net: number;
  /**
   * Share of the fund bought (+) or sold (−) in this sector, at last quarter's
   * weights: selling half of a 10% position is 5%. Measured on shares, so a
   * price move on its own counts as nothing.
   */
  weight: number;
  moves: MoverMove[];
}

interface SectorRow {
  sector: string;
  bought: number;
  sold: number;
  net: number;
  sellers: number;
  buyers: number;
  managers: Manager[];
}

/** Every focused manager's trades, grouped by sector, for one stock cap. */
function bySector(movers: Movers, sectorMap: Record<string, string>, cap: number): SectorRow[] {
  const sectors = new Map<string, Map<string, Manager>>();
  for (const [cik, name, value, positions, moves] of movers.funds) {
    if (positions > cap) continue;
    for (const m of moves) {
      const sector = sectorMap[m[0].toUpperCase()] ?? "Unclassified";
      let group = sectors.get(sector);
      if (!group) sectors.set(sector, (group = new Map()));
      let mgr = group.get(cik);
      if (!mgr) {
        mgr = { cik, name, value, positions, bought: 0, sold: 0, net: 0, weight: 0, moves: [] };
        group.set(cik, mgr);
      }
      if (m[3] > 0) mgr.bought += m[3];
      else mgr.sold -= m[3];
      mgr.net += m[3];
      mgr.weight += fundShare(m);
      mgr.moves.push(m);
    }
  }
  return [...sectors.entries()].map(([sector, group]) => {
    const managers = [...group.values()];
    for (const mgr of managers) mgr.moves.sort((a, b) => Math.abs(b[3]) - Math.abs(a[3]));
    return {
      sector,
      managers,
      bought: managers.reduce((a, x) => a + x.bought, 0),
      sold: managers.reduce((a, x) => a + x.sold, 0),
      net: managers.reduce((a, x) => a + x.net, 0),
      sellers: managers.filter((x) => x.net < 0).length,
      buyers: managers.filter((x) => x.net > 0).length,
    };
  });
}

/** One trade as a share of the fund — see Manager.weight. */
function fundShare([, code, pct, , before, after]: MoverMove): number {
  if (code === "N") return after;
  if (before == null) return 0;
  if (code === "X") return -before;
  if (pct == null) return 0;
  return code === "T" ? -before * Math.min(1, -pct / 100) : before * (pct / 100);
}

const SORTERS: Record<SectorSort, (a: SectorRow, b: SectorRow) => number> = {
  sold: (a, b) => b.sold - a.sold,
  bought: (a, b) => b.bought - a.bought,
  // Most net selling first: the question this tab was built for.
  net: (a, b) => a.net - b.net,
  sellers: (a, b) => b.sellers - a.sellers,
  buyers: (a, b) => b.buyers - a.buyers,
};

const PAGE = 60;

export function SectorsView({
  period, mf, refreshing, onFund,
}: {
  period: string;
  mf: Manifest;
  refreshing?: boolean;
  onFund: (cik: string) => void;
}) {
  const [movers, setMovers] = useState<Movers | null | undefined>(undefined);
  const [sectorMap, setSectorMap] = useState<Record<string, string> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cap, setCap] = useState<Cap>("40");
  const [sort, setSort] = useState<SectorSort>("net");
  const [picked, setPicked] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("Sellers");
  const [byWeight, setByWeight] = useState(false);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    let cancelled = false;
    setMovers(undefined);
    setErr(null);
    Promise.all([loadMovers(period), loadSectorMap(mf)])
      .then(([m, s]) => {
        if (cancelled) return;
        setMovers(m);
        setSectorMap(s);
      })
      .catch((e) => !cancelled && setErr(String(e?.message ?? e)));
    return () => { cancelled = true; };
  }, [period, mf]);

  const rows = useMemo(
    () => (movers && sectorMap ? bySector(movers, sectorMap, Number(cap)).sort(SORTERS[sort]) : []),
    [movers, sectorMap, cap, sort],
  );
  const current = rows.find((r) => r.sector === picked) ?? rows[0] ?? null;
  const peak = Math.max(1, ...rows.map((r) => Math.abs(r.net)));

  // Back to the top of the list whenever the list itself changes.
  useEffect(() => { setShown(PAGE); }, [current?.sector, side, query, cap, byWeight]);

  // A TICKER IN THE FILTER NARROWS THE NUMBERS, NOT JUST THE LIST.
  //
  // "Who sold NVDA?" means sellers OF NVDA, at what they sold of it — not every
  // net seller of chips who happens to hold it, at their whole chip total. A
  // manager matched by name keeps their full sector picture.
  const managers = useMemo(() => {
    if (!current) return [];
    const q = query.trim().toUpperCase();
    const sellers = side === "Sellers";
    const tickerHit = (tk: string) => (q.length < 2 ? tk.toUpperCase() === q : tk.toUpperCase().startsWith(q));
    const rows: Manager[] = [];
    for (const m of current.managers) {
      let row = m;
      if (q && !(q.length >= 3 && m.name.toUpperCase().includes(q))) {
        const moves = m.moves.filter((x) => tickerHit(x[0]));
        if (!moves.length) continue;
        row = {
          ...m, moves,
          net: moves.reduce((a, x) => a + x[3], 0),
          weight: moves.reduce((a, x) => a + fundShare(x), 0),
        };
      }
      if (sellers ? row.net < 0 : row.net > 0) rows.push(row);
    }
    return rows.sort((a, b) =>
      byWeight
        ? (sellers ? a.weight - b.weight : b.weight - a.weight)
        : (sellers ? a.net - b.net : b.net - a.net),
    );
  }, [current, side, query, byWeight]);

  const loading = movers === undefined && !err;
  const cutLabel = `${movers?.minPositions ?? 5}–${cap} stocks`;

  const capToggle = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: t.textMuted }}>
      Up to
      <ViewToggle options={CAPS} value={cap} onChange={setCap} />
      stocks
    </span>
  );

  if (err) {
    return (
      <div className="card-grid" style={{ marginTop: 22 }}>
        <WidgetCard title="Sectors" span={2}><ErrorState message={err} /></WidgetCard>
      </div>
    );
  }

  if (movers === null) {
    return (
      <div className="card-grid" style={{ marginTop: 22 }}>
        <WidgetCard title="Sectors" span={2} bodyMinHeight={260}>
          <EmptyState
            icon="◫"
            message={`No sector data for ${periodLabel(period)}`}
            hint="This tab covers the two latest quarters and refreshes after every update."
          />
        </WidgetCard>
      </div>
    );
  }

  const head = (key: SectorSort, label: string) => (
    <th aria-sort={sort === key ? "descending" : undefined}>
      <button className="th-sort" data-active={sort === key} onClick={() => setSort(key)}>
        {label}
      </button>
    </th>
  );

  return (
    <div className="card-grid" style={{ marginTop: 22 }}>
      <WidgetCard
        title="Sectors"
        subtitle={`Managers with ${cutLabel} · ${periodLabel(period)}`}
        actions={capToggle}
        refreshing={refreshing}
        bodyMinHeight={420}
      >
        {loading ? (
          <TableSkeleton rows={10} cols={6} />
        ) : (
          <div className="sectors-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Sector</th>
                  {head("sold", "Sold")}
                  {head("bought", "Bought")}
                  {head("net", "Net")}
                  {head("sellers", "Sellers")}
                  {head("buyers", "Buyers")}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const on = r.sector === current?.sector;
                  return (
                    // The whole row is the target for a pointer; the button in the
                    // first cell is the same action for a keyboard or a screen
                    // reader, which a clickable <tr> is invisible to.
                    <tr key={r.sector} className="sector-row" data-active={on} onClick={() => setPicked(r.sector)}>
                      <td style={{ maxWidth: 220 }}>
                        <button className="sector-pick" aria-pressed={on} onClick={() => setPicked(r.sector)}>
                          {r.sector}
                        </button>
                        <span
                          className="net-bar"
                          style={{
                            transform: `scaleX(${Math.max(0.02, Math.abs(r.net) / peak)})`,
                            background: r.net >= 0 ? ACTION_COLORS.ADDED : ACTION_COLORS.TRIMMED,
                          }}
                        />
                      </td>
                      <td>{usd(r.sold)}</td>
                      <td>{usd(r.bought)}</td>
                      <td style={{ fontWeight: 700, color: r.net > 0 ? "#059669" : r.net < 0 ? "#dc2626" : t.textMuted }}>
                        {r.net > 0 ? "+" : ""}{usd(r.net)}
                      </td>
                      <td>{r.sellers}</td>
                      <td>{r.buyers}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </WidgetCard>

      <WidgetCard
        title={current ? current.sector : "Managers"}
        subtitle={
          current
            ? `${managers.length} ${side === "Sellers" ? "sellers" : "buyers"}${query.trim() ? ` · “${query.trim()}”` : ""}`
            : undefined
        }
        actions={
          <ViewToggle options={["Sellers", "Buyers"] as const} value={side} onChange={setSide} />
        }
        toolbar={
          <input
            className="sectors-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by ticker or manager…"
            aria-label="Filter by ticker or manager"
          />
        }
        refreshing={refreshing}
        bodyMinHeight={420}
      >
        {loading ? (
          <TableSkeleton rows={10} cols={4} />
        ) : !managers.length ? (
          <EmptyState
            icon="◫"
            message={query ? "No manager matches that" : `No ${side === "Sellers" ? "sellers" : "buyers"} here`}
          />
        ) : (
          <div className="sectors-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Manager</th>
                  <th aria-sort={!byWeight ? "descending" : undefined}>
                    <button className="th-sort" data-active={!byWeight} onClick={() => setByWeight(false)}>
                      {side === "Sellers" ? "Sold" : "Bought"}
                    </button>
                  </th>
                  <th aria-sort={byWeight ? "descending" : undefined}>
                    <button className="th-sort" data-active={byWeight} onClick={() => setByWeight(true)}>
                      % of fund
                    </button>
                  </th>
                  <th style={{ textAlign: "left" }}>Trades</th>
                </tr>
              </thead>
              <tbody>
                {managers.slice(0, shown).map((m) => (
                  <tr key={m.cik}>
                    <td style={{ maxWidth: 210 }}>
                      <button className="fund-link" onClick={() => onFund(m.cik)}>
                        {m.name}
                      </button>
                      <div style={{ fontSize: 11, color: t.textHint, marginTop: 1 }}>
                        {m.positions} stocks · {usd(m.value)}
                      </div>
                    </td>
                    <td style={{ fontWeight: 700 }}>{usd(Math.abs(m.net))}</td>
                    <td style={{ color: t.textMuted }}>
                      {Math.abs(m.weight) >= 0.05 ? `${Math.abs(m.weight).toFixed(1)}%` : "—"}
                    </td>
                    <td style={{ textAlign: "left" }}>
                      <div className="move-chips">
                        {m.moves.map((x, i) => <MoveChip key={i} move={x} />)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {managers.length > shown && (
              <div style={{ padding: 12, textAlign: "center" }}>
                <button className="pressable show-more" onClick={() => setShown((n) => n + PAGE * 2)}>
                  Show more ({managers.length - shown} left)
                </button>
              </div>
            )}
          </div>
        )}
      </WidgetCard>
    </div>
  );
}

const CHIP: Record<MoverMove[1], { color: string; text: (m: MoverMove) => string }> = {
  X: { color: ACTION_COLORS.EXITED, text: () => "sold out" },
  T: { color: ACTION_COLORS.TRIMMED, text: (m) => (m[2] == null ? "cut" : `−${Math.abs(Math.round(m[2]))}%`) },
  N: { color: ACTION_COLORS.NEW, text: () => "new" },
  A: { color: ACTION_COLORS.ADDED, text: (m) => (m[2] == null ? "added" : `+${Math.round(m[2])}%`) },
};

function MoveChip({ move }: { move: MoverMove }) {
  const c = CHIP[move[1]];
  return (
    <span className="move-chip" style={{ color: c.color }} title={usd(move[3])}>
      <b>{move[0]}</b> {c.text(move)}
    </span>
  );
}
