// tests/calendar.test.mjs
//
// Filing deadlines are computed, never hardcoded. These expectations are taken
// verbatim from SEC FAQ Question 25 (updated 2026-03-06) for 2026-2028, and
// derived empirically from peak filing volume in master.idx for 2025 (the FAQ
// no longer lists those years).
//
// The cases that matter are the ones where +45 days is NOT the answer.

import { describe, it, expect } from "vitest";
import {
  filingDeadline,
  priorPeriod,
  shiftPeriod,
  periodLabel,
  recentPeriods,
  latestFiledPeriod,
  filingSeason,
  federalHolidays,
  deraWindowFor,
} from "../shared/calendar.mjs";

describe("filingDeadline — quoted from SEC FAQ Q25", () => {
  const cases = [
    ["2026-03-31", "2026-05-15"], // Friday, no roll
    ["2026-06-30", "2026-08-14"], // Friday, no roll
    ["2026-09-30", "2026-11-16"], // day 45 is Saturday -> Monday
    ["2026-12-31", "2027-02-16"], // Sunday -> Presidents' Day Mon -> Tuesday
    ["2027-03-31", "2027-05-17"], // Saturday -> Monday
    ["2027-06-30", "2027-08-16"], // Saturday -> Monday
    ["2027-09-30", "2027-11-15"], // Sunday -> Monday
    ["2027-12-31", "2028-02-14"], // Monday, and NOT Presidents' Day that year
    ["2028-03-31", "2028-05-15"],
    ["2028-06-30", "2028-08-14"],
  ];
  for (const [period, due] of cases) {
    it(`${period} -> ${due}`, () => {
      expect(filingDeadline(period)).toBe(due);
    });
  }
});

describe("filingDeadline — 2025, derived from observed peak filing volume", () => {
  const cases = [
    ["2024-12-31", "2025-02-14"], // 1,830 13F-HR landed this day
    ["2025-03-31", "2025-05-15"], // 1,609
    ["2025-06-30", "2025-08-14"], // 1,751
    ["2025-09-30", "2025-11-14"], // 1,731
    ["2025-12-31", "2026-02-17"], // 1,589
  ];
  for (const [period, due] of cases) {
    it(`${period} -> ${due}`, () => {
      expect(filingDeadline(period)).toBe(due);
    });
  }

  // The single most instructive case in the whole calendar. Day 45 is Saturday
  // 2026-02-14; 2026-02-16 is Presidents' Day; the real deadline is 2026-02-17,
  // and 1,589 filings landed on it. A pipeline that hardcoded "February 14"
  // would have missed the biggest day of the quarter entirely.
  it("4Q-2025 rolls past BOTH the weekend and Presidents' Day", () => {
    expect(filingDeadline("2025-12-31")).toBe("2026-02-17");
    const holidays = federalHolidays(2026);
    expect(holidays.has("2026-02-16")).toBe(true); // 3rd Monday of February
  });
});

describe("federalHolidays", () => {
  it("computes floating holidays correctly for 2026", () => {
    const h = federalHolidays(2026);
    expect(h.has("2026-01-19")).toBe(true); // MLK — 3rd Monday Jan
    expect(h.has("2026-02-16")).toBe(true); // Washington's Birthday
    expect(h.has("2026-05-25")).toBe(true); // Memorial Day — last Monday May
    expect(h.has("2026-09-07")).toBe(true); // Labor Day — 1st Monday Sep
    expect(h.has("2026-11-26")).toBe(true); // Thanksgiving — 4th Thursday Nov
  });

  it("omits Juneteenth before it became federal in 2021", () => {
    expect(federalHolidays(2019).has("2019-06-19")).toBe(false);
    expect(federalHolidays(2025).has("2025-06-19")).toBe(true);
  });
});

describe("period arithmetic", () => {
  it("priorPeriod steps one CALENDAR quarter, never 'the previous row'", () => {
    expect(priorPeriod("2026-06-30")).toBe("2026-03-31");
    expect(priorPeriod("2026-03-31")).toBe("2025-12-31");
    expect(priorPeriod("2026-12-31")).toBe("2026-09-30");
  });

  it("shiftPeriod crosses year boundaries in both directions", () => {
    expect(shiftPeriod("2026-03-31", -4)).toBe("2025-03-31");
    expect(shiftPeriod("2025-12-31", 3)).toBe("2026-09-30");
  });

  it("recentPeriods returns the 8-quarter retention window", () => {
    const p = recentPeriods("2026-06-30", 8);
    expect(p).toHaveLength(8);
    expect(p[0]).toBe("2026-06-30");
    expect(p[7]).toBe("2024-09-30");
  });

  it("periodLabel formats for the quarter stepper", () => {
    expect(periodLabel("2026-06-30")).toBe("Q2 2026");
    expect(periodLabel("2025-12-31")).toBe("Q4 2025");
  });
});

