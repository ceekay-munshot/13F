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
