import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkListings, parseSpdx, satisfiable } from './license-policy.mjs';

const policy = {
  allow: ['MIT', 'Apache-2.0', 'Apache-2.0 WITH LLVM-exception'],
  deny: ['GPL-', 'AGPL-', 'LGPL-'],
  exceptions: [{ package: 'caniuse-lite', license: 'CC-BY-4.0' }],
  mustInclude: ['react'],
};
const pkg = (name, license) => ({ name, versions: ['1.0.0'], license, paths: [] });
const listing = (...packages) =>
  packages.reduce((all, p) => ({ ...all, [p.license]: [...(all[p.license] ?? []), p] }), {});
const react = pkg('react', 'MIT');

describe('SPDX expressions', () => {
  it('parses AND, OR, WITH and parentheses', () => {
    expect(parseSpdx('(MIT OR Apache-2.0) AND Apache-2.0 WITH LLVM-exception')).toEqual({
      and: [{ or: ['MIT', 'Apache-2.0'] }, 'Apache-2.0 WITH LLVM-exception'],
    });
  });

  it('accepts a choice of alternatives and rejects malformed input', () => {
    const allowed = (id) => policy.allow.includes(id);
    expect(satisfiable('GPL-3.0-only OR MIT', allowed)).toBe(true);
    expect(satisfiable('GPL-3.0-only AND MIT', allowed)).toBe(false);
    expect(satisfiable('(MIT', allowed)).toBe(false);
    expect(satisfiable('', allowed)).toBe(false);
  });
});

describe('checkListings', () => {
  it('passes permissive shipped packages', () => {
    const shipped = listing(react, pkg('dual', 'MIT OR Apache-2.0'));
    expect(checkListings({ shipped, all: shipped }, policy)).toEqual([]);
  });

  it('rejects a shipped GPL package', () => {
    const shipped = listing(react, pkg('gpl-fixture', 'GPL-3.0-only'));
    expect(checkListings({ shipped, all: shipped }, policy)).toEqual([
      'gpl-fixture@1.0.0 ships under GPL-3.0-only, which is not allowed',
      'gpl-fixture@1.0.0 uses GPL-3.0-only, which is denied',
    ]);
  });

  it('rejects denied licenses in development tools but tolerates other unlisted ones', () => {
    const shipped = listing(react);
    const all = listing(react, pkg('tool', 'AGPL-3.0-or-later'), pkg('docs', 'CC-BY-3.0'));
    expect(checkListings({ shipped, all }, policy)).toEqual([
      'tool@1.0.0 uses AGPL-3.0-or-later, which is denied',
    ]);
  });

  it('honours listed exceptions', () => {
    const shipped = listing(react, pkg('caniuse-lite', 'CC-BY-4.0'));
    expect(checkListings({ shipped, all: shipped }, policy)).toEqual([]);
  });

  it('fails when the walk misses a package it must have seen', () => {
    const shipped = listing(pkg('other', 'MIT'));
    expect(checkListings({ shipped, all: shipped }, policy)).toEqual([
      'react is missing from the shipped listing, so the license walk is incomplete',
    ]);
  });

  it('rejects the self-test fixture only for its GPL package', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../tests/license-gate/npm/gpl.json', import.meta.url), 'utf8'),
    );
    const real = JSON.parse(
      readFileSync(new URL('../license-policy.json', import.meta.url), 'utf8'),
    );
    const violations = checkListings({ shipped: fixture, all: fixture }, real);
    expect(violations.length).toBe(2);
    expect(violations.every((v) => v.startsWith('gpl-fixture@1.0.0'))).toBe(true);
  });
});
