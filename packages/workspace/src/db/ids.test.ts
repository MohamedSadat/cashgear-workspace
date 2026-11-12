import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256, utf8 } from './hash';
import { derivedOption, isOptionId, isPropertyId, newOptionId, newPropertyId } from './ids';
import { expectedOption } from './vectors/fixtures';

describe('property and option ids', () => {
  it('are 8 base-62 characters, all digits used, rarely equal', () => {
    const ids = Array.from({ length: 4000 }, (_, i) => (i % 2 ? newPropertyId() : newOptionId()));
    expect(ids.every((id) => /^[0-9A-Za-z]{8}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    const seen = new Set(ids.join(''));
    expect(seen.size).toBe(62);
  });

  it('are told apart from other text', () => {
    expect(isPropertyId('title')).toBe(true);
    expect(isPropertyId('Ab12Cd34')).toBe(true);
    expect(isPropertyId('Ab12Cd3')).toBe(false);
    expect(isPropertyId('Ab12Cd3!')).toBe(false);
    expect(isOptionId('title')).toBe(false);
    expect(isOptionId(newOptionId())).toBe(true);
    expect(isOptionId(12345678)).toBe(false);
  });
});

describe('SHA-256', () => {
  it('matches Node for every length around the block edges and random input', () => {
    for (let n = 0; n < 200; n++) {
      const bytes = randomBytes(n);
      expect(Buffer.from(sha256(bytes)).toString('hex')).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
    }
    expect(Buffer.from(sha256(utf8('abc'))).toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const big = randomBytes(100_000);
    expect(Buffer.from(sha256(big)).toString('hex')).toBe(
      createHash('sha256').update(big).digest('hex'),
    );
  });
});

describe('derived options', () => {
  it('are the same for the same input and differ by database, property and name', () => {
    const a = derivedOption('db', 'prop', 'Done');
    expect(derivedOption('db', 'prop', 'Done')).toEqual(a);
    expect(derivedOption('db2', 'prop', 'Done').id).not.toBe(a.id);
    expect(derivedOption('db', 'prop2', 'Done').id).not.toBe(a.id);
    expect(derivedOption('db', 'prop', 'done').id).not.toBe(a.id);
    expect(a).toEqual(expectedOption('db', 'prop', 'Done'));
    expect(isOptionId(a.id)).toBe(true);
  });

  it('step past ids already taken', () => {
    const first = derivedOption('db', 'prop', 'Done');
    const second = derivedOption('db', 'prop', 'Done', new Set([first.id]));
    expect(second.id).not.toBe(first.id);
    expect(second).toEqual(expectedOption('db', 'prop', 'Done', 1));
    const third = derivedOption('db', 'prop', 'Done', new Set([first.id, second.id]));
    expect(third).toEqual(expectedOption('db', 'prop', 'Done', 2));
  });

  it('read names as UTF-8, Arabic and astral characters included', () => {
    for (const name of ['مكتمل', '😀 done', 'é', 'é'])
      expect(derivedOption('d', 'p', name)).toEqual(expectedOption('d', 'p', name));
  });
});
