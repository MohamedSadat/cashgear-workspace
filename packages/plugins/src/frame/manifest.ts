// A plugin's manifest (`manifest.json` at its bundle's root; DECISIONS.md, 2026-11-18): what Settings
// reads on the device before sending the bundle, so the person sees the plugin's name, type,
// version and what it reads first. The server checks it again and is the one that decides
// (`plugin.invalid` with the same codes); this reader takes the same rules. No DOM, no network.
import { PLUGIN_FRAME_CONTRACT, PLUGIN_LIMITS, isPluginVersion } from './contract';

export interface PluginManifest {
  contract: typeof PLUGIN_FRAME_CONTRACT;
  /** Dotted lower-case words, at most 64 characters; never `cashgear.*`. */
  type: string;
  /** A whole number from 1. */
  version: number;
  /** 1 to 80 characters each. */
  name: { en: string; ar: string };
  /** At most 300 characters each. */
  description: { en: string; ar: string } | null;
  /** An `.html` file in the bundle; `index.html` when the manifest names none. */
  entry: string;
  /** Whether it asks for a database view's rows. */
  reads: { rows: boolean };
  /** The frame's first height, 48 to 1,200 CSS px; 240 when the manifest names none. */
  height: number;
  /** Slash-menu words, at most 10 of 1 to 30 characters. */
  keywords: string[];
}

/** The server's codes for a bundle it refuses (`plugin.invalid`'s `errors`). */
export type BundleErrorCode =
  | 'manifest.missing'
  | 'manifest.invalid'
  | 'type.reserved'
  | 'entry.missing'
  | 'file.type'
  | 'file.name'
  | 'bundle.tooLarge'
  | 'bundle.zip';

export interface BundleError {
  code: BundleErrorCode;
  /** The manifest field (`name.en`), or the file, it is about. */
  path?: string;
}

export type ManifestRead =
  { ok: true; manifest: PluginManifest } | { ok: false; errors: BundleError[] };

const TYPE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 1 to `max` characters (UTF-16 code units, as the server counts), and when `min` is 1 not only spaces. */
const textOf = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' &&
  value.length >= min &&
  value.length <= max &&
  (min === 0 || /\S/u.test(value));

/**
 * A path inside a bundle as the server takes one: 1 to 200 characters, relative, `/`-separated, no
 * empty, `.` or `..` part, no backslash or colon, no control character (C0, DEL, C1), line or
 * paragraph separator, or lone surrogate.
 */
export function isBundlePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length < 1 || path.length > 200) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes(':')) return false;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029)
      return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = path.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Extensions a bundle may hold, and the type each is served as (the server types by extension). */
export const BUNDLE_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html',
  htm: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain',
  map: 'application/json',
});

/** A file's extension, lower case, or '' for none. */
export const extensionOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** The type a bundle's file is served as, or null when a bundle may not hold it. */
export function bundleTypeOf(path: string): string | null {
  const extension = extensionOf(path);
  return Object.prototype.hasOwnProperty.call(BUNDLE_TYPES, extension)
    ? BUNDLE_TYPES[extension]!
    : null;
}

/**
 * The manifest's JSON, read by the rules: every field checked, unknown fields left out. Each
 * problem is listed (`manifest.invalid` with the field's path, `type.reserved` for `cashgear.*`).
 */
export function parseManifest(value: unknown): ManifestRead {
  const errors: BundleError[] = [];
  const invalid = (path: string) => errors.push({ code: 'manifest.invalid', path });
  if (!isObject(value)) return { ok: false, errors: [{ code: 'manifest.invalid' }] };

  if (value.contract !== PLUGIN_FRAME_CONTRACT) invalid('contract');

  const type = value.type;
  if (typeof type !== 'string' || type.length > 64 || !TYPE.test(type)) invalid('type');
  else if (type.startsWith('cashgear.')) errors.push({ code: 'type.reserved', path: 'type' });

  if (!isPluginVersion(value.version)) invalid('version');

  const name = value.name;
  if (!isObject(name)) invalid('name');
  else
    for (const language of ['en', 'ar'] as const)
      if (!textOf(name[language], 1, 80)) invalid(`name.${language}`);

  const description = value.description;
  if (description !== undefined && description !== null) {
    if (!isObject(description)) invalid('description');
    else
      for (const language of ['en', 'ar'] as const)
        if (!textOf(description[language], 0, 300)) invalid(`description.${language}`);
  }

  const entry = value.entry === undefined ? 'index.html' : value.entry;
  if (!isBundlePath(entry) || !['html', 'htm'].includes(extensionOf(entry))) invalid('entry');

  const reads = value.reads;
  if (reads !== undefined && reads !== null) {
    if (!isObject(reads)) invalid('reads');
    else if (reads.rows !== undefined && typeof reads.rows !== 'boolean') invalid('reads.rows');
  }

  const height = value.height === undefined ? PLUGIN_LIMITS.defaultHeight : value.height;
  if (
    typeof height !== 'number' ||
    !Number.isInteger(height) ||
    height < PLUGIN_LIMITS.minHeight ||
    height > PLUGIN_LIMITS.maxHeight
  )
    invalid('height');

  const keywords = value.keywords === undefined ? [] : value.keywords;
  if (
    !Array.isArray(keywords) ||
    keywords.length > 10 ||
    !keywords.every((word) => textOf(word, 1, 30))
  )
    invalid('keywords');

  if (errors.length) return { ok: false, errors };
  const names = name as Record<string, string>;
  const descriptions = isObject(description) ? (description as Record<string, string>) : null;
  return {
    ok: true,
    manifest: {
      contract: PLUGIN_FRAME_CONTRACT,
      type: type as string,
      version: value.version as number,
      name: { en: names.en!, ar: names.ar! },
      description: descriptions ? { en: descriptions.en!, ar: descriptions.ar! } : null,
      entry: entry as string,
      reads: { rows: isObject(reads) && reads.rows === true },
      height: height as number,
      keywords: [...(keywords as string[])],
    },
  };
}
