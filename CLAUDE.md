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

- **Saturday 15 Aug 2026** — make the same-day ingest fetch only NEW filings
  (key on the filing's accession number, keep a cursor between runs). Scheduled
  to run on its own; the owner should not have to ask. This is the real cure for
  the SEC intermittently refusing us — everything shipped on 13 Aug is
  protection around the problem, not the fix for it.

## Standing promises

- If something is deferred, SCHEDULE IT. The owner should never have to carry a
  reminder for work that was agreed.
