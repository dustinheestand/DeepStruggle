/**
 * What this build of the page is, written in by vite.config.ts: the git commit it was built from
 * (and whether the tree had uncommitted changes), and the stats database's endpoint
 * (TS_STATS_ENDPOINT at build time; empty: games can be downloaded but not submitted).
 */
export const BUILD_COMMIT: string = import.meta.env.VITE_TS_BUILD_COMMIT ?? "";
export const BUILD_DIRTY: boolean = import.meta.env.VITE_TS_BUILD_DIRTY === "1";
export const STATS_ENDPOINT: string = import.meta.env.VITE_TS_STATS_ENDPOINT ?? "";
/** The play relay (TS_PLAY_ENDPOINT at build time; empty: no online game against a friend). */
export const PLAY_ENDPOINT: string = import.meta.env.VITE_TS_PLAY_ENDPOINT ?? "";
