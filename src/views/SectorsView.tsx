// src/views/SectorsView.tsx
//
// Which focused managers bought or sold each sector this quarter, and who.
//
// Two panels and nothing else: sectors on the left, and on the right either the
// managers behind the selected one or the stocks they sold and bought most.
// "Focused" is the only setting, because it is the only one the question
// depends on.

import { useEffect, useMemo, useState } from "react";
import { WidgetCard, ViewToggle } from "../components/WidgetCard";
import { EmptyState, ErrorState, TableSkeleton } from "../components/states";
import { t, ACTION_COLORS } from "../theme";
import { usd, periodLabel } from "../lib/format";
import { loadMovers, loadSectorMap, type Manifest, type Movers, type MoverMove } from "../lib/data";
import { SECTORS } from "../../shared/sic.mjs";
import { AI_THEME, inAiTheme } from "../../shared/themes.mjs";

const CAPS = ["20", "30", "40"] as const;
type Cap = (typeof CAPS)[number];
const PANES = ["Managers", "Stocks"] as const;
type Pane = (typeof PANES)[number];
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

/**
 * Every focused manager's trades, grouped by sector, for one stock cap.
 *
 * Plus one theme row, AI & semis, which a trade joins as well as its own
 * sector: the SEC's codes spread that trade over four sectors (see
 * shared/themes.mjs), so no sector row could answer "who cut AI and chips?".
 */
