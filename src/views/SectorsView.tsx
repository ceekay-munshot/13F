// src/views/SectorsView.tsx
//
// Which focused managers bought or sold each sector this quarter, and who.
//
// Two panels and nothing else: sectors on the left, each opening on its
// subsectors (shared/subsectors.mjs), and on the right either the managers
// behind the selected row or the stocks they sold and bought most. "Focused"
// is the only setting, because it is the only one the question depends on.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { WidgetCard, ViewToggle } from "../components/WidgetCard";
import { EmptyState, ErrorState, TableSkeleton } from "../components/states";
import { t, ACTION_COLORS } from "../theme";
import { usd, periodLabel } from "../lib/format";
import { loadMovers, loadSectorMap, type Manifest, type Movers, type MoverMove } from "../lib/data";
import { SECTORS } from "../../shared/sic.mjs";
import { AI_THEME, inAiTheme } from "../../shared/themes.mjs";

/** One-click stock caps. Any other number from the smallest to the largest can be typed. */
const CAPS = ["20", "30", "40"] as const;
const PANES = ["Managers", "Stocks"] as const;
type Pane = (typeof PANES)[number];
type Side = "Sellers" | "Buyers";
type SectorSort = "sold" | "bought" | "net" | "sellers" | "buyers";
/** The managers list: by money traded, by share of the fund, or by fund size. */
type ManagerSort = "amount" | "weight" | "size";

export interface Manager {
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
  /** The row's name: a sector, the theme, or a subsector. */
  sector: string;
  /** A subsector's sector; null on a sector or the theme. */
  parent: string | null;
  bought: number;
  sold: number;
  net: number;
  sellers: number;
  buyers: number;
  managers: Manager[];
  /** The sector split by subsector — empty where a split would say nothing. */
  subs: SectorRow[];
}

type Fund = Movers["funds"][number];
type Groups = Map<string, Map<string, Manager>>;

/** One trade into one group's manager. */
function addTo(groups: Groups, group: string, fund: Fund, m: MoverMove) {
  const [cik, name, value, positions] = fund;
  let byFund = groups.get(group);
  if (!byFund) groups.set(group, (byFund = new Map()));
  let mgr = byFund.get(cik);
  if (!mgr) {
    mgr = { cik, name, value, positions, bought: 0, sold: 0, net: 0, weight: 0, moves: [] };
    byFund.set(cik, mgr);
  }
  if (m[3] > 0) mgr.bought += m[3];
  else mgr.sold -= m[3];
  mgr.net += m[3];
  mgr.weight += fundShare(m);
  mgr.moves.push(m);
}

function toRow(sector: string, parent: string | null, group: Map<string, Manager>): SectorRow {
  const managers = [...group.values()];
  for (const mgr of managers) mgr.moves.sort((a, b) => Math.abs(b[3]) - Math.abs(a[3]));
  return {
    sector,
    parent,
    managers,
    bought: managers.reduce((a, x) => a + x.bought, 0),
    sold: managers.reduce((a, x) => a + x.sold, 0),
    net: managers.reduce((a, x) => a + x.net, 0),
    sellers: managers.filter((x) => x.net < 0).length,
    buyers: managers.filter((x) => x.net > 0).length,
    subs: [],
  };
}

/**
 * Every focused manager's trades, grouped by sector and inside each sector by
 * subsector, for one stock cap.
 *
 * Plus one theme row, AI & semis, which a trade joins as well as its own
 * sector: the SEC's codes spread that trade over four sectors (see
 * shared/themes.mjs), so no sector row could answer "who cut AI and chips?".
 */