describe("latestFiledPeriod — the 45-day lag made explicit", () => {
  it("does not advance to a quarter whose filings have not been filed yet", () => {
    // 2026-07-15: Q2 has ENDED but is not due until 2026-08-14, so almost
    // nothing exists. Defaulting the dashboard to Q2 here would show an empty
    // screen; Q1 is the newest period with real data.
    expect(latestFiledPeriod("2026-07-15")).toBe("2026-03-31");
  });

  it("advances once the deadline passes", () => {
    expect(latestFiledPeriod("2026-08-20")).toBe("2026-06-30");
  });
});

describe("filingSeason — drives cron density and watchdog thresholds", () => {
  it("flags the deadline window as peak", () => {
    expect(filingSeason("2026-08-14").season).toBe("peak");
    expect(filingSeason("2026-08-13").season).toBe("peak");
    expect(filingSeason("2026-08-16").season).toBe("peak");
  });

  it("flags the run-up as ramp and the aftermath as tail", () => {
    expect(filingSeason("2026-08-05").season).toBe("ramp");
    expect(filingSeason("2026-08-25").season).toBe("tail");
  });

  it("treats T-16 as ramp, not quiet — a third of filings are already in by then", () => {
    // Observed on 2026-07-29, sixteen days before the 2026-08-14 deadline:
    // 3,192 Q2-2026 filings had already been published, of an eventual ~9,300.
    const s = filingSeason("2026-07-29");
    expect(s.daysToDeadline).toBe(16);
    expect(s.season).toBe("ramp");
  });

  it("flags a freshly-closed quarter as quiet — doing nothing is correct then", () => {
    expect(filingSeason("2026-07-05").season).toBe("quiet");
  });
});

