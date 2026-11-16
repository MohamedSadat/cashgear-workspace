// What an import takes (DECISIONS.md, 2026-11-16: on the device, at most 2,000 pages and 500 MB),
// and the guards against a hostile archive. Each is checked before anything is written.

/** Pages an import makes at most: pages, databases and rows, the new top page included. */
export const IMPORT_MAX_PAGES = 2000;
/** Bytes an import unpacks at most (every file of it, nested archives' files included). */
export const IMPORT_MAX_BYTES = 500 * 1024 * 1024;
/** Files an archive may hold (each costs a little to list and check, read or not). */
export const IMPORT_MAX_FILES = 20_000;
/** An entry unpacking to more than this many times its packed size, past 1 MB, is a zip bomb. */
export const IMPORT_MAX_RATIO = 1000;
export const IMPORT_RATIO_FLOOR = 1024 * 1024;
/** Archives inside the archive (Notion's parts) are read this deep. */
export const IMPORT_MAX_NESTED_ZIPS = 2;
/** A path with more parts than this is not read. */
export const IMPORT_MAX_PATH_PARTS = 32;
/** Pages nest at most this deep under the top page; deeper ones go at the deepest level. */
export const IMPORT_MAX_PAGE_DEPTH = 24;
/** A file the server takes at most (AssetTypes.MaxBytes). */
export const IMPORT_MAX_ASSET_BYTES = 25 * 1024 * 1024;
/** An image larger than this on a side, or in pixels, is not taken (a decompression bomb). */
export const IMPORT_MAX_IMAGE_SIDE = 16_384;
export const IMPORT_MAX_IMAGE_PIXELS = 100_000_000;
/** A CSV of a database is read up to this size (the CSV import's own limit). */
export const IMPORT_MAX_CSV_BYTES = 20 * 1024 * 1024;
