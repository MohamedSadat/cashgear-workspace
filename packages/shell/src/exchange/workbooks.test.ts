// Phase 9, M9.3: workbooks in the workspace's export (format version 3). An export reads every
// workbook the exporter may read from the account and writes its newest version beside the pages,
// named once each, its id and name in the manifest; a workbook it could not read is counted, and a
// list it could not read leaves them all out, saying so. An import into the account gives each a
// new id, points every sheet block at it and hands the bytes back to be made there; a local
// import keeps the blocks as they were and counts what it skipped. The reader and the maker over
// the workbook routes.
import { build, PageDocument, fragmentToJSON, type DocJSON } from '@cgw/doc';
import { MemoryStore, SyncHttpError } from '@cgw/workspace';
import { describe, expect, it, vi } from 'vitest';
import { localWorkspace } from '../../../workspace/src/testing/syncHarness';
import { WorkspaceSession } from '../session';
import type { Workbook, WorkbookContent } from '../sheet/api';
import { FORMAT, FORMAT_VERSION, MANIFEST, buildExport, readExportWith } from './exchange';
import { makeWorkbooks, workbookReader } from './workbooks';

const BUDGET = '01936f6e-0000-7000-8000-00000000f001';
const STOCK = '01936f6e-0000-7000-8000-00000000f002';
const XLSX = (n: number) => new Uint8Array([0x50, 0x4b, 3, 4, n]);

const sheetsOf = (json: DocJSON): unknown[] => {
  const out: unknown[] = [];
  const walk = (node: DocJSON) => {
    if (node.type === 'sheetEmbed') out.push(node.attrs?.workbookId);
    node.content?.forEach(walk);
  };
  walk(json);
  return out;
};

/** A local workspace whose first page shows two workbooks, a third page none. */
async function workspace() {
  const store = new MemoryStore();
  const made = await localWorkspace(store);
  const session = await WorkspaceSession.start(store);
  session.switchTo(made.ws.id);
  const { docOf, paragraph, sheetEmbed } = build;
  await session.writeFirstDocument(
    made.a.id,
    made.ws.id,
    docOf(paragraph('Figures'), sheetEmbed(BUDGET, { range: 'A1:C4' }, 300), sheetEmbed(STOCK)),
  );
  return { store, session, ...made };
}

const reader = (failing: string[] = []) =>
  vi.fn(async (wanted: ReadonlySet<string> | null) => ({
    workbooks: [
      { id: BUDGET, name: 'Budget 2026', bytes: XLSX(1) },
      { id: STOCK, name: 'Budget 2026', bytes: XLSX(2) },
    ].filter((w) => (!wanted || wanted.has(w.id)) && !failing.includes(w.id)),
    failed: failing.length,
  }));

describe('workbooks in the export', () => {
  it('writes each workbook read beside the pages, named once, in a version 3 manifest', async () => {
    const { session } = await workspace();
    const workbooks = reader();
    const {
      files,
      manifest,
      workbooks: report,
    } = await buildExport(session, {
      untitled: 'Untitled',
      workbooks,
    });
    expect(FORMAT_VERSION).toBe(3);
    expect(manifest).toMatchObject({ format: FORMAT, version: 3 });
    // A workspace's export asks for every workbook the exporter may read.
    expect(workbooks).toHaveBeenCalledWith(null);
    expect(manifest.workbooks).toEqual([
      { id: BUDGET, name: 'Budget 2026', file: 'workbooks/Budget 2026.xlsx' },
      { id: STOCK, name: 'Budget 2026', file: 'workbooks/Budget 2026 (2).xlsx' },
    ]);
    expect([...files['workbooks/Budget 2026.xlsx']]).toEqual([...XLSX(1)]);
    expect([...files['workbooks/Budget 2026 (2).xlsx']]).toEqual([...XLSX(2)]);
    expect(report).toEqual({ written: 2, failed: 0, unreadable: false });
  });

  it('asks for the workbooks some pages show, counts what it could not read', async () => {
    const { session, a, c } = await workspace();
    const workbooks = reader([STOCK]);
    const { manifest, workbooks: report } = await buildExport(session, {
      untitled: 'Untitled',
      pageIds: [a.id],
      workbooks,
    });
    expect(workbooks).toHaveBeenCalledWith(new Set([BUDGET, STOCK]));
    expect(manifest.workbooks?.map((w) => w.id)).toEqual([BUDGET]);
    expect(report).toEqual({ written: 1, failed: 1, unreadable: false });
    // A page that shows no workbook asks for none.
    const none = reader();
    const other = await buildExport(session, {
      untitled: 'Untitled',
      pageIds: [c.id],
      workbooks: none,
    });
    expect(none).not.toHaveBeenCalled();
    expect(other.manifest.workbooks).toBeUndefined();
  });

  it('goes on without them when the list cannot be read, and says so', async () => {
    const { session } = await workspace();
    const { manifest, workbooks: report } = await buildExport(session, {
      untitled: 'Untitled',
      workbooks: async () => {
        throw new TypeError('offline');
      },
    });
    expect(manifest.workbooks).toBeUndefined();
    expect(manifest.pages.length).toBeGreaterThan(0);
    expect(report).toEqual({ written: 0, failed: 0, unreadable: true });
  });
});

