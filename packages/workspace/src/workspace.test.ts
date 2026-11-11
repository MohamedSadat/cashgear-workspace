import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { idTime, isId, uuidv7 } from './ids';
import { MemoryStore } from './memory';
import { compareSiblings, isOrderKey, keyBetween, keysBetween } from './order';
import { normaliseText, snippet } from './search';
import { describeLocalStore } from './testing/conformance';

const vectors = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../vectors/${name}`, import.meta.url), 'utf8')) as T;

describe('UUIDv7', () => {
  it('is version 7, variant 10, and sorts by time', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    expect(ids.every(isId)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    const t = Date.now() + 3_600_000;
    expect(idTime(uuidv7(t + 5000))).toBe(t + 5000);
  });
});

describe('order keys', () => {
  it('match the shared vectors', () => {
    for (const [a, b, expected] of vectors<[string | null, string | null, string][]>(
      'order-vectors.json',
    ))
      expect(keyBetween(a, b), `${a} .. ${b}`).toBe(expected);
  });

  it('always fall strictly between, however often one inserts', () => {
    let seed = 7;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const keys = [keyBetween(null, null)];
    for (let i = 0; i < 3000; i++) {
      const at = Math.floor(random() * (keys.length + 1));
      const key = keyBetween(keys[at - 1] ?? null, keys[at] ?? null);
      expect(isOrderKey(key)).toBe(true);
      if (at > 0) expect(key > keys[at - 1]).toBe(true);
      if (at < keys.length) expect(key < keys[at]).toBe(true);
      keys.splice(at, 0, key);
    }
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(40);
  });

  it('make runs of keys in order', () => {
    for (const [a, b] of [
      [null, null],
      ['a0', null],
      [null, 'a0'],
      ['a0', 'a1'],
    ] as const) {
      const run = keysBetween(a, b, 25);
      expect(run).toHaveLength(25);
      expect([...run].sort()).toEqual(run);
      if (a) expect(run[0] > a).toBe(true);
      if (b) expect(run[24] < b).toBe(true);
    }
  });

  it('break ties by id', () => {
    const items = [
      { orderKey: 'a1', id: 'b' },
      { orderKey: 'a1', id: 'a' },
      { orderKey: 'a0', id: 'z' },
    ];
    expect(items.sort(compareSiblings).map((i) => i.id)).toEqual(['z', 'a', 'b']);
  });

  it('refuse what is not a key', () => {
    for (const bad of ['', 'a', 'a00', 'b0', '!x', 'a0 '] as const)
      expect(isOrderKey(bad), bad).toBe(false);
    expect(() => keyBetween('a1', 'a0')).toThrow();
  });
});

describe('search normalisation', () => {
  it('matches the shared vectors', () => {
    for (const [input, expected] of vectors<[string, string][]>('search-vectors.json'))
      expect(normaliseText(input), input).toBe(expected);
  });

  it('cuts a snippet around the first match, as written', () => {
    const text = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Le rapport trimestriel.';
    expect(snippet(text, normaliseText('rapport'), 30)).toContain('rapport');
    expect(snippet('بدون تشكيل: المَبيعات اليومية', normaliseText('المبيعات'))).toContain(
      'المَبيعات',
    );
    expect(snippet(text, normaliseText('absent'))).toBe('');
  });
});

describeLocalStore('memory', async () => new MemoryStore());
