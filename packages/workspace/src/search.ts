// Text normalisation for search (D25): the same function runs before indexing and before
// querying, in the browser index, the desktop's FTS5 and (Phase 2) the server, with shared test
// vectors (search-vectors.json), so search behaves the same everywhere.
//
//   - Unicode NFKD (presentation forms and ligatures such as ﻻ unfold), then every combining mark
//     removed: Arabic tashkeel, the hamza and madda split off alef, waw and ya, Latin accents.
//   - Tatweel removed. Alef forms already unified by the step above; ٱ (wasla) to ا.
//   - ى and ی to ي; ة to ه.
//   - Arabic-Indic and Persian digits to 0-9.
//   - Lower case; any run of non-letters and non-digits becomes one space.

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

export function normaliseText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/ـ/g, '')
    .replace(/ٱ/g, 'ا')
    .replace(/[ىی]/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The words of normalised text. */
export const searchTerms = (normalised: string): string[] =>
  normalised.split(' ').filter((term) => term.length > 0);

/**
 * A short run of `text` around the first place a term matches, for result lists. Works on the
 * original text, so it reads as written; matching uses the normalised form of each word.
 */
export function snippet(text: string, normalisedQuery: string, width = 120): string {
  const terms = searchTerms(normalisedQuery);
  if (!terms.length || !text) return '';
  const words = text.split(/(\s+)/);
  let offset = 0;
  for (const word of words) {
    const folded = normaliseText(word);
    if (folded && terms.some((term) => folded.startsWith(term) || folded.includes(term))) {
      const start = Math.max(0, offset - Math.floor(width / 3));
      const end = Math.min(text.length, start + width);
      return (
        (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '')
      );
    }
    offset += word.length;
  }
  return '';
}