function bySector(movers: Movers, sectorMap: Record<string, string>, cap: number): SectorRow[] {
  const sectors = new Map<string, Map<string, Manager>>();
  const add = (group: string, fund: Movers["funds"][number], m: MoverMove) => {
    const [cik, name, value, positions] = fund;
    let byFund = sectors.get(group);
    if (!byFund) sectors.set(group, (byFund = new Map()));
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
  };
  for (const fund of movers.funds) {
    if (fund[3] > cap) continue;
    for (const m of fund[4]) {
      // Placed by the pipeline, which had the filed name and share class to go
      // on; the ticker alone is the fallback for a file built before that.
      const sector = (m[6] != null && SECTORS[m[6]]) || sectorMap[m[0].toUpperCase()] || "Unclassified";
      add(sector, fund, m);
      if (inAiTheme(m[0], sector)) add(AI_THEME, fund, m);
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

interface StockRow {
  ticker: string;
  sold: number;
  bought: number;
  sellers: number;
  buyers: number;
}

/**
 * The same trades added up by stock: how much the sector's focused managers
 * sold and bought of each, and how many of them did. Every focused manager in
 * the sector, not a watchlist, which is the one thing Consensus cannot show.
 */
function byStock(managers: Manager[]): StockRow[] {
  const stocks = new Map<string, StockRow & { lastSeller?: string; lastBuyer?: string }>();
  for (const mgr of managers) {
    for (const m of mgr.moves) {
      let s = stocks.get(m[0]);
      if (!s) stocks.set(m[0], (s = { ticker: m[0], sold: 0, bought: 0, sellers: 0, buyers: 0 }));
      // A manager counts once per stock, even with two share classes of it.
      if (m[3] > 0) {
        s.bought += m[3];
        if (s.lastBuyer !== mgr.cik) { s.buyers++; s.lastBuyer = mgr.cik; }
      } else if (m[3] < 0) {
        s.sold -= m[3];
        if (s.lastSeller !== mgr.cik) { s.sellers++; s.lastSeller = mgr.cik; }
      }
    }
  }
  return [...stocks.values()];
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
  const [cap, setCap] = useState<Cap>("40");
  const [sort, setSort] = useState<SectorSort>("net");
  const [picked, setPicked] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("Managers");
  const [side, setSide] = useState<Side>("Sellers");
  const [byWeight, setByWeight] = useState(false);
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
    const all = bySector(movers, sectorMap, Number(cap));
    const theme = all.filter((r) => r.sector === AI_THEME);
    return [...theme, ...all.filter((r) => r.sector !== AI_THEME).sort(SORTERS[sort])];
  }, [movers, sectorMap, cap, sort]);
  const current = rows.find((r) => r.sector === picked) ?? rows[0] ?? null;
  const peak = Math.max(1, ...rows.map((r) => Math.abs(r.net)));

  // Back to the top of the list whenever the list itself changes.
  useEffect(() => { setShown(PAGE); }, [current?.sector, side, query, cap, byWeight]);
  useEffect(() => { setStockShown(STOCK_PAGE); }, [current?.sector, query, cap]);

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
    return rows.sort((a, b) =>
      byWeight
        ? (sellers ? a.weight - b.weight : b.weight - a.weight)
        : (sellers ? a.net - b.net : b.net - a.net),
    );
  }, [current, side, query, byWeight, tickerHit]);

  // Both lists at once, never one behind a toggle: a stock sold by some focused
  // managers and bought by others is the interesting case, and it only shows
  // when the two lists sit side by side.
  const names = movers?.names ?? NO_NAMES;
  const stocks = useMemo(() => {
    if (!current) return { sold: [], bought: [] };
    const q = query.trim().toUpperCase();
    const all = byStock(current.managers).filter((s) =>
      !q || tickerHit(s.ticker) || (q.length >= 3 && (names[s.ticker] ?? "").toUpperCase().includes(q)));
    return {
      sold: all.filter((s) => s.sold > 0).sort((a, b) => b.sold - a.sold),
      bought: all.filter((s) => s.bought > 0).sort((a, b) => b.bought - a.bought),
    };
  }, [current, query, tickerHit, names]);

  // A stock in either list opens the managers who sold (or bought) it.
  const pickStock = (ticker: string, s: Side) => {
    setQuery(ticker);
    setSide(s);
    setPane("Managers");
  };

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
                  const theme = r.sector === AI_THEME;
                  return (
                    // The whole row is the target for a pointer; the button in the
                    // first cell is the same action for a keyboard or a screen
                    // reader, which a clickable <tr> is invisible to.
                    <tr
                      key={r.sector}
                      className={theme ? "sector-row theme-row" : "sector-row"}
                      data-active={on}
                      onClick={() => setPicked(r.sector)}
                    >
                      <td style={{ maxWidth: 220 }}>
                        <button className="sector-pick" aria-pressed={on} onClick={() => setPicked(r.sector)}>
                          {r.sector}
                        </button>
                        {theme && <span className="theme-note">Chips, chip tools, memory, AI infra</span>}
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
            ? (pane === "Stocks"
                ? `${stocks.sold.length} stocks sold · ${stocks.bought.length} bought`
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
                  label="Most sold" side="Sellers" color={ACTION_COLORS.TRIMMED}
                  rows={stocks.sold} shown={stockShown} names={names} onPick={pickStock}
                />
                <div className="split-rule" style={{ background: t.border }} />
                <StockList
                  label="Most bought" side="Buyers" color={ACTION_COLORS.ADDED}
                  rows={stocks.bought} shown={stockShown} names={names} onPick={pickStock}
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

/**
 * One half of the Stocks view: the sector's stocks by money sold (or bought),
 * with how many focused managers did it. A row opens those managers.
 */
function StockList({
  label, side, color, rows, shown, names, onPick,
}: {
  label: string;
  side: Side;
  color: string;
  rows: StockRow[];
  shown: number;
  names: Record<string, string>;
  onPick: (ticker: string, side: Side) => void;
}) {
  const sold = side === "Sellers";
  const amount = (s: StockRow) => (sold ? s.sold : s.bought);
  const peak = Math.max(1, ...rows.slice(0, 1).map(amount));
  return (
    <div style={{ minWidth: 0 }}>
      <div className="stock-list-label" style={{ color }}>
        {label} <span style={{ color: t.textHint, fontWeight: 600 }}>{rows.length}</span>
      </div>
      {!rows.length ? (
        <div style={{ padding: "8px 14px 14px", fontSize: 12, color: t.textHint }}>
          Nothing {sold ? "sold" : "bought"}
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Stock</th>
              <th>{sold ? "Sold" : "Bought"}</th>
              <th>{side}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((s) => {
              const name = names[s.ticker];
              const pick = () => onPick(s.ticker, side);
              return (
                // As with the sector rows: the row for a pointer, the button for
                // a keyboard or a screen reader.
                <tr key={s.ticker} className="sector-row" onClick={pick}>
                  <td className="stock-cell">
                    <button
                      className="sector-pick stock-pick"
                      onClick={pick}
                      title={`${name ? `${s.ticker} · ${name}` : s.ticker} — see who ${sold ? "sold" : "bought"} it`}
                    >
                      <b>{s.ticker}</b>
                      {name && <span className="stock-name">{name}</span>}
                    </button>
                    <span
                      className="net-bar"
                      style={{ transform: `scaleX(${Math.max(0.02, amount(s) / peak)})`, background: color }}
                    />
                  </td>
                  <td style={{ fontWeight: 700 }}>{usd(amount(s))}</td>
                  <td style={{ color: t.textMuted }}>{sold ? s.sellers : s.buyers}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
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
