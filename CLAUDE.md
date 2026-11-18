# Working with the owner of this repo

## Talk in plain English. Always.

The owner is **non-technical**. This is a standing instruction, not a
preference for one conversation.

- **No jargon.** Not "manifest merge", "R2 bucket", "cron", "403", "CIK".
  If a technical word is unavoidable, say what it means in the same sentence.
- **Lead with the answer.** "Is this okay?" gets "Yes" or "No" first, then why.
- **Say what is broken vs what is fine.** Red marks and error text are alarming.
  Always say plainly whether the live dashboard is affected, because usually it
  is not.
- **One clear action.** End with the single next thing to do, in steps anyone
  could follow. Not a menu of options.
- **Never assume they will read a log.** If something needs checking, either
  check it yourself or say exactly where to click and what they should see.

## What this project is, in one line

A dashboard showing what big investment funds own, built from public filings
they send to the SEC (the US financial regulator) every three months.

## Things worth knowing

- The live dashboard is at https://13f-eo2.pages.dev
- Push to `main` when work is done — this is the standing instruction. It goes
  live automatically a few minutes later.
- Funds report four times a year, and a lot of them file on the same deadline
  day, so "is today's data in?" is the question that matters most.

## Booked in

- **The "one big withdrawal, not 27 separate sales" detector needs a second
  piece of evidence.** It compares two quarters and spots that every holding
  moved by the same percentage. That is the right answer for Cantillon — their
  own filing confirms it — but it cannot tell a real withdrawal apart from a
  fund changing how it splits its holdings across two managers on the form.

  This was written down as "scheduled to run on its own" for Sat 22 Aug. **It
  was not scheduled anywhere**, and reminders of that kind do not survive
  between sessions, so nothing would have happened. Saying so here rather than
  quietly rescheduling, because the promise in "Standing promises" below was
  broken once and the way it broke matters.

  Measured on 21 Aug against the SEC's own bulk data, two quarter transitions,
  ~8,500 funds each: of 79 funds flagged, **one** was really a manager-split
  change (a Mitsubishi UFJ entity that consolidated two managers onto its form
  and appeared to grow every position by 114%). Cantillon is correctly read as
  a genuine withdrawal. So the gap is real but rare — about 1 in 79 — and the
  evidence needed is already in the SEC files we download: the cover-page list
  of included managers, which is stable across quarters. **Not yet built.**

