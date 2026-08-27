// Type surface for shared/watchlist.mjs — see that file for why the list lives
// in shared/ rather than in the frontend.

export interface WatchFund {
  cik: string;
  /** Short label for matrix columns. Kept to 3 characters and unique. */
  code: string;
  /** Display name, shortened where the filed name is unwieldy. */
  label: string;
}

export declare const CLIENT_WATCHLIST: WatchFund[];
export declare const WATCHLIST_CIKS: string[];

/**
 * Managers whose 13F reporting moved to another entity, old CIK -> new CIK.
 * See the source file for the evidence required before adding one.
 */
export declare const SUCCEEDED_BY: Record<string, string>;

/** A saved list of CIKs with superseded ones moved on, order preserved. */
export declare function migrateCiks(ciks: unknown): string[];
