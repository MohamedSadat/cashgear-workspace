// The element names each schema version knows, shared with the server worker, which refuses a
// pushed update that brings any other element (Q20; server/src/Cgw.Worker, Schema.cs). A new
// node type raises SCHEMA_VERSION and adds a list here; a list is never edited once shipped.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, knownTypes } from './schema';

const file = join(__dirname, '..', 'vectors', 'schema-elements.json');

describe('schema elements shared with the server', () => {
  it('lists every node type of this schema version except the document and text', () => {
    const elements = [...knownTypes().nodes].filter((n) => n !== 'doc' && n !== 'text').sort();
    if (process.env.CGW_WRITE_VECTORS === '1') {
      const all = JSON.parse(readFileSync(file, 'utf8') || '{}') as Record<string, string[]>;
      all[String(SCHEMA_VERSION)] = elements;
      writeFileSync(file, JSON.stringify(all, null, 2) + '\n');
    }
    const shared = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string[]>;
    expect(shared[String(SCHEMA_VERSION)]).toEqual(elements);
  });
});