function bySector(movers: Movers, sectorMap: Record<string, string>, cap: number, sort: SectorSort): SectorRow[] {
  const sectors: Groups = new Map();
  const subsectors = new Map<string, Groups>();
  for (const fund of movers.funds) {
    if (fund[3] > cap) continue;
    for (const m of fund[4]) {
      // Placed by the pipeline, which had the filed name and share class to go
      // on; the ticker alone is the fallback for a file built before that.
      const sector = (m[6] != null && SECTORS[m[6]]) || sectorMap[m[0].toUpperCase()] || "Unclassified";
      addTo(sectors, sector, fund, m);
      if (inAiTheme(m[0], sector)) addTo(sectors, AI_THEME, fund, m);
      // The file names its own subsectors, so its numbers always read right.
      const sub = m[7] != null ? movers.subsectors?.[m[7]] : undefined;
      if (sub) {
        let groups = subsectors.get(sector);
        if (!groups) subsectors.set(sector, (groups = new Map()));
        addTo(groups, sub, fund, m);
      }
    }
  }
  return [...sectors.entries()].map(([sector, group]) => {
    const row = toRow(sector, null, group);
    const subs = [...(subsectors.get(sector) ?? [])].map(([sub, g]) => toRow(sub, sector, g));
    // A sector whose trades all sit in one subsector has nothing to open.
    if (subs.length > 1) row.subs = subs.sort(SORTERS[sort]);
    return row;
  });
}

export interface StockRow {
  ticker: string;
  sold: number;
  bought: number;
  /** bought − sold: which way the money went. */
  net: number;
  /** Managers whose trades in the stock add up to a sale, and to a purchase. */
  sellers: number;
  buyers: number;
}

/**
 * The same trades added up by stock: how much the sector's focused managers
 * sold and bought of each, and how many of them were on each side. Every
 * focused manager in the sector, not a watchlist, which is the one thing
 * Consensus cannot show.
 *
 * A manager is a seller or a buyer of a stock by what their trades in it add
 * up to, so one with two share classes of it is counted once, on one side.
 */
export function byStock(managers: Manager[]): StockRow[] {
  const stocks = new Map<string, { row: StockRow; byFund: Map<string, number> }>();
  for (const mgr of managers) {
    for (const m of mgr.moves) {
      let s = stocks.get(m[0]);
      if (!s) {
        s = { row: { ticker: m[0], sold: 0, bought: 0, net: 0, sellers: 0, buyers: 0 }, byFund: new Map() };
        stocks.set(m[0], s);
      }
      if (m[3] > 0) s.row.bought += m[3];
      else s.row.sold -= m[3];
      s.row.net += m[3];
      s.byFund.set(mgr.cik, (s.byFund.get(mgr.cik) ?? 0) + m[3]);
    }
  }
  return [...stocks.values()].map(({ row, byFund }) => {
    for (const v of byFund.values()) {
      if (v < 0) row.sellers++;
      else if (v > 0) row.buyers++;
    }
    return row;
  });
}

/**
 * Either list of the Stocks view, by money (the default) or by how one-sided
 * the managers were: most more sellers than buyers first in the sold list, the
 * reverse in the bought one. Money breaks a tie.
 */
