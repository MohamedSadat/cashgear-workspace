import { describe, expect, it } from 'vitest';
import { ar } from './ar';
import { flatten } from './catalogue';
import { en } from './en';

const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe('catalogues', () => {
  const english = flatten(en);
  const arabic = flatten(ar);

  it('have the same keys', () => {
    expect([...arabic.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it('have no empty text', () => {
    for (const [key, text] of [...english, ...arabic]) expect(text.trim(), key).not.toBe('');
  });

  it('use the same placeholders in both languages', () => {
    for (const [key, text] of english)
      expect(placeholders(arabic.get(key)!), key).toEqual(placeholders(text));
  });

  it('translate every Arabic string that is not a proper name', () => {
    // A string with Latin letters in the Arabic catalogue is untranslated, except these, which
    // name a language, a product or a file format in its own script.
    const allowed = new Set([
      'language.en',
      'editor.linkInvalid',
      'editor.bookmarkInvalid',
      'search.shortcut',
    ]);
    for (const [key, text] of arabic) {
      if (allowed.has(key) || key.startsWith('keywords.')) continue;
      expect(/[A-Za-z]/.test(text.replace(/\{\{\w+\}\}/g, '')), `${key}: ${text}`).toBe(false);
    }
  });
});
