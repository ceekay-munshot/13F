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

- **Saturday 22 Aug 2026** — the "one big withdrawal, not 27 separate sales"
  detector needs a second piece of evidence. Right now it compares two quarters
  and spots that every holding moved by the same percentage. That is the right
  answer for Cantillon — their own filing confirms it — but the check cannot
  tell a real withdrawal apart from a fund simply changing how it splits its
  holdings across two managers on the form. Both look identical to it. Nobody
  needs to do anything; it is scheduled to run on its own.

### Done

- **18 Aug 2026** — the same-day ingest now fetches only what it has not already
  got, and remembers between runs where it is up to (the "cursor"). This was
  booked for Sat 15 Aug and is now shipped. It also turned out to be the fix for
  a bigger problem: only 13 of the ~10,700 funds that filed for Apr–Jun 2026 had
  reached the dashboard, because the pipeline was misreading "the SEC has not
  published today's list yet" as "the SEC has banned us".

## Standing promises

- If something is deferred, SCHEDULE IT. The owner should never have to carry a
  reminder for work that was agreed.
