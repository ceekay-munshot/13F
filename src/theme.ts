// src/theme.ts
//
// Design tokens from the Munshot embedded-dashboard UI standards (light theme),
// plus the categorical palettes this product needs.

/** UI chrome — the only colors used for shell, cards and text. */
export const t = {
  primary: "#4f46e5",
  primaryLight: "#eef2ff",
  primaryBorder: "#e0e7ff",
  primaryText: "#4338ca",
  pageBg: "linear-gradient(to bottom, rgba(249,250,251,0.8), #ffffff)",
  cardBg: "rgba(255,255,255,0.9)",
  cardHeader: "rgba(255,255,255,0.95)",
  cardBodyBg: "rgba(249,250,251,0.5)",
  headerBar: "rgba(255,255,255,0.95)",
  border: "rgba(229,231,235,0.8)",
  borderSolid: "#e5e7eb",
  borderHover: "rgba(79,70,229,0.2)",
  textPrimary: "#111827",
  textSecondary: "#374151",
  textMuted: "#6b7280",
  textHint: "#9ca3af",
  errorRed: "#ef4444",
  errorBg: "#fef2f2",
  warnAmber: "#d97706",
  warnBg: "#fffbeb",
  warnBorder: "#fde68a",
  gridline: "#eef0f2",
} as const;

export const font =
  'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/** House interaction token. */
export const transition = "all 0.35s cubic-bezier(0.4, 0, 0.2, 1)";

/** Strong ease-out. The built-in CSS easings are too weak to read as intentional. */
export const easeOut = "cubic-bezier(0.23, 1, 0.32, 1)";

/**
 * Position-change semantics. Deliberate choices:
 *
 *  - TRIMMED is AMBER, not red. Reducing a position is not selling it, and
 *    painting it red makes a routine rebalance read as an exit.
 *  - NEW is the indigo primary, because "what did they just buy" is the single
 *    thing this dashboard exists to surface.
 *  - HELD is grey and deliberately quiet — most rows are HELD, and coloring
 *    them would drown the signal.
 */
export const ACTION_COLORS = {
  NEW: "#4f46e5",
  ADDED: "#059669",
  HELD: "#9ca3af",
  TRIMMED: "#d97706",
  EXITED: "#ef4444",
} as const;

export type Action = keyof typeof ACTION_COLORS;

export const ACTION_GLYPH: Record<Action, string> = {
  NEW: "★",
  ADDED: "▲",
  HELD: "▪",
  TRIMMED: "▼",
  EXITED: "✕",
};

/**
 * Fund column colors for the consensus matrix. Color follows the ENTITY, never
 * its rank — a fund keeps its color when the sort changes, which is what makes
 * the matrix scannable across re-sorts.
 *
 * Validated for CVD adjacency on the light surface; assigned by watchlist
 * position so a given set is stable across sessions.
 */
export const FUND_PALETTE = [
  "#4f46e5", // indigo
  "#2a78d6", // blue
  "#008300", // green
  "#e87ba4", // magenta
  "#eda100", // yellow
  "#1baf7a", // aqua
  "#eb6834", // orange
  "#7c3aed", // violet
  "#0d9488", // teal
  "#be123c", // crimson
] as const;

export function fundColor(index: number): string {
  return FUND_PALETTE[index % FUND_PALETTE.length];
}

/**
 * The 11 GICS-shaped sector buckets we map SIC divisions into.
 *
 * Labelled "Sector (SIC-derived)" in the UI, never "GICS". The boundaries
 * genuinely differ and an analyst spots a hand-rolled crosswalk within minutes;
 * claiming GICS without a license would be both wrong and a licensing problem.
 */
export const SECTOR_COLORS: Record<string, string> = {
  "Information Technology": "#2a78d6",
  Financials: "#008300",
  "Health Care": "#e87ba4",
  "Consumer Discretionary": "#eda100",
  "Consumer Staples": "#1baf7a",
  Industrials: "#eb6834",
  Energy: "#7c3aed",
  Materials: "#0d9488",
  Utilities: "#be123c",
  "Real Estate": "#4f46e5",
  "Communication Services": "#6b7280",
  Unclassified: "#d1d5db",
};

export function sectorColor(name: string): string {
  return SECTOR_COLORS[name] ?? SECTOR_COLORS.Unclassified;
}
