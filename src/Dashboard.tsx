// src/Dashboard.tsx
//
// Zone 1 (48px sticky header) / Zone 2 (the only scrolling area) / no Zone 3.
// The page itself never scrolls — index.html sets body { overflow: hidden } and
// this shell is height: 100vh.

import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { Header, type ViewId, type Freshness } from "./components/Header";
import { ScopeBar } from "./components/ScopeBar";
import { WidgetCard } from "./components/WidgetCard";
import { ErrorState, SdkMissingState, StandaloneBanner, TableSkeleton } from "./components/states";
import { ViewErrorBoundary } from "./components/ViewErrorBoundary";
import { useHostContext } from "./hooks/useHostContext";
import { sdkMode, registerCaptureHandlers } from "./lib/sdk";
import { periodLabel, dateLabel } from "./lib/format";
import { loadManifest, loadFilers, defaultPeriod, defaultFilerCik, type Manifest, type Filer } from "./lib/data";
import { FavouritesBar } from "./components/FavouritesBar";
import { loadFavourites, saveFavourites, resetFavourites, CLIENT_WATCHLIST, codeFor } from "./lib/favourites";
import { filingSeason } from "../shared/calendar.mjs";
import { t, font } from "./theme";

// Views are code-split so the shell paints before Recharts is parsed.
//
// Recharts is ~440 KB of the bundle and only two of the three views need it —
// the Consensus matrix is hand-rolled DOM precisely so it does not. Loading all
// of it up front to render a header and a KPI row is exactly the kind of bulk
// worth removing: the shell now ships in a fraction of the bytes and each view
// arrives on demand, cached thereafter.
/**
 * Lazy import that survives a deploy.
 *
 * Chunk filenames are content-hashed, so a deploy replaces them. A browser
 * holding the previous index.html — an open tab, or a cached shell — then asks
 * for a chunk that no longer exists, the dynamic import rejects, and React
 * unmounts the tree: a WHITE PAGE, with no error and nothing to click. Observed
 * live, switching views on a tab that had been open across a deploy.
 *
 * The app is stale, not broken, and the fix is to fetch the current shell. One
 * reload does that. `sessionStorage` guards against a reload loop if the chunk
 * is genuinely missing rather than merely renamed — better to fall through to
 * the error boundary once than to spin forever.
 */
function withChunkReload<T>(load: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await load();
    } catch (err) {
      const KEY = "13f:chunk-reload";
      if (!sessionStorage.getItem(KEY)) {
        sessionStorage.setItem(KEY, "1");
        location.reload();
        return await new Promise<T>(() => {}); // never resolves; the reload takes over
      }
      throw err;
    }
  };
}

const FundView = lazy(withChunkReload(() => import("./views/FundView").then((m) => ({ default: m.FundView }))));
const ConsensusView = lazy(withChunkReload(() => import("./views/ConsensusView").then((m) => ({ default: m.ConsensusView }))));
const FilingsView = lazy(withChunkReload(() => import("./views/FilingsView").then((m) => ({ default: m.FilingsView }))));

const GRID_WIDE: React.CSSProperties = {
  display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fill, minmax(480px, 1fr))",
};

