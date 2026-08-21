// shared/unfinished.mjs
//
// A register of work a run was supposed to do and did not.
//
// ---------------------------------------------------------------------------
// A STEP THAT DID NOT DO ITS JOB MUST END THE RUN RED.
// ---------------------------------------------------------------------------
// prune spent its ENTIRE existence throwing on its first line — a const read
// from its temporal dead zone — and every run still reported success, because
// the failure was caught and logged as a warning. Nobody reads a warning on a
// green run. It stayed inert until the day it would finally have worked, at
// which point it would have deleted 10,765 fund-quarters; the only reason that
// was survivable is that it was still broken.
//
// The manual repair tool had the same shape: it dispatched with "0 funds
// selected", every gated step skipped itself, and the run reported success
// having done nothing at all.
//
// But failing IMMEDIATELY is the opposite trap, and this project has been bitten
// by that too — an early exit once aborted a publish partway through and left
// the site with no manifest, which is a dead dashboard. Cleanup and bookkeeping
// must never be able to block publication.
//
// So the discipline is: FINISH THE WORK, THEN FAIL. Everything that matters is
// live, and the run is unmistakably red with a list of exactly what did not
// happen.
//
// What belongs in here vs what stays a plain log line:
//
//   IN  — the step's whole purpose did not happen (prune did not run; summaries
//         were not merged; the manifest could not be carried forward).
//   OUT — the step reached its goal by another route (listing the bucket failed
//         so we uploaded everything; a stream aborted and the CDN served it
//         instead). Degradation is not failure.
//   OUT — "there was nothing to do", when doing nothing is a declared outcome.

export function createRegister() {
  const items = [];
  return {
    /** Record that a step did not do its job. Does not throw. */
    note(message) {
      items.push(String(message));
    },
    get length() {
      return items.length;
    },
    list() {
      return [...items];
    },
    /**
     * Print the verdict and return the process exit code.
     *
     * Returns rather than exits so it is testable; callers do the exiting.
     */
    report(label, log = console.log) {
      if (!items.length) return 0;
      log("");
      for (const item of items) log(`::error::${item}`);
      log("");
      log(
        `::error::${label} completed, but ${items.length} step(s) did not do their job. ` +
        `Everything that was published is live and correct; something in the pipeline is not. ` +
        `Do not ignore a red run here — this is the check that would have caught the ` +
        `2026-08-20 outage a month before it reached the dashboard.`,
      );
      return 1;
    },
  };
}
