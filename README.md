# 13F Fund Tracker

SEC Form 13F holdings, cross-fund consensus, and quarter-on-quarter changes across
the full universe of US institutional filers (~9,300 per quarter). Embedded in the
Munshot host as an iframe dashboard.

## What it answers

- **Consensus** — which names are held by 2+, 3+, N of a chosen fund set, and which
  way each fund moved. Scope-toggles between *all filers* and *a watchlist*.
- **Fund** — reported value history, holdings treemap, position changes, sector
  allocation, activity stats, full holdings, filing history — for any filer.
- **Filings** — the global latest-13F feed, filing timeline, amendments, pipeline health.
- **Entries and exits** — the client's stated *anchor*: what was newly bought and what
  was sold out of, per fund and across the group.

## Why the pipeline matters more than the UI

13F is full of traps that make reference sites publish wrong numbers with total
confidence. Everything below was **verified live against sec.gov** and is enforced at
ingest, before any data reaches the database:

| Trap | What goes wrong | Where it's handled |
|---|---|---|
| `value` is thousands before 2023-01-03 and dollars after — keyed on **filing date, not period** | A fund's history silently mixes both. Jefferies' 2021-Q1 exists at `11413760` and `11411017784`. | `decideValueUnits`, 4-rung ladder |
| 3.4% of filers ignored the cutover | Date rule alone is wrong for 82 of 2,395 filings | implied-price override |
| 18.8% of `(cusip, putCall, type)` keys are duplicated | Deduping instead of summing understates a fund by up to 40% | `aggregateHoldings` |
| ~47% of a fund like Citadel's rows are **options** | Mixed denominators inflate the book and deflate every weight | three separate denominators |
| Info table filename is arbitrary (`53405.xml`) | A filename glob finds nothing | SGML `<TYPE>INFORMATION TABLE` selector |
| Amendments arrive up to ~29 months late | Append-only derived tables serve stale numbers forever | ordered fold + invalidation queue |
| 29% of 13F filings are `13F-NT` notices | Renders as "everything was sold" | first-class prior-state |
| A pro-rata event looks like N independent sells | Reference sites ship "-95.40%" on 22 rows | `PRO_RATA_REDUCTION` detector |

Getting the pipeline right *is* the product. The UI renders only what the pipeline
vouches for; where it can't vouch, it withholds the number and says why.

## Stack

- **Frontend** — Vite + React 18 + TypeScript + Recharts 2.x, inline styles with a
  `src/theme.ts` token file (not Tailwind), Munshot Dashboard SDK for session context.
- **Backend** — Cloudflare Pages + Pages Functions + D1 + R2.
- **Pipeline** — GitHub Actions cron → `scripts/*.mjs` on the runner → authenticated
  multi-phase POST into a Function. Node 20 ESM. No Python.

## Storage tiers

| Tier | Scope | Size |
|---|---|---|
| Filing metadata + reported totals | all filers, all time (2013-06 →) | ~480k rows |
| Full holdings | all filers, **rolling 8 quarters** | ~24M rows, 4–5 GB |
| Raw filings archive | all ingested filings | R2 |

The full universe is ~3M holdings rows per quarter, so 20 quarters would be 8–10 GB —
at or past D1's ceiling. Eight quarters covers every QoQ, entry/exit and overlap
question; the all-time reported-value chart runs off `fund_period_metrics` and never
touches a holdings row.

> **Prerequisite: Cloudflare Workers Paid ($5/mo).** The Free tier caps D1 at 500 MB,
> CPU at 10 ms per invocation, and D1 writes at 100k rows/day. This scope does not fit.

## SEC access policy

All sec.gov traffic goes through `scripts/_sec-fetch.mjs` — one surface, ≤5 req/s
(stated ceiling is 10), declared `User-Agent`, gzip, conditional requests.

**A 403 is never retried.** The SEC blocks per IP and clears blocks by manual email
about a specific address; GitHub-hosted runners draw from a shared pool of ~7,300 Azure
CIDRs. Because each run gets a different IP, a block caused by someone else's abuse
self-heals on the next run — provided we never retry inside a run and never lose our
place. Hence: preflight probe, terminal 403, resumable cursors, and a poison detector
that escalates only when consecutive runs on different IPs fail. `npm run guard` fails
CI if anyone adds a retry.

**But 403 also means "no such file".** EDGAR answers 403, not 404, for any missing path
under `/Archives/` — a daily index for today (not cut until evening), for a weekend, or
for a date in the future. Reading that as a ban is what took Q2-2026 coverage down to 13
filers out of 10,698 for eleven days. So the inference is now corroborated rather than
assumed: on a 403 for a path the caller declared may be absent, one HEAD goes to a
different, known-good static file. Served → the file is missing. Refused → we really are
blocked, terminal as before. The blocked URL is never re-requested, so the no-retry rule
is untouched. On top of that, discovery reads the quarter's `index.json` to learn which
daily indexes exist instead of guessing dates, so it does not ask for absent files at all.

**Nothing is missed, only deferred.** A filing season is ~10,700 managers, far more than
one polite job can fetch. Each same-day run reads whichever daily indexes are new, adds
their filers to a cursor kept in R2, drains a bounded slice (35% reserved for the newest
day so same-day freshness is never starved by a backlog), and advances the cursor only
for the funds whose artifacts actually landed. A blocked run, a dropped cron or a
budget-truncated run costs time, never a filing. There is deliberately no watchlist
fallback: publishing a token slice of the universe and calling the run green is strictly
worse than stopping, and `npm run guard` now fails CI if one reappears.