describe("deraWindowFor", () => {
  it("maps a filing date to its quarterly data-set window", () => {
    // Measured: the 01mar2026-31may2026 set has Last-Modified 2026-06-04,
    // about four days after its window closed. DERA is the reconciliation
    // backstop, not the day-of feed.
    const w = deraWindowFor("2026-05-15");
    expect(w.slug).toBe("01mar2026-31may2026");
    expect(w.url).toContain("form-13f-data-sets/01mar2026-31may2026_form13f.zip");
  });

  // -------------------------------------------------------------------------
  // The year boundary. Dec-Jan-Feb is the only window that straddles one, and
  // which two years it spans depends on which of its three months you are in.
  // Anchoring all three on `y - 1` sent every DECEMBER date to a window a full
  // year stale — 2025-12-15 resolved to 01dec2024-28feb2025 — so a walk-back
  // that crossed a December silently pulled an 18-month-old data set and
  // produced non-contiguous quarters.
  // -------------------------------------------------------------------------
  it("maps December to the window that OPENS that December, not last year's", () => {
    expect(deraWindowFor("2025-12-01").slug).toBe("01dec2025-28feb2026");
    expect(deraWindowFor("2025-12-31").slug).toBe("01dec2025-28feb2026");
  });

  it("maps January and February to the window opened the PREVIOUS December", () => {
    expect(deraWindowFor("2026-01-15").slug).toBe("01dec2025-28feb2026");
    expect(deraWindowFor("2026-02-28").slug).toBe("01dec2025-28feb2026");
  });

  it("puts all three winter months in the SAME window", () => {
    const dec = deraWindowFor("2025-12-15").slug;
    expect(deraWindowFor("2026-01-15").slug).toBe(dec);
    expect(deraWindowFor("2026-02-15").slug).toBe(dec);
  });

  it("ends the winter window on Feb 29 in a leap year", () => {
    expect(deraWindowFor("2023-12-15").slug).toBe("01dec2023-29feb2024");
    expect(deraWindowFor("2024-12-15").slug).toBe("01dec2024-28feb2025");
  });

  it("assigns every month of a year to exactly one window", () => {
    // A CALENDAR year touches FIVE windows, not four: the winter window
    // straddles the boundary, so January/February belong to the one that opened
    // last December while December belongs to the one opening next.
    const byMonth = [];
    for (let m = 1; m <= 12; m++) {
      const w = deraWindowFor(`2026-${String(m).padStart(2, "0")}-15`);
      expect(w).not.toBeNull();
      byMonth.push(w.slug);
    }
    expect(new Set(byMonth).size).toBe(5);
    expect(byMonth[0]).toBe(byMonth[1]);          // Jan and Feb together
    expect(byMonth[11]).not.toBe(byMonth[0]);     // December is NOT with them
    expect(byMonth[11]).toBe("01dec2026-28feb2027");

    // Consecutive months either stay in the same window or advance to the next,
    // and every window runs exactly three months — no gap, no overlap.
    const runs = byMonth.reduce((acc, s) => (acc.at(-1)?.[0] === s ? (acc.at(-1).push(s), acc) : [...acc, [s]]), []);
    expect(runs.map((r) => r.length)).toEqual([2, 3, 3, 3, 1]); // Jan-Feb … Dec
  });

  // -------------------------------------------------------------------------
  // WHICH WINDOW COVERS A QUARTER.
  //
  // Windows are keyed by FILING date, quarters by period end, and the ingest
  // needs to know whether it holds the data for a quarter at all. The answer is
  // the window containing that quarter's DEADLINE — which is where essentially
  // every filing for it lands.
  //
  // Getting this wrong is not a blank quarter, it is a WRONG one: the handful
  // of stragglers and late amendments that did fall inside a loaded window get
  // published as though they were the book. Berkshire's 2025-Q1 shipped as
  // $1.1B across 4 positions against a real ~$263B across ~40, and the quarter
  // after it then diffed against that stub and reported a 23,000% move.
  // -------------------------------------------------------------------------
  it("maps each quarter to the window holding its filing deadline", () => {
    const covering = (period) => deraWindowFor(filingDeadline(period)).slug;
    expect(covering("2026-03-31")).toBe("01mar2026-31may2026"); // due 15 May 2026
    expect(covering("2025-12-31")).toBe("01dec2025-28feb2026"); // due 17 Feb 2026
    expect(covering("2025-09-30")).toBe("01sep2025-30nov2025"); // due 14 Nov 2025
    expect(covering("2025-06-30")).toBe("01jun2025-31aug2025"); // due 14 Aug 2025
    expect(covering("2025-03-31")).toBe("01mar2025-31may2025"); // due 15 May 2025
  });

  it("gives each of the four quarters a DISTINCT covering window", () => {
    // If two quarters shared one, loading N windows would not yield N quarters
    // and the retention target could never be met.
    const periods = ["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"];
    const slugs = periods.map((p) => deraWindowFor(filingDeadline(p)).slug);
    expect(new Set(slugs).size).toBe(4);
  });

  it("marks a quarter uncovered when its window was not loaded", () => {
    // The exact check the ingest makes. A four-window run from mid-2026 covers
    // Q2 2025 through Q1 2026 and must reject Q1 2025 — which is precisely the
    // quarter that produced the Berkshire fragment.
    const loaded = new Set([
      "01mar2026-31may2026", "01dec2025-28feb2026",
      "01sep2025-30nov2025", "01jun2025-31aug2025",
    ]);
    const covers = (p) => loaded.has(deraWindowFor(filingDeadline(p)).slug);
    expect(covers("2026-03-31")).toBe(true);
    expect(covers("2025-06-30")).toBe(true);
    expect(covers("2025-03-31")).toBe(false);
    expect(covers("2024-12-31")).toBe(false);
  });

  it("walks back far enough to reach the requested number of windows", () => {
    // The ingest passes --windows=4. Windows are 3 months wide and the newest
    // is usually unpublished, so a flat 8-month walk (what shipped) reached at
    // most 4 candidates including the dead one, and --windows=4 could never be
    // satisfied. Depth is now derived: max(15, 3N + 6).
    const depthFor = (want) => Math.max(15, want * 3 + 6);
    const reach = (todayISO, want) => {
      const seen = new Set();
      for (let i = 0; i < depthFor(want); i++) {
        const d = new Date(todayISO);
        d.setUTCMonth(d.getUTCMonth() - i);
        const w = deraWindowFor(d.toISOString().slice(0, 10));
        if (w) seen.add(w.slug);
      }
      return seen.size;
    };
    for (const today of ["2026-07-31", "2025-12-15", "2026-01-05", "2026-03-01"]) {
      expect(reach(today, 4)).toBeGreaterThan(4); // > 4 so one may 404
    }
  });
});
