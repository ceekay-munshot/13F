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
import { useHostContext } from "./hooks/useHostContext";
import { sdkMode, registerCaptureHandlers } from "./lib/sdk";
import { periodLabel, dateLabel } from "./lib/format";
import { loadManifest, loadFilers, defaultPeriod, type Manifest, type Filer } from "./lib/data";
import { filingSeason } from "../shared/calendar.mjs";
import { t, font } from "./theme";

// Views are code-split so the shell paints before Recharts is parsed.
//
// Recharts is ~440 KB of the bundle and only two of the three views need it —
// the Consensus matrix is hand-rolled DOM precisely so it does not. Loading all
// of it up front to render a header and a KPI row is exactly the kind of bulk
// worth removing: the shell now ships in a fraction of the bytes and each view
// arrives on demand, cached thereafter.
const FundView = lazy(() => import("./views/FundView").then((m) => ({ default: m.FundView })));
const ConsensusView = lazy(() => import("./views/ConsensusView").then((m) => ({ default: m.ConsensusView })));
const FilingsView = lazy(() => import("./views/FilingsView").then((m) => ({ default: m.FilingsView })));

const GRID_WIDE: React.CSSProperties = {
  display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fill, minmax(480px, 1fr))",
};

export default function Dashboard() {
  const { session, market } = useHostContext();
  const [view, setView] = useState<ViewId>("fund");
  const [mf, setMf] = useState<Manifest | null>(null);
  const [filers, setFilers] = useState<Filer[]>([]);
  const [cik, setCik] = useState<string | null>(null);
  const [period, setPeriod] = useState<string | null>(null);
  const [longsOnly, setLongsOnly] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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
        setPeriod((p) => p ?? defaultPeriod(m));
        setCik((c) => c ?? f[0]?.cik ?? null);
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
              <FundView cik={cik} period={period} mf={mf} longsOnly={longsOnly} />
            ) : view === "consensus" ? (
              <ConsensusView
                filers={filers}
                period={period}
                mf={mf}
                longsOnly={longsOnly}
                onFund={(c) => { setCik(c); setView("fund"); }}
              />
            ) : (
              <FilingsView
                filers={filers}
                period={period}
                mf={mf}
                onFund={(c) => { setCik(c); setView("fund"); }}
              />
            )}
            </Suspense>
          </>
        )}
      </main>
    </div>
  );
}
