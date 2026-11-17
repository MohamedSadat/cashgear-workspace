// Types for embeddings.mjs (Phase 10): the mock embeddings provider's vectors, for specs and benches.

export declare const DIMENSIONS: number;
export declare const MODELS: readonly string[];

/** A word as the lexicon compares it. */
export declare function normalise(word: string): string;

/** The concept a word belongs to, or null. */
export declare function conceptOf(word: string): string | null;

export declare function embedFloat(text: string): Float64Array;

export declare function embedInt8(text: string): number[];

/** The cosine similarity of two texts' int8 vectors, as the server scores them. */
export declare function similarity(a: string, b: string): number;

export declare function tokensOf(text: string): number;
