// plugin-frame.1's shared vectors (packages/plugins/vectors/plugin-frame-vectors.json), which a
// plugin's author, and the server for the manifest and the bundle, can run too. The cases are in
// ./vectors.cases.ts; this test checks the file holds exactly those (rewrite it with
// `PLUGIN_VECTORS_WRITE=1`, then Prettier on it) and runs every vector read from the file
// through the validators, as sent and after a structured clone.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PLUGIN_FRAME_CONTRACT,
  checkProps,
  parseHostMessage,
  parsePluginMessage,
} from './contract';
import { BUNDLE_TYPES, bundleTypeOf, isBundlePath, parseManifest } from './manifest';
import {
  decodeVector as decode,
  pluginFrameVectors,
  type PluginFrameVectors,
} from './vectors.cases';

const WRITE = process.env.PLUGIN_VECTORS_WRITE === '1';
const FILE = new URL('../../vectors/plugin-frame-vectors.json', import.meta.url);

if (WRITE) writeFileSync(FILE, JSON.stringify(pluginFrameVectors, null, 2) + '\n');
const onDisk = JSON.parse(readFileSync(FILE, 'utf8')) as PluginFrameVectors;

describe('plugin-frame-vectors.json', () => {
  it('holds the cases as written', () => {
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(pluginFrameVectors)));
  });

  it('names the contract, has enough cases, and names each once', () => {
    expect(onDisk.contract).toBe(PLUGIN_FRAME_CONTRACT);
    expect(onDisk.host.length + onDisk.plugin.length).toBeGreaterThanOrEqual(150);
    for (const list of [
      onDisk.host,
      onDisk.plugin,
      onDisk.props,
      onDisk.manifest,
      onDisk.bundlePaths,
    ])
      expect(new Set(list.map((v) => v.name)).size).toBe(list.length);
  });

  it('keeps "__proto__" keys as own properties when decoded', () => {
    const polluted = onDisk.host.find((v) => v.name === 'init: an own "__proto__" key')!;
    const decoded = decode(polluted.message) as object;
    expect(Object.keys(decoded)).toContain('__proto__');
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  const suites = [
    ['host', onDisk.host, parseHostMessage],
    ['plugin', onDisk.plugin, parsePluginMessage],
  ] as const;
  for (const [side, vectors, parse] of suites) {
    describe(side, () => {
      for (const vector of vectors) {
        it(`${vector.valid ? 'valid' : 'invalid'}: ${vector.name}`, () => {
          const message = decode(vector.message);
          expect(parse(message) !== null).toBe(vector.valid);
          expect(parse(structuredClone(message)) !== null).toBe(vector.valid);
        });
      }
    });
  }

  describe('props', () => {
    for (const vector of onDisk.props) {
      it(`${vector.verdict}: ${vector.name}`, () => {
        for (const props of [decode(vector.props), structuredClone(decode(vector.props))]) {
          const checked = checkProps(props);
          expect(checked.ok ? 'ok' : checked.code).toBe(vector.verdict);
          if (checked.ok) expect(checked.props).toEqual(decode(vector.kept!));
        }
      });
    }
  });

  describe('manifest', () => {
    for (const vector of onDisk.manifest) {
      it(`${vector.valid ? 'valid' : 'invalid'}: ${vector.name}`, () => {
        const read = parseManifest(decode(vector.manifest));
        expect(read.ok).toBe(vector.valid);
        if (!read.ok) expect(read.errors).toEqual(vector.errors);
      });
    }
  });

  describe('bundle paths and types', () => {
    for (const vector of onDisk.bundlePaths)
      it(`${vector.valid ? 'valid' : 'invalid'}: ${vector.name}`, () => {
        expect(isBundlePath(vector.path)).toBe(vector.valid);
      });
    it('types files by extension, and refuses the rest', () => {
      for (const vector of onDisk.bundleTypes)
        expect(bundleTypeOf(vector.path), vector.path).toBe(vector.contentType);
      expect(Object.keys(BUNDLE_TYPES).sort()).toEqual(
        [...new Set(onDisk.bundleTypes.map((v) => v.path.split('.').pop()!.toLowerCase()))]
          .filter((e) => bundleTypeOf(`x.${e}`) !== null)
          .sort(),
      );
    });
  });
});