describe('workbooks in an import', () => {
  async function exported() {
    const made = await workspace();
    const { files } = await buildExport(made.session, {
      untitled: 'Untitled',
      workbooks: reader(),
    });
    return { ...made, files };
  }

  async function sheetsOfPage(session: WorkspaceSession, title: string) {
    const page = [...session.mirror.pages.values()].find(
      (p) => p.workspaceId === session.workspaceId && p.title === title,
    )!;
    const doc = await PageDocument.open(page.id, session.store, { canEdit: false });
    const json = fragmentToJSON(doc.fragment);
    await doc.close();
    return sheetsOf(json);
  }

  it('into the account: new ids, every sheet block pointed at them, the bytes handed back', async () => {
    const { session, files } = await exported();
    const result = await readExportWith(session, files, ' (imported)', { workbooks: 'make' });
    expect(result.workspaceId).toBe(session.workspaceId);
    expect(result.skippedWorkbooks).toBe(0);
    expect(result.pendingWorkbooks.map((w) => w.name)).toEqual(['Budget 2026', 'Budget 2026']);
    const [budget, stock] = result.pendingWorkbooks;
    expect([budget.id, stock.id]).not.toContain(BUDGET);
    expect(new Set([budget.id, stock.id]).size).toBe(2);
    expect([...budget.bytes]).toEqual([...XLSX(1)]);
    expect([...stock.bytes]).toEqual([...XLSX(2)]);
    expect(await sheetsOfPage(session, 'Alpha')).toEqual([budget.id, stock.id]);
  });

  it('on this device: the blocks as they were, the workbooks counted as skipped', async () => {
    const { session, files } = await exported();
    const result = await readExportWith(session, files, ' (imported)');
    expect(result.pendingWorkbooks).toEqual([]);
    expect(result.skippedWorkbooks).toBe(2);
    expect(await sheetsOfPage(session, 'Alpha')).toEqual([BUDGET, STOCK]);
  });

  it('counts a workbook whose bytes are missing, and reads a version 2 export as before', async () => {
    const { session, files } = await exported();
    const manifest = JSON.parse(new TextDecoder().decode(files[MANIFEST]));
    const partial = { ...files };
    delete partial['workbooks/Budget 2026 (2).xlsx'];
    const result = await readExportWith(session, partial, '', { workbooks: 'make' });
    expect(result.pendingWorkbooks).toHaveLength(1);
    expect(result.skippedWorkbooks).toBe(1);
    // The block of the workbook not made keeps its old id.
    expect(await sheetsOfPage(session, 'Alpha')).toEqual([result.pendingWorkbooks[0].id, STOCK]);

    const older = { ...manifest, version: 2 };
    delete older.workbooks;
    const v2 = await readExportWith(
      session,
      { ...files, [MANIFEST]: new TextEncoder().encode(JSON.stringify(older)) },
      '',
      { workbooks: 'make' },
    );
    expect(v2).toMatchObject({ pendingWorkbooks: [], skippedWorkbooks: 0 });
    expect(v2.first).toBeTruthy();
  });
});

describe('the workbooks’ reader and maker', () => {
  const record = (id: string, over: Partial<Workbook> = {}): Workbook => ({
    id,
    workspaceId: 'ws',
    name: id === BUDGET ? 'Budget' : 'Stock',
    version: 1,
    versionId: 'v1',
    etag: '"v1"',
    size: 5,
    savedAt: null,
    savedBy: null,
    createdBy: 'u1',
    createdAt: '',
    trashedAt: null,
    access: 'view',
    ...over,
  });
  const content = (id: string): WorkbookContent => ({
    readUrl: `http://blob/${id}`,
    etag: '"v1"',
    versionId: 'v1',
    size: 5,
    expiresAt: null,
  });

  it('reads the listed workbooks with a version by their signed URLs', async () => {
    const api = {
      list: vi.fn(async () => [
        record(BUDGET),
        record(STOCK),
        record('01936f6e-0000-7000-8000-00000000f003', { versionId: null, etag: null }),
      ]),
      content: vi.fn(async (id: string) => content(id)),
    };
    const fetchSigned = vi.fn(async (url: string) =>
      url.endsWith(STOCK) ? new Response(null, { status: 403 }) : new Response(XLSX(7)),
    );
    const read = await workbookReader(api, 'ws', fetchSigned as never)(null);
    expect(api.list).toHaveBeenCalledWith('ws');
    // The empty one is not asked for; the refused one is counted.
    expect(api.content.mock.calls.map((c) => c[0])).toEqual([BUDGET, STOCK]);
    expect(read.workbooks.map((w) => [w.id, w.name, [...w.bytes]])).toEqual([
      [BUDGET, 'Budget', [...XLSX(7)]],
    ]);
    expect(read.failed).toBe(1);
    // Only those wanted.
    const some = await workbookReader(api, 'ws', fetchSigned as never)(new Set([STOCK]));
    expect(some).toEqual({ workbooks: [], failed: 1 });
  });

  it('makes each workbook by its id, then its bytes as the first version', async () => {
    const calls: string[] = [];
    const api = {
      create: vi.fn(async (_ws: string, name: string, id?: string) => {
        calls.push(`create ${name}`);
        if (name === 'Refused') throw new SyncHttpError(403, 'access.denied', 'No');
        return record(id!);
      }),
      uploadVersion: vi.fn(async (id: string, _bytes: Uint8Array, etag?: string | null) => {
        calls.push(`upload ${id} ${etag}`);
        return { versionId: 'v1', etag: '"v1"' };
      }),
    };
    const made = await makeWorkbooks(api, 'ws', [
      { id: BUDGET, name: 'Budget', bytes: XLSX(1) },
      { id: STOCK, name: 'Refused', bytes: XLSX(2) },
    ]);
    expect(made).toEqual({ made: 1, failed: 1 });
    expect(api.create).toHaveBeenCalledWith('ws', 'Budget', BUDGET);
    expect(calls).toEqual(['create Budget', `upload ${BUDGET} null`, 'create Refused']);
  });
});
