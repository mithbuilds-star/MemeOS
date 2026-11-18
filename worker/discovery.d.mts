export declare const SCRAPE_PAGE: number;
export declare const MAX_BACKFILL_PAGES: number;
export declare const OVERLAP_MS: number;
export declare function discoveryIdentity(item: any): { key: string | null; shortcode: string | null; permalink: string | null; legacyIds: string[] };
export declare function dedupeOrClause(identity: { key: string | null; shortcode: string | null; legacyIds: string[] }): string | null;
export declare function classifyPage(items: any[], window: { newerThan: number | null; olderThan: number | null }, opts: { parseTs: (item: any) => number | null }): any;
export declare function planAdvance(phase: "newest" | "incremental" | "backfill" | "reanchor", source: any, page: any, jobCreatedMs: number): any;
