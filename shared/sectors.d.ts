// Types for shared/sectors.mjs, which the dashboard imports.
export declare const FUNDS: string;
export declare const UNCLASSIFIED: string;
export declare function normTicker(t: string | null | undefined): string;
export declare function normName(n: string | null | undefined): string;
export declare function looksLikeFund(name?: string | null, cls?: string | null): boolean;
export declare function createSectorLookup(
  map: Record<string, string> | null | undefined,
  opts?: { names?: Record<string, string> | null },
): (row?: { ticker?: string | null; name?: string | null; cls?: string | null }) => string;
