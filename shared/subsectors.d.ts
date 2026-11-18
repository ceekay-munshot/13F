// Types for shared/subsectors.mjs, which the dashboard imports.
export declare const SUBSECTORS: readonly string[];
export declare const SUBSECTOR_SECTOR: Readonly<Record<string, string>>;
export declare const OTHER_FUNDS: string;
export declare function otherSubsector(sector: string): string;
export declare function inSector(sub: string | null | undefined, sector: string): boolean;
export declare function subsectorForSic(sic: number | string | null | undefined): string;
export declare function subsectorByTicker(ticker: string | null | undefined, sector: string): string | null;
export declare function fundKind(row?: { ticker?: string | null; name?: string | null; cls?: string | null }): string | null;
export declare const SUBSECTORS_KEY: string;