Steady-state usage is a few hundred requests per quarter: one daily-index file covers
every filer for a day (2,552 filings on 2026-05-15 in a single request), and one DERA
ZIP covers a quarter.

## CUSIP

CUSIP identifiers are proprietary (ABA, licensed via CUSIP Global Services / S&P).
They are a transient internal join key here: confined to the `securities` table,
resolved to `issuer_id` and ticker, and stripped from every API response, CSV export
and URL. `npm run guard` enforces it structurally. *Not legal advice — the
redistribution question goes to counsel before public launch.*

## Development

```bash
npm install
npm run check     # guards + typecheck + tests
npm run dev       # Vite on :5173, proxying /api to wrangler pages dev on :8788
```

Verify the parser against live filings (12 SEC requests):

```bash
node --env-file=.env scripts/verify-filing.mjs
```

Apply migrations locally:

```bash
npx wrangler d1 migrations apply muns-13f --local
```

## Layout

```
shared/         calendar.mjs, fold.mjs   — pure logic, imported by scripts AND functions
scripts/        SEC fetch/parse, ingest jobs, CI guards
functions/api/  Pages Functions: capture (write) + read endpoints
migrations/     numbered D1 schema, all IF NOT EXISTS
src/            the dashboard
tests/          101 fixture tests pinned to real filings
```

## Status

All three views are live against real SEC filings, on free tiers, with no server.

- [x] SEC fetch/parse, correctness gates, **117 tests**, 5 CI guards
- [x] Artifact schema + fund ingest
- [x] CUSIP → ticker (**98.6%** resolved, 20,375 pairs, 31 SEC requests)
- [x] **Fund view** — treemap, value history, position changes, holdings, exits, longs-vs-options
- [x] **Consensus view** — matrix, entries & exits, overlap distribution, group activity
- [x] **Filings view** — feed, timeline, outstanding, amendments
- [x] Automated pipeline — 3 daily cron slots, keepalive, deadline-aware watchdog
- [ ] DERA bulk loader for the full ~9,300-filer universe
- [ ] Ticker drawer (click-through to "who else holds this")
- [ ] Sector allocation — needs a SIC/GICS source we do not have yet; deliberately not faked

Seed build: 8 funds × 8 quarters → **128 files, 5.7 MB gzipped**, largest 202 KB (Citadel,
12,857 positions), 219 SEC requests.

### Validated against an independent source

Every Cantillon quarter matches the reported values on Fintel's 13F history page — Q1-25
`$15.44B`, Q4-24 `$16.55B`, Q3-24 `$16.35B` — and every Q2-2026 holding matches row for row
(Broadcom 186.8K shares / $70.5M / 10.6%, Alphabet 171.1K / $61.1M / 9.2%, …).

**Except the Δ columns.** Fintel prints "−95.40%" on 22 rows. We print `—` and explain: the
share ratio across all 27 retained positions has an IQR of 0.0000029, so it cannot be 27
independent trades. It was one redemption.

### Bugs the browser caught that tests did not

Worth recording, because each was invisible in unit tests and obvious on screen:

| Bug | Effect |
|---|---|
| Ingest anchored on the filing *deadline* | Silently skipped the newest quarter's filings for six weeks of every quarter |
| Series stored oldest-first, indexed `+1` | KPI deltas compared against the **next** quarter |
| Missing artifact returned SPA HTML | "Hasn't filed yet" — the normal state for 2/3 of filers — rendered as a crash |
| `dominantAction` ranked NEW highest | A small new share class made a long-held $15.6B position read as *newly bought* |
| Exit-only rows failed the holder threshold | A name the **whole group** sold out of vanished from the exits list |
| Lag from timestamps, not calendar days | Every punctual filer painted amber as "late" |
| Amendments mixed into the filing timeline | A 323-day-late restatement stretched the axis and hid the real 30–60 day signal |
| Asking EDGAR for *today's* daily index first | It does not exist until evening, EDGAR answers **403**, and 403 meant "IP banned" — so discovery declared every run blocked, fell back to 13 hard-coded funds, and reported success. Q2-2026 sat at 13 of 10,698 filers for eleven days |
| `parseFormIdx` reading column offsets from "the line above the rule" | EDGAR wraps that header onto two lines, so the offsets were never found and the parser returned **zero rows** for every live file. Every fixture used a tidy one-line header |
| A quarantined quarter left `summary: null` but `noticeOnly: false` | Fell through the notice guard and threw on `summary.value_long_usd`, ending the whole run and publishing nothing. Caught live on Adelante Capital's Q2-2026 filing |
| "Outstanding = every filer minus the ones we hold" | Told a client 9,255 managers had not filed, on a day when they had and we simply had not read them yet |
| The same list is capped at 2,000 rows by its producer | So even a fully-ingested quarter named ~7,300 managers as "no filing" — the cap was mistaken for the quarter |
| Reported total read from `foldable[last]` | The submissions API returns filings newest-first, so it took the ORIGINAL of every amended period. Berkshire's Q1-25 showed the superseded $258.70bn beside holdings totalling $259.81bn |
| `showRaw` initialised `true` and never set `false` | The suppression explanation was unreachable, the branch that did render said "Deltas hidden" while they were on screen, and the Position changes card called a manager's eighth quarter its first |
| `suppressAll` nulled only the percentage deltas | The "Δ Value" toggle ranked by `d_value` and laid one redemption out as 27 separate sells — the exact reading suppression exists to prevent |
| Turnover computed for a suppressed quarter | "TURNOVER 33.8%" inches above an Activity widget refusing to draw the same comparison |
| Shared artifacts rewritten in place behind an immutable year-long cache | The merged feed and the filer index reached R2 and never reached a returning browser |