- **The yellow "filed for Q3 2026 but still queued to be read" banner is
  guessing, and the guess is nearly always "yes".** *Half fixed on 17 Nov 2026
  — see Done.* The pipeline now publishes its true queue size, so the banner
  disappears once everything filed has been read, and the number it shows is
  real. What is still a guess: while the queue is not empty, the Fund tab can
  only say "this may be one of them" about a fund with no data, because the
  pipeline publishes how many are queued, not which. Original note: found 11 Nov 2026. It named
  Berkshire Hathaway and 12 others as filed-but-unread two days before the
  deadline, when most of them very likely had not filed yet.

  Why: the page decides "still loading" by comparing two totals — managers the
  SEC says filed, and managers we hold holdings for. Those can never match,
  because about 2,000 managers a quarter file only a notice ("my positions are
  in someone else's report") and never become a holdings page. So the page
  believes every quarter is still loading forever: Q2 2026, three months past
  its deadline, still reads 10,853 filed vs 8,542 held. Every tracked fund with
  no data is therefore described as "filed, not read yet", whatever the truth.

  The fix needs the pipeline to say *which* managers filed, not just how many —
  it already has that list while it works (`discover-13f-filers.mjs`) and throws
  it away. **Not yet built, and not scheduled anywhere** — this note is the only
  record. (On 11 Nov an attempt to queue it as a task in the app timed out.) The
  check is `stillIngesting` in `src/views/ConsensusView.tsx`; the Filings tab's
  "This quarter is still loading" banner and the Fund tab use the same test.

### Done

- **19 Nov 2026 — every sector on the Sectors tab opens into subsectors.**
  Click a sector and 3 to 9 smaller groups open underneath it, with the same
  Sold / Bought / Net / Sellers / Buyers columns. Health Care splits into drug
  makers, biotech, medical devices, diagnostics, hospitals and drug
  distributors. Semiconductors splits into chips, memory, chip equipment,
  solar and circuit boards. Funds split into broad market, sector,
  international, bonds & credit, gold/commodities/crypto and leveraged. Click
  a subsector and the right side, Managers and Stocks, shows only it. Click
  the sector again to go back up to it, and once more to close it. AI & semis
  stays on top as before.

  It answers questions a sector row could not. In Q3, focused managers net
  bought chips (+$3.05B) and memory (+$2.94B) but net sold chip equipment
  (−$2.41B). They sold storage hardest (−$4.89B: SanDisk, Seagate, Western
  Digital), and sold the big US banks (−$2.59B) while regional banks were
  flat.

  The groups come mostly from the SEC's own industry codes. Short hand-kept
  lists cover the names those codes misfile: Micron is memory, not next to
  NVIDIA; Booking.com is travel, not trucking; First Solar is solar; REITs go
  by kind; foreign banks sit apart from US ones. **A subsector never moves a
  company to another sector**, so every sector total, and Consensus's Sector
  flows, are exactly as before. If those rules are ever edited, the Sectors
  job notices by itself and rebuilds everything. There is no version number
  to remember.

  Checked before merging with two dry runs of the Sectors job on the real
  data, publishing nothing. In Q3 most sectors leave 0–4% of their money in
  their "Other…" group. The largest are Other funds (12%: mostly one $2.5B
  holding filed only as "mutual funds"), Regional & other banks (15%), and
  Satellite & other communications (15%: Viasat, EchoStar, AST SpaceMobile, a
  real group in its own right).

- **19 Nov 2026 — the Sectors tab now shows which stocks were sold and bought
  most.** The right-hand panel has a **Stocks | Managers** switch. Stocks
  shows the selected sector's "Most sold" and "Most bought" side by side, for
  every focused manager in it, not just your favourites as on Consensus. Each
  line shows how much and how many managers. Clicking a stock opens the
  managers who sold (or bought) it. For AI & semis in Q3: most sold NVDA
  $3.26B by 154 managers, then Seagate, SanDisk and TSMC; most bought Intel
  $3.86B, SK Hynix $3.47B, and NVDA again, $2.99B by 155. Company names come
  from the filings; the Sectors job now saves one name per ticker. The
  dashboard has opened on the Sectors tab since 18 Nov.

- **17 Nov 2026 — the check for "a name that does not exist" now looks where
  the name is used, not just anywhere in the file.** This is the check that
  missed the monthly-rebuild mistake described in the next entry: a line used
  a word that existed in two other loops of the same file but not in the one
  it sat in. The check saw the word somewhere and passed it. It now only
  accepts a word that is actually within reach of the line using it.

  Tested on the exact mistake: it now stops it, and says which lines the word
  does exist on. Run over every version of every pipeline file in the
  project's history (144 saves), it finds that mistake and the one older typo
  already known, and nothing else, so it does not raise false alarms. Nothing
  in today's code is broken. The dashboard itself is unaffected.

- **17 Nov 2026 — a fund that corrects its report now shows the corrected
  total.** Each quarter carries the total the fund wrote on its own filing. When
  a fund sent a correction, the monthly rebuild took that total from whichever
  filing it happened to read last, usually the first, uncorrected one. When a
  fund later added holdings it had held back, it showed one part instead of the
  whole. The holdings were right; only that total and the "filed on" date were
  not. The same-day update already did this correctly. The monthly rebuild put
  the wrong figure back every month.

  Measured on the SEC's March-quarter file: 69 of 8,472 fund-quarters change,
  nothing else does. 58 now show the corrected total (Janus Henderson $201.7B →
  $209.4B; First Eagle $75.6B → $59.0B), and 11 now show the first report plus
  what it added (Inspire Investing $0.50B → $1.71B). The "filed on" date is now
  the latest filing's, as the same-day update has it. Live after the next
  monthly rebuild following merge.

  Found on the way, and fixed with it: the monthly rebuild would have stopped
  with an error the first time it met a filing with company names on the wrong
  lines (the Lightrock fix further down). One line named the fund by a word
  that did not exist there. The automatic check for that missed it, because
  the same word is used in an unrelated part of the file.

- **17 Nov 2026 — a fund that sends its report twice is no longer counted
  twice.** Some managers re-send their whole quarterly report but tick the box
  that says "these are extra holdings only". We believed the box and added the
  copies together, so the quarter showed the book two or three times over
  (Arbiter Partners' June: 127 positions worth $576M, really 44 worth $197M)
  and anything sold the next quarter appeared once per copy in "Exited", each
  with a different percentage.

  Now a "new holdings" amendment is treated as the re-sent report it is when
  it repeats at least half of what was already reported, judged three ways:
  the same companies, the same companies at the same share counts, or the
  same lines to the dollar and the share whatever company code is on them. The
  third catches a re-send that only fixes the codes (GFS Advisors' March: codes
  on the wrong lines the first time, every number identical the second, and
  counted twice until this). Checked on all 247 in the SEC's own bulk files
  across four three-month batches: 67 re-sent reports and 180 real additions.
  No real addition gets past 37% on any of the three tests, and every re-send
  reaches at least 58% on one of them. When two filings really do combine, the
  result now has one row per holding and percentages against the whole quarter.

  Of the 46 funds whose September "Exited" list looked doubled, 19 were this.
  26 were not doubles at all (different securities sharing an ID prefix and a
  value, e.g. Opendoor's three warrant series), and one filed its puts as
  shares. The 19 correct themselves at the next monthly rebuild after merge.

- **17 Nov 2026 (later) — the Sectors tab now answers "who cut AI and chips?"
  directly.** The owner's original question could not be read off it: the
  SEC's codes split the AI trade over four sectors (chips in Semiconductors,
  SanDisk/Seagate/WDC in Computers & Hardware, Nebius/CoreWeave in Software,
  Vertiv/Coherent in Electronics), and Semiconductors sat at the bottom
  because focused managers net bought it. A pinned **"AI & semis"** row now
  gathers all of it, opens by default, and lists the sellers on the right —
  Trivest, WT Asset Management, Lone Pine, Amanah, Whale Rock, H&H. It is a
  hand-kept THEME (`shared/themes.mjs`), kept apart from the SEC sectors.
  Also: preferred shares go with their issuer, shorthand names are expanded,
  lending funds go to Funds & ETFs — Unclassified 0.5% → 0.3% of Q3 trading.

- **17 Nov 2026 — "Unclassified" went from a quarter of all money traded to
  half a percent.** On the Sectors tab it was $38.65B sold / $50.80B bought
  in Q3; on Consensus's Sector flows it held $101.87B. Now $1.32B / $0.55B and
  $1.94B (0.2% of value held). Four causes, all fixed:
  1. **Funds and ETFs had no sector** (half of it). They go in "Funds &
     ETFs", from the SEC's own list of fund tickers and from how filers write
     fund names ("SPDR … ETF TR", "ISHARES TR").
  2. **The sector list missed companies** (over a third): new listings
     (SpaceX, SK Hynix), foreign companies (HDFC, Teva), and companies bought
     out this year that funds still sold (Electronic Arts, Janus Henderson).
     Each missing company is now looked up on its own SEC record, once, and
     remembered; a bought-out company is found by its name in its last filing.
  3. **Holdings filed with no ticker** are placed by company name.
  4. **BRKB in a filing is BRK-B at the SEC** — both spellings now match.

  Also corrected while there: Trane was in Health Care, Visa and Mastercard
  would have landed in Industrials (the SEC files them, Uber, Alibaba and
  Airbnb under a catch-all "business services" code — about 35 such big names
  are now placed by what they sell, listed in `shared/sectors.mjs`), HVAC
  makers and Eaton had no sector, and bitcoin miners were "Banks & Lending".

  The list is rebuilt weekly by the Sectors job ("Build the Sectors tab") and
  read by both tabs; the monthly build reuses its look-ups. Checked with two
  dry runs of that job on GitHub — which can now be run without publishing
  anything — before merging.

- **17 Nov 2026 — a fund whose own filing puts company names on the wrong
  lines no longer gets the wrong tickers.** Found while checking a client's
  question: Lightrock's page said COHU next to a CareTrust REIT holding. Our
  ticker step was right; Lightrock's filing is not. On 12 of its 35 lines the
  company name and the code beside it belong to different companies (CareTrust's
  name on Cohu's code, Cabot's on CareTrust's, and so on down a block). Its
  last four filings all have the same fault.

  The dashboard now spots this. The giveaway is a chain: one company's name on
  a second company's code, whose own line carries a third company's name.
  Ordinary quirks (renamed companies, abbreviations, funds typed as "Blackrock")
  never form that chain. Checked against 36,371 real filings over four
  quarters: 32 have the fault (Lightrock, Franklin Resources, BNP Paribas and
  29 more) and no correct filing was flagged.

  On those lines the page now shows the company name as the fund filed it, with
  no ticker, because we cannot tell which column is right. Nothing is hidden:
  values, share counts and totals are unchanged. Hovering the name says which
  company's code it was filed under, and one line on the Holdings card says how
  many lines are affected. Funds with a correct filing look exactly as before.

  Known limit: two small filings over the four quarters had their codes jumbled
  at random rather than shifted, and this does not catch them. The test that
  would catch them also flagged a fund with correct codes, so it was left out.

  Once merged, the live site picks this up the next time each affected fund is
  re-read, and for every fund at the monthly rebuild on the 3rd.

- **17 Nov 2026 — new Sectors tab, before Consensus.** Answers "which focused
  managers sold (or bought) chips — or any sector — this quarter, and who?"
  Left: every sector, with how much focused managers sold, bought and net, and
  how many sold or bought. Click one, and the right side lists the managers,
  biggest first, with each stock they traded ("NVDA −40%", "AMAT sold out").
  Type a ticker to see only that stock's buyers or sellers. Click a name to
  open the fund.

  "Focused" means 5 to 40 stocks (switchable to 20 or 30). Left out, because
  their selling is not a view on a sector: books that are mostly options, books
  more than half in one stock, companies reporting their own stakes (NVIDIA,
  Uber…), and funds whose changes the dashboard already withholds.

  The data is built by a new automatic job ("Build the Sectors tab") that runs
  after every update and only re-reads funds that changed. It covers the two
  latest quarters. Built from the live site on the day: 1,325 managers for Q3
  2026, 1,370 for Q2. If the job fails it opens one issue and the tab keeps
  its last good copy.

- **17 Nov 2026 — a fund that files in the morning is now on the dashboard
  within the hour, not the next day.** A client emailed: Lone Pine filed on
  Monday 16 Nov (Q3's deadline) and the dashboard still said "we have not read
  Q3 2026 for Lone Pine yet" after several refreshes. Eleven of the fourteen
  client funds filed that day; none of them were showing.

  Three things were wrong, and all three had to be wrong at once:
  1. **We only learned about a filing from the SEC's nightly list**, which
     comes out at about 10pm New York time. However often we checked during the
     day, a morning filing did not exist as far as the pipeline knew.
  2. **GitHub was not running the updater when asked.** It was set for every
     two hours and actually ran every five to twelve — three times a day. On
     the deadline day the gap was twelve hours, and the nightly list came out
     seven minutes after a run had started.
  3. **The alarms had been crying wolf.** The daily check had gone off every
     day for over a week (71 comments on one issue), saying 1,451 filings were
     unread — they were managers who only file a short notice and never get a
     holdings page — and that the updater was "not running" when it was. The
     check that compares client funds with the SEC waited two days before
     calling a missing filing a problem.

  Fixed:
  - The updater now also reads the SEC's **live list of filings**, which shows
    a filing minutes after it is made. That night's full list is still read
    and compared, so anything the live list missed is caught.
  - Every run asks the SEC directly about **each client fund** and compares it
    with what the dashboard shows. If the SEC has a newer quarter, that fund is
    fetched first, whatever else the pipeline believes.
  - A small helper (**"Keep the ingest on time"**) now starts the updater
    itself: every half hour around a deadline, hourly after, every two hours
    otherwise. It does not depend on GitHub's timer firing on time.
  - The client-fund check now raises the alarm after **six hours**, not two
    days. The daily check now counts the real queue, asks GitHub when the
    updater last ran, and stops repeating the same alert every half hour.
  - The page uses the real queue too, so it stops saying "still loading"
    once everything has been read.
  - A new automatic check (`same-day-discovery`) fails the build if any of
    this is removed.

  On the day: the updater was started by hand at 04:31 UTC on 17 Nov, and all
  thirteen client funds that had filed for Q3 were on the live site within
  minutes. Cantillon is the fourteenth: it has not filed for Q3 at all, which
  the SEC confirms.

- **11 Nov 2026 — the page no longer falls apart when you zoom out, or on a
  phone or tablet.** You zoomed out and saw a blank third of the screen on the
  right, and the "Consensus matrix" heading crushed into a column one word wide.

  Three separate causes, all fixed:
  1. **The page layout only worked between about 1,000 and 1,500 pixels wide.**
     Wider, it made three columns and every panel used two, leaving the third
     empty. On a phone, panels asked for two columns when there was room for one,
     and the page scrolled sideways. It is now two columns on a big screen, one
     on a small one, with no gaps and no sideways scrolling, on all three tabs.
  2. **Eleven filter buttons sat beside the panel title** and squeezed it to
     nothing. They now sit on their own row under the title and wrap neatly.
  3. **The matrix stopped two-thirds of the way across** a wide screen. Its
     columns now stretch to fill the panel, up to a sensible width.

  Smaller things fixed on the way: the five number tiles at the top lay out as
  5, then 3-over-2, then 2-2-1 — never a lone tile in a row of four; the top bar
  drops its least useful words on a phone instead of hiding the tabs; the hover
  explanations were coming out in an old-fashioned serif font.

  Also, as asked: **picking a fund in the search box now opens it on the Fund
  tab.** On the other tabs the box reads "Search funds…" instead of showing
  whichever fund the Fund tab last had open, which had nothing to do with the
  page underneath.

  Checked by screenshotting all three tabs at six widths, from a phone (390
  pixels) to a zoomed-out big screen (2,400), with the real data.

- **27 Aug 2026 — the switch to the parent reached nobody who had used the
  dashboard before, and that is now fixed.** Yesterday's repoint changed what a
  NEW visitor sees. Your own list of funds is saved in your browser the first
  time you load the page, so it kept the old company: a struck-through empty
  column headed "PER", saying "no filing this quarter" about a fund that filed
  on the deadline. Reloading would not have fixed it, ever.

  A saved list is now moved on when a fund's reporting moves, once, keeping your
  own ordering. Tested against the exact situation: a browser holding the old
  list goes from "13 of 14" to "14 of 14 — all tracked funds", with Pershing
  Square's holdings back in the comparison.

  Deliberately narrow: it only rewrites entries that are actually there, so a
  fund you removed on purpose stays removed, and it will only ever be used for a
  reporting entity that really moved, evidenced by the filings themselves.

  The hover label on a blank column was making the same mistake as everything
  else and now says which of the four things happened — we could not load it,
  they filed a notice pointing elsewhere, we have not read it yet, or they really
  did not file.

- **26 Aug 2026 (later) — the PSH tile now points at the parent company, and the
  crossover quarter no longer claims 13 purchases.** You asked to follow the
  holdings, so PSH is now Pershing Square Inc. rather than the entity that hands
  its book over. You see what they own, buy and sell, from Q3 2026 onward exactly
  as with any other fund.

  One quarter needed care first. Q2 2026 is the crossover: on the parent's own
  filings the book goes from one position worth $0.57bn to fourteen worth
  $19.47bn. Read as trading — which is how the dashboard read it — that is "13
  new positions bought" and "173% turnover". **Nothing was bought.** The same
  holdings simply arrived on a different form.

  So the dashboard now checks a second thing before it calls anything a purchase:
  the list of managers a filing covers, which is printed on the filing and barely
  ever changes. Pershing Square Inc. named one other manager for Q1 and six for
  Q2. When that list moves *and* the book jumps with it, the quarter is marked
  "different managers included" and the buy/sell columns are left blank with the
  reason written out, instead of inventing trades. The holdings themselves are
  shown in full — that is the part that is true.

  This is the second piece of evidence the "one big withdrawal, not 27 separate
  sales" detector was booked to need. It is now built, and the booked item above
  can be closed for this half of it: Cantillon still reads as a genuine
  withdrawal, because its manager list did not move.

  **Guarded against firing too eagerly**, which would be worse than not having it:
  it needs both signals, it sits out entirely when the manager list was never
  recorded (older stored filings), and it tells "the filer named nobody" apart
  from "nobody read it". All of that is covered by tests.

- **26 Aug 2026 — Pershing Square's page was blank, and the page was wrong about
  why.** The dashboard said "we have not read Q2 2026 for Pershing Square yet".
  It had read it, on the day it was filed.

  What actually happened: Pershing Square Capital Management no longer reports
  its own holdings. On 14 August it sent the SEC a **notice** — a short filing
  that says "my positions are counted in someone else's report now" — naming
  **Pershing Square Inc.**, the public parent company. The holdings were never
  missing. All $19.5 billion of them were on the parent's page the whole time.

  The dashboard could not say any of that, for two reasons:

  1. **We threw the notice away as we read it.** A notice has no list of
     holdings, so the pipeline skipped fetching its cover page — which is the
     one page that names who reports the holdings instead. We now read it and
     keep it.
  2. **A quarter with no holdings had only two explanations, and neither fit.**
     The page could say "they have not filed" or "we have not read it yet". A
     notice is a third thing: they filed, we read it, and it points somewhere
     else. It now says so, quotes the fund's own sentence from the filing, and
     offers a button that opens the manager holding the positions.

  Both pipelines were taught this, so the monthly rebuild cannot undo it, and
  the archived copies of the SEC files carry it too.

  **This is not rare.** The most recent SEC batch holds 2,045 of these notices.
  Every one of them was a fund page that could only say "we have not read it
  yet" about a filing already read.

  The main screen was making the same mistake and now does not: the consensus
  strip said Pershing Square had "filed but not read yet", and now says its
  positions are reported by Pershing Square Inc. and where to look.

  **How it reaches the site:** the fix only changes a fund's page the next time
  that fund is read, and a fund is read once and then left alone — so shipping
  the code was not enough on its own. Pershing Square and its parent were both
  re-read by hand on the day, and checked on the live site. Every other fund in
  the same position catches up on its own at the monthly rebuild on 3 September.

- **18 Aug 2026** — the same-day ingest now fetches only what it has not already
  got, and remembers between runs where it is up to (the "cursor"). This was
  booked for Sat 15 Aug and is now shipped. It also turned out to be the fix for
  a bigger problem: only 13 of the ~10,700 funds that filed for Apr–Jun 2026 had
  reached the dashboard, because the pipeline was misreading "the SEC has not
  published today's list yet" as "the SEC has banned us".

- **21 Aug 2026** — three checks added so a repeat of the 20 Aug outage cannot
  reach the dashboard quietly. In plain terms:
  1. **Nothing may get smaller.** Before every update we take a snapshot of what
     the live site is serving, and afterwards we compare. If any fund lost a
     quarter, or the number of funds dropped, the update is reported as broken.
     Adding and correcting are fine; taking away is not.
  2. **A step that did nothing now fails.** The cleanup step had been crashing
     on its first line since the day it was written, and every run still said
     "success" because the crash was only a note in the log. Steps like that now
     finish the useful work first — so the dashboard is never left half-updated
     — and then end the run in red listing exactly what did not happen.
  3. **The SEC has to agree with our numbers.** After every update we take the
     client funds and compare our total for each one against the total that fund
     wrote on its own filing. It found a real gap on its first run — Nuveen
     filed on 11 Aug and had not reached us — which is now fixed. Every client
     fund's total agrees with that fund's own filing to the dollar.

- **21 Aug 2026 (later)** — **why it kept breaking, and the fix for it.** There
  was no copy of the SEC's files anywhere. Every month the pipeline downloaded
  them, built the dashboard, and threw the source away — so the dashboard's own
  files were the only copy of the data. That is why every update had to
  hand-preserve what was already there, why one missed case on 20 Aug wiped a
  quarter from every fund, and why nothing could be repaired without
  re-downloading. It is also why the site said "10,765 of 10,765 managers" while
  8,295 pages said the manager had not filed: counts could only ever be allowed
  to go up, and a number that can only go up can only lie upward.

  The agreed fix is to keep the SEC's files and rebuild the dashboard from them,
  so it can be thrown away and remade at will. Four steps; the first is done.

  **Done today:** 7,449 fund pages that wrongly said "has not filed for Q2 2026"
  now show it. Rebuilt from data already in storage — no SEC downloads. Q2 2026
  went from 987 managers to 8,428. Every quarter's count is now counted rather
  than assumed, and all four other quarters turned out to be over-stated by about
  2,100 each. All 14 client funds still agree with their own SEC filings.

  **Also done today:** we now keep the SEC's own files instead of downloading
  them and throwing them away — four of them, 345 MB, about a third of what the
  dashboard itself costs. Checked by downloading one back and opening it, not
  just by seeing the upload succeed. The monthly build now reads from that copy
  instead of asking the SEC, so it stops re-downloading a third of a gigabyte
  every month.

  **21 Aug, later still — the two pipelines now share one set of instructions.**
  They each had their own copy of the code that turns filings into what you see,
  and the copies had drifted apart in four ways you could see on screen. One
  number in particular: the site said "10,648 managers" for a quarter that only
  8,472 actually had, so 2,176 fund pages said the manager had not filed while
  the site insisted everything was loaded. Now counted from the data.

  Two things were caught only by running it for real, which is worth recording:

  1. **A repeat of the 20 August outage was scheduled for 3 September.** The
     monthly job runs the day before the SEC publishes the file covering
     April–June, so it would have rebuilt the dashboard without that quarter and
     then deleted it for 8,866 managers. A new rule — "a quarter may not shrink"
     — stopped it, and we watched it stop it.
  2. **The dashboard was serving a year-old copy of one fund's page.** The
     stored data was correct; the name we give each new version had gone
     backwards to one used before Wednesday's repair, so browsers kept the old
     copy. The name is now derived from the data itself, so it cannot repeat.

  **Still to do:** the same-day job still writes to the dashboard directly. It
  can stop once the SEC publishes the April–June file (about 4 Sept), after
  which the single build has everything and the old "don't lose anything" code
  can be deleted. Then the monthly drill that deletes the dashboard and rebuilds
  it from the kept files, to prove it can be. That last one is the point of the
  whole exercise: "it cannot lose data" stops being a promise and becomes a test.

## Standing promises

- If something is deferred, SCHEDULE IT. The owner should never have to carry a
  reminder for work that was agreed.
