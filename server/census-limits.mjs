// Production inventory and release tools share the same bounded source scope.
// The derived SQLite file includes indexes, so its byte ceiling is independent
// of any single network's canonical journal. Restores remain streamed.
// 24m stays below the exact-key table's next doubling at 25,165,825 rows.
// Physical disk/memory admission and independent byte ceilings still apply.
export const CENSUS_MAX_POOLS = 24_000_000;
export const CENSUS_MAX_JOURNAL_BYTES = 16 * 1024 ** 3;
export const POOL_INDEX_MAX_DATABASE_BYTES = 32 * 1024 ** 3;
export const POOL_INDEX_MAX_COMPRESSED_BYTES = 8 * 1024 ** 3;
