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

### Done

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
