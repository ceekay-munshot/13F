// Types for shared/calendar.mjs, which is plain JS so that scripts/*.mjs (Node)
// and functions/**/*.js (Workers) can import the same implementation the
// frontend uses. One source of truth for deadline arithmetic beats three.

export function parseISO(iso: string): Date;
export function toISO(date: Date): string;
export function addDays(date: Date, n: number): Date;
export function federalHolidays(year: number): Set<string>;
export function isBusinessDay(date: Date): boolean;
export function rollForward(date: Date): Date;
export function quarterEnd(year: number, q: 1 | 2 | 3 | 4): string;
export function quarterOf(iso: string): number;
export function periodLabel(iso: string): string;
export function isQuarterEnd(iso: string): boolean;
export function shiftPeriod(iso: string, n: number): string;
export function priorPeriod(iso: string): string;
export function filingDeadline(periodEndISO: string): string;
export function currentPeriod(todayISO: string): string;
export function latestFiledPeriod(todayISO: string): string;
export function recentPeriods(endISO: string, n: number): string[];

export interface FilingSeason {
  period: string;
  deadline: string;
  daysToDeadline: number;
  season: "quiet" | "ramp" | "peak" | "tail";
}
export function filingSeason(todayISO: string): FilingSeason;

export function deraWindowFor(filingDateISO: string): { slug: string; url: string } | null;