export type StockSort = "net" | "agree";
export function sortStocks(rows: StockRow[], side: Side, by: StockSort): StockRow[] {
  const sign = side === "Sellers" ? 1 : -1;
  const lean = (s: StockRow) => sign * (s.sellers - s.buyers);
  return rows.sort((a, b) =>
    (by === "agree" ? lean(b) - lean(a) : 0) || sign * (a.net - b.net));
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
const STOCK_PAGE = 25;
/** A file built before company names were added: tickers alone. */
const NO_NAMES: Record<string, string> = {};

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
  const [cap, setCap] = useState(40);
  const [sort, setSort] = useState<SectorSort>("net");
  /** The selected row: a sector (or the theme), and a subsector of it if one is picked. */
  const [picked, setPicked] = useState<{ sector: string; sub: string | null } | null>(null);
  /** The sector whose subsectors are showing. */
  const [open, setOpen] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("Managers");
  const [side, setSide] = useState<Side>("Sellers");
  const [mgrSort, setMgrSort] = useState<ManagerSort>("amount");
  const [stockSort, setStockSort] = useState<StockSort>("net");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [stockShown, setStockShown] = useState(STOCK_PAGE);

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

  // The theme row stays first whatever the sort, and is what the tab opens on:
  // "who cut AI and chips?" is the question it was built for.
  const rows = useMemo(() => {
    if (!movers || !sectorMap) return [];
    const all = bySector(movers, sectorMap, cap, sort);
    const theme = all.filter((r) => r.sector === AI_THEME);
    return [...theme, ...all.filter((r) => r.sector !== AI_THEME).sort(SORTERS[sort])];
  }, [movers, sectorMap, cap, sort]);
  // A subsector that has no trades at a smaller cap falls back to its sector,
  // not to the top of the list.
  const pickedSector = rows.find((r) => r.sector === picked?.sector) ?? null;
  const current = (picked?.sub && pickedSector?.subs.find((s) => s.sector === picked.sub)) || pickedSector || rows[0] || null;
  const openRow = rows.find((r) => r.sector === open && r.subs.length) ?? null;
  const peak = Math.max(1, ...rows.map((r) => Math.abs(r.net)));

  // A sector opens on its subsectors when picked, and closes when picked again.
  // Picking a sector while one of its subsectors is selected goes back up to
  // the sector and leaves it open.
  //
  // Moving to another row empties the filter box: a ticker typed for one sector
  // (MSFT under Software) matches nothing in the next, and the right side would
  // go blank with "No manager matches that". Clicking the row already selected
  // (to close it) keeps the filter.
  const pickSector = (r: SectorRow) => {
    if (r !== current) setQuery("");
    setPicked({ sector: r.sector, sub: null });
    setOpen(current === r && openRow === r ? null : r.subs.length ? r.sector : null);
  };
  const pickSub = (s: SectorRow) => {
    if (s !== current) setQuery("");
    setPicked({ sector: s.parent ?? s.sector, sub: s.sector });
  };

  // Back to the top of the list whenever the list itself changes.
  useEffect(() => { setShown(PAGE); }, [current?.sector, side, query, cap, mgrSort]);
  useEffect(() => { setStockShown(STOCK_PAGE); }, [current?.sector, query, cap, stockSort]);

  // What the filter box matches, for both lists. A ticker the sector actually
  // has is matched exactly — clicking MU must not bring in MUFG — and anything
  // else by how it starts, so "NV" finds NVDA and NVMI.
  const tickerHit = useMemo(() => {
    const q = query.trim().toUpperCase();
    const exact = q.length < 2 || !!current?.managers.some((m) => m.moves.some((x) => x[0].toUpperCase() === q));
    return (tk: string) => (exact ? tk.toUpperCase() === q : tk.toUpperCase().startsWith(q));
  }, [current, query]);

  // A TICKER IN THE FILTER NARROWS THE NUMBERS, NOT JUST THE LIST.
  //
  // "Who sold NVDA?" means sellers OF NVDA, at what they sold of it — not every
  // net seller of chips who happens to hold it, at their whole chip total. A
  // manager matched by name keeps their full sector picture.
  const managers = useMemo(() => {
    if (!current) return [];
    const q = query.trim().toUpperCase();
    const sellers = side === "Sellers";
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
    // Fund size is the value of the shares the manager reports to the SEC, the
    // figure under each name; largest first, and by money traded among equals.
    const byAmount = (a: Manager, b: Manager) => (sellers ? a.net - b.net : b.net - a.net);
    return rows.sort((a, b) =>
      mgrSort === "size" ? b.value - a.value || byAmount(a, b)
        : mgrSort === "weight" ? (sellers ? a.weight - b.weight : b.weight - a.weight)
        : byAmount(a, b),
    );
  }, [current, side, query, mgrSort, tickerHit]);

  // Each stock once, in the list its net puts it in, with how many managers
  // were on each side. Both lists at once, never one behind a toggle. A stock
  // sold by some focused managers and bought by others shows as a split bar
  // on its own row, not as the same name in two lists.
  const names = movers?.names ?? NO_NAMES;
  const stocks = useMemo(() => {
    if (!current) return { sold: [], bought: [], peak: 1 };
    const q = query.trim().toUpperCase();
    const all = byStock(current.managers).filter((s) =>
      !q || tickerHit(s.ticker) || (q.length >= 3 && (names[s.ticker] ?? "").toUpperCase().includes(q)));
    return {
      sold: sortStocks(all.filter((s) => s.net < 0), "Sellers", stockSort),
      bought: sortStocks(all.filter((s) => s.net > 0), "Buyers", stockSort),
      // One scale for both lists, so a bar on the left and one on the right
      // can be compared.
      peak: Math.max(1, ...all.map((s) => Math.abs(s.net))),
    };
  }, [current, query, tickerHit, names, stockSort]);

  // A stock in either list opens the managers who sold (or bought) it.
  const pickStock = (ticker: string, s: Side) => {
    setQuery(ticker);
    setSide(s);
    setPane("Managers");
  };

  const loading = movers === undefined && !err;
  const minCap = movers?.minPositions ?? 5;
  const maxCap = movers?.maxPositions ?? 40;
  const cutLabel = cap > minCap ? `${minCap}–${cap} stocks` : `${minCap} stocks`;

  const capToggle = <CapPicker value={cap} min={minCap} max={maxCap} onChange={setCap} />;

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
                {rows.flatMap((r) => {
                  const theme = r.sector === AI_THEME;
                  const isOpen = openRow === r;
                  const out = [
                    <SectorTr
                      key={r.sector}
                      row={r}
                      on={r === current}
                      peak={peak}
                      className={theme ? "sector-row theme-row" : "sector-row"}
                      expanded={r.subs.length ? isOpen : undefined}
                      onPick={() => pickSector(r)}
                      note={theme ? "Chips, chip tools, memory, AI infra" : undefined}
                    />,
                  ];
                  if (isOpen) {
                    r.subs.forEach((s, i) => out.push(
                      <SectorTr
                        key={`${r.sector}/${s.sector}`}
                        row={s}
                        on={s === current}
                        peak={peak}
                        className="sector-row sub-row"
                        onPick={() => pickSub(s)}
                        // A short cascade as the subsectors arrive, never long
                        // enough to wait on.
                        delay={Math.min(i, 8) * 18}
                      />,
                    ));
                  }
                  return out;
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
            ? (current.parent ? `${current.parent} · ` : "")
              + (pane === "Stocks"
                ? `${stocks.sold.length} net sold · ${stocks.bought.length} net bought`
                : `${managers.length} ${side === "Sellers" ? "sellers" : "buyers"}`)
              + (query.trim() ? ` · “${query.trim()}”` : "")
            : undefined
        }
        actions={<ViewToggle options={PANES} value={pane} onChange={setPane} />}
        toolbar={
          <>
            <input
              className="sectors-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={pane === "Stocks" ? "Filter by ticker or company…" : "Filter by ticker or manager…"}
              aria-label={pane === "Stocks" ? "Filter by ticker or company" : "Filter by ticker or manager"}
            />
            {pane === "Managers" && (
              <span style={{ marginLeft: "auto" }}>
                <ViewToggle options={["Sellers", "Buyers"] as const} value={side} onChange={setSide} />
              </span>
            )}
          </>
        }
        refreshing={refreshing}
        bodyMinHeight={420}
      >
        {loading ? (
          <TableSkeleton rows={10} cols={pane === "Stocks" ? 6 : 4} />
        ) : pane === "Stocks" ? (
          !stocks.sold.length && !stocks.bought.length ? (
            <EmptyState icon="◫" message={query ? "No stock matches that" : "No trades here"} />
          ) : (
            <div className="sectors-scroll">
              <div className="split-2">
                <StockList
                  label="Net sold" side="Sellers" rows={stocks.sold} peak={stocks.peak}
                  shown={stockShown} names={names} sort={stockSort} onSort={setStockSort} onPick={pickStock}
                />
                <div className="split-rule" style={{ background: t.border }} />
                <StockList
                  label="Net bought" side="Buyers" rows={stocks.bought} peak={stocks.peak}
                  shown={stockShown} names={names} sort={stockSort} onSort={setStockSort} onPick={pickStock}
                />
              </div>
              {Math.max(stocks.sold.length, stocks.bought.length) > stockShown && (
                <div style={{ padding: 12, textAlign: "center" }}>
                  <button className="pressable show-more" onClick={() => setStockShown((n) => n + STOCK_PAGE * 2)}>
                    Show more
                  </button>
                </div>
              )}
            </div>
          )
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
                  <th aria-sort={mgrSort === "size" ? "descending" : undefined}>
                    <button
                      className="th-sort"
                      data-active={mgrSort === "size"}
                      onClick={() => setMgrSort("size")}
                      title="Largest fund first"
                    >
                      Manager
                    </button>
                  </th>
                  <th aria-sort={mgrSort === "amount" ? "descending" : undefined}>
                    <button className="th-sort" data-active={mgrSort === "amount"} onClick={() => setMgrSort("amount")}>
                      {side === "Sellers" ? "Sold" : "Bought"}
                    </button>
                  </th>
                  <th aria-sort={mgrSort === "weight" ? "descending" : undefined}>
                    <button className="th-sort" data-active={mgrSort === "weight"} onClick={() => setMgrSort("weight")}>
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

/**
 * One row of the sector table: a sector, the theme, or (indented, under its
 * open sector) a subsector. The same columns for all three.
 */
function SectorTr({
  row: r, on, peak, className, expanded, onPick, note, delay,
}: {
  row: SectorRow;
  on: boolean;
  peak: number;
  className: string;
  /** Set on a sector that has subsectors: whether they are showing. */
  expanded?: boolean;
  onPick: () => void;
  note?: string;
  delay?: number;
}) {
  const style = delay ? ({ "--row-delay": `${delay}ms` } as CSSProperties) : undefined;
  return (
    // The whole row is the target for a pointer; the button in the first cell
    // is the same action for a keyboard or a screen reader, which a clickable
    // <tr> is invisible to.
    <tr className={className} data-active={on} onClick={onPick} style={style}>
      <td style={{ maxWidth: 220 }}>
        <span className="sector-label">
          {!r.parent && <span className="sector-caret" data-open={expanded} aria-hidden="true" />}
          <button
            className="sector-pick"
            aria-pressed={on}
            aria-expanded={expanded}
            onClick={(e) => { e.stopPropagation(); onPick(); }}
          >
            {r.sector}
          </button>
        </span>
        {note && <span className="theme-note">{note}</span>}
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
      <td className="net-cell" style={{ color: r.net > 0 ? "#059669" : r.net < 0 ? "#dc2626" : t.textMuted }}>
        {r.net > 0 ? "+" : ""}{usd(r.net)}
      </td>
      <td>{r.sellers}</td>
      <td>{r.buyers}</td>
    </tr>
  );
}

const CHIP: Record<MoverMove[1], { color: string; text: (m: MoverMove) => string }> = {
  X: { color: ACTION_COLORS.EXITED, text: () => "sold out" },
  T: { color: ACTION_COLORS.TRIMMED, text: (m) => (m[2] == null ? "cut" : `−${Math.abs(Math.round(m[2]))}%`) },
  N: { color: ACTION_COLORS.NEW, text: () => "new" },
  A: { color: ACTION_COLORS.ADDED, text: (m) => (m[2] == null ? "added" : `+${Math.round(m[2])}%`) },
};

/**
 * One half of the Stocks view: the stocks focused managers net sold (or net
 * bought), each with its net and how many managers sold it against how many
 * bought it. A row opens the managers on its side.
 */
function StockList({
  label, side, rows, peak, shown, names, sort, onSort, onPick,
}: {
  label: string;
  side: Side;
  rows: StockRow[];
  /** The largest net in either list: the full length of a bar. */
  peak: number;
  shown: number;
  names: Record<string, string>;
  sort: StockSort;
  onSort: (s: StockSort) => void;
  onPick: (ticker: string, side: Side) => void;
}) {
  const sold = side === "Sellers";
  const color = sold ? ACTION_COLORS.TRIMMED : ACTION_COLORS.ADDED;
  const head = (key: StockSort, text: string, title?: string) => (
    <th aria-sort={sort === key ? "descending" : undefined}>
      <button className="th-sort" data-active={sort === key} onClick={() => onSort(key)} title={title}>
        {text}
      </button>
    </th>
  );
  return (
    <div className="stock-half">
      <div className="stock-list-label" style={{ color }}>
        {label} <span style={{ color: t.textHint, fontWeight: 600 }}>{rows.length}</span>
      </div>
      {!rows.length ? (
        <div style={{ padding: "8px 14px 14px", fontSize: 12, color: t.textHint }}>
          Nothing {sold ? "net sold" : "net bought"}
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Stock</th>
              {head("net", "Net")}
              {head("agree", "Managers", `How many sold it (amber) against how many bought it (green). Click: most ${sold ? "sellers over buyers" : "buyers over sellers"} first`)}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((s) => {
              const name = names[s.ticker];
              const pick = () => onPick(s.ticker, side);
              const traders = s.sellers + s.buyers;
              return (
                // As with the sector rows: the row for a pointer, the button for
                // a keyboard or a screen reader.
                <tr key={s.ticker} className="sector-row" onClick={pick}>
                  <td className="stock-cell">
                    <button
                      className="sector-pick stock-pick"
                      onClick={(e) => { e.stopPropagation(); pick(); }}
                      title={`${name ? `${s.ticker} · ${name}` : s.ticker} — see who ${sold ? "sold" : "bought"} it`}
                    >
                      <b>{s.ticker}</b>
                      {name && <span className="stock-name">{name}</span>}
                    </button>
                    <span
                      className="net-bar"
                      style={{ transform: `scaleX(${Math.max(0.02, Math.abs(s.net) / peak)})`, background: color }}
                    />
                  </td>
                  <td
                    className="net-cell"
                    style={{ color: sold ? "#dc2626" : "#059669" }}
                    title={`Sold ${usd(s.sold)} · bought ${usd(s.bought)}`}
                  >
                    {sold ? "" : "+"}{usd(s.net)}
                  </td>
                  <td>
                    <span
                      className="lean"
                      aria-label={`${s.sellers} sold, ${s.buyers} bought`}
                      title={`${s.sellers} managers sold, ${s.buyers} bought`}
                    >
                      <span className="lean-n lean-sold" data-lead={s.sellers > s.buyers}>{s.sellers}</span>
                      <span className="lean-track" aria-hidden="true">
                        <span
                          className="lean-fill"
                          style={{ transform: `scaleX(${traders ? s.sellers / traders : 0})` }}
                        />
                      </span>
                      <span className="lean-n lean-bought" data-lead={s.buyers > s.sellers}>{s.buyers}</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * "Up to [20] [30] [40] [Other] stocks". The last segment is a box for any
 * other cap. The tab follows it as you type, once the number is one the data
 * covers, and it is highlighted like a selected button while it is in use.
 */
function CapPicker({ value, min, max, onChange }: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  const preset = CAPS.find((c) => Number(c) === value) ?? null;
  const [text, setText] = useState(preset ? "" : String(value));
  const apply = (n: number) => {
    const v = Math.min(max, Math.max(min, n));
    onChange(v);
    return v;
  };
  // Leaving the box settles it: a number out of range is brought into range,
  // 20, 30 or 40 lights its own button instead, and an empty box keeps the cap.
  const settle = () => {
    const n = parseInt(text, 10);
    if (!Number.isFinite(n)) { setText(preset ? "" : String(value)); return; }
    const v = apply(n);
    setText(CAPS.some((c) => Number(c) === v) ? "" : String(v));
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: t.textMuted }}>
      Up to
      <ViewToggle
        options={CAPS}
        value={preset}
        onChange={(c) => { setText(""); onChange(Number(c)); }}
        trailing={
          <input
            className="cap-input"
            data-active={!preset}
            inputMode="numeric"
            maxLength={2}
            value={text}
            placeholder="Other"
            aria-label={`Up to how many stocks, ${min} to ${max}`}
            title={`Type any number from ${min} to ${max}`}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 2);
              setText(digits);
              const n = parseInt(digits, 10);
              if (n >= min && n <= max) onChange(n);
            }}
            onBlur={settle}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                e.preventDefault();
                setText(String(apply(value + (e.key === "ArrowUp" ? 1 : -1))));
              }
            }}
          />
        }
      />
      stocks
    </span>
  );
}

function MoveChip({ move }: { move: MoverMove }) {
  const c = CHIP[move[1]];
  return (
    <span className="move-chip" style={{ color: c.color }} title={usd(move[3])}>
      <b>{move[0]}</b> {c.text(move)}
    </span>
  );
}