export default function Dashboard() {
  const { session, market } = useHostContext();
  // Consensus, not Fund. "What is the group accumulating, and who entered or
  // exited?" is the question this product was built to answer; the Fund view is
  // where you go once a name in the matrix makes you curious about one manager.
  // Opening on Fund also meant opening on a single arbitrary filer.
  const [view, setView] = useState<ViewId>("consensus");
  const [mf, setMf] = useState<Manifest | null>(null);
  const [filers, setFilers] = useState<Filer[]>([]);
  const [cik, setCik] = useState<string | null>(null);
  const [period, setPeriod] = useState<string | null>(null);
  const [longsOnly, setLongsOnly] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // The comparison set AND the Fund view's shortcuts are the same list. Keeping
  // them as one piece of state is deliberate: a user who stars a manager means
  // "this one matters to me", and having to say that twice — once for the
  // matrix, once for the shortcut row — would be the app's filing cabinet
  // leaking into their head.
  const [favourites, setFavourites] = useState<string[]>(() => loadFavourites());

  const setFavs = (next: string[]) => { setFavourites(next); saveFavourites(next); };
  const toggleFav = (c: string) =>
    setFavs(favourites.includes(c) ? favourites.filter((x) => x !== c) : [...favourites, c]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const season = useMemo(() => filingSeason(today), [today]);

  useEffect(() => {
    let cancelled = false;
    loadManifest()
      .then(async (m) => {
        if (cancelled) return;
        const f = await loadFilers(m);
        if (cancelled) return;
        setMf(m);
        setFilers(f);
        // Open on the newest period that actually has data, not the newest that
        // exists. A just-closed quarter is nearly empty for six weeks.
        const p0 = defaultPeriod(m);
        setPeriod((p) => p ?? p0);
        setCik((c) => c ?? defaultFilerCik(f, p0));
      })
      .catch((e) => !cancelled && setErr(String(e.message ?? e)));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const off = registerCaptureHandlers({
      captureBlob: async () => null,
      snapshot: () => ({ view, cik, period, buildId: mf?.buildId ?? null }),
    });
    return off;
  }, [view, cik, period, mf]);

  // Inside an iframe with no SDK, the honest render is an error — not an empty
  // dashboard, which reads as "there is no data" and sends the user looking for
  // a data problem that does not exist.
  if (sdkMode === "missing") {
    return (
      <div style={{ height: "100vh", display: "grid", placeItems: "center", fontFamily: font, background: "#fff" }}>
        <SdkMissingState />
      </div>
    );
  }

  const periods = mf?.periods.map((p) => p.period).sort().reverse() ?? [];

  // Consensus compares a BOUNDED set of managers, not the whole universe.
  //
  // Two reasons, and the first is fatal: the view joins each fund's holdings in
  // the browser, so pointing it at 9,396 filers fired 9,396 parallel fetches and
  // hung the page. The second is that it would not be readable anyway — overlap
  // across nine thousand managers is a market-wide statistic, not a comparison.
  // The product's question is "what do THESE managers agree on", so take the
  // largest funds whose line items we actually carry.
  //
  // The cap is a RENDER limit, not an opinion about how many funds matter: each
  // fund is a matrix column, and past roughly sixteen the grid stops being
  // readable on a laptop before it stops being computable.
  const CONSENSUS_MAX = 16;
  const consensusFunds = useMemo(() => {
    const byCik = new Map(filers.map((f) => [f.cik, f]));
    // The user's own set, in THEIR order — resolved against the index so a CIK
    // that has stopped filing simply drops out rather than rendering an empty
    // column.
    const chosen = favourites.map((c) => byCik.get(c)).filter(Boolean) as Filer[];
    if (chosen.length >= 2) {
      return chosen.slice(0, CONSENSUS_MAX).map((f) => ({ ...f, code: codeFor(f.cik, f.name) }));
    }
    // Only if they have emptied the list entirely. Falling back to "largest by
    // value" would select index complexes that between them hold the whole
    // market, which turns consensus into a tautology — so prefer the flagged
    // active managers, and take size only as a last resort.
    const watch = filers.filter((f) => f.watch);
    const pool = watch.length >= 2 ? watch : filers.filter((f) => f.hasHoldings !== false);
    return pool.slice(0, CONSENSUS_MAX).map((f) => ({ ...f, code: codeFor(f.cik, f.name) }));
  }, [filers, favourites]);
  const freshness: Freshness = !session.token && sdkMode === "live" ? "nosession" : "fresh";

  return (
    <div
      style={{
        display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden",
        background: t.pageBg, fontFamily: font, color: t.textPrimary, position: "relative",
      }}
    >
      <Header
        view={view}
        onView={setView}
        context={mf ? `${mf.counts.filers} funds · ${period ? periodLabel(period) : "—"}` : "loading…"}
        ticker={market?.selectedTicker ?? null}
        freshness={freshness}
        freshnessDetail={
          freshness === "nosession"
            ? "No session"
            : `${periodLabel(season.period)} due ${dateLabel(season.deadline)}`
        }
        onRefresh={() => {
          setRefreshing(true);
          loadManifest(true)
            .then(setMf)
            .finally(() => setRefreshing(false));
        }}
        refreshing={refreshing}
      />

      {sdkMode === "standalone" && <StandaloneBanner />}

      <main
        id="dashboard-main"
        data-dashboard-capture-root="true"
        style={{ flex: 1, overflow: "auto", padding: "24px 32px" }}
      >
        {err ? (
          <div style={GRID_WIDE}>
            <WidgetCard title="Data" span={2}>
              <ErrorState message={err} />
            </WidgetCard>
          </div>
        ) : !mf || !period ? (
          <div style={GRID_WIDE}>
            <WidgetCard title="Loading" span={2}><TableSkeleton rows={6} cols={5} /></WidgetCard>
          </div>
        ) : (
          <>
            <ScopeBar
              filers={filers}
              cik={cik}
              onCik={setCik}
              periods={periods}
              period={period}
              onPeriod={setPeriod}
              longsOnly={longsOnly}
              onLongsOnly={setLongsOnly}
            />

            {/* FUND VIEW ONLY.
                On Consensus this same list IS the matrix columns, already named
                across the top of the grid — a second copy of them as chips
                would be the same information twice, and the row would compete
                with the filters directly above it. Here it is navigation, which
                the Fund view otherwise lacks entirely. */}
            {view === "fund" && (
              <FavouritesBar
                favourites={favourites}
                filers={filers}
                cik={cik}
                onCik={setCik}
                onToggle={toggleFav}
                onReset={() => setFavourites(resetFavourites())}
                canReset={
                  favourites.length !== CLIENT_WATCHLIST.length ||
                  favourites.some((c, i) => c !== CLIENT_WATCHLIST[i].cik)
                }
              />
            )}

            {/* A crash inside a view must not blank the whole document. */}
            <ViewErrorBoundary>
            <Suspense
              fallback={
                <div style={{ ...GRID_WIDE, marginTop: 22 }}>
                  <WidgetCard title="Loading view" span={2} bodyMinHeight={260}>
                    <TableSkeleton rows={7} cols={6} />
                  </WidgetCard>
                </div>
              }
            >
            {view === "fund" && cik ? (
              <FundView
                cik={cik}
                period={period}
                mf={mf}
                longsOnly={longsOnly}
                refreshing={refreshing}
                group={consensusFunds}
                onPeriod={setPeriod}
              />
            ) : view === "consensus" ? (
              <ConsensusView
                filers={consensusFunds}
                period={period}
                mf={mf}
                longsOnly={longsOnly}
                refreshing={refreshing}
                onFund={(c) => { setCik(c); setView("fund"); }}
              />
            ) : (
              <FilingsView
                filers={filers}
                period={period}
                mf={mf}
                refreshing={refreshing}
                onFund={(c) => { setCik(c); setView("fund"); }}
              />
            )}
            </Suspense>
            </ViewErrorBoundary>
          </>
        )}
      </main>
    </div>
  );
}
