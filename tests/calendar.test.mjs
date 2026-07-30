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
});
