// Phase 8, M8.4: import from Markdown, Notion and Word, planned on the device and written through
// the session. Each fixture (../fixtures/fixtures.ts) with its expected pages, databases, links
// and images, into a local and a synced workspace; the report; hostile archives refused or
// contained; the 2,000-page and 500 MB limits; a failure or a Stop midway leaves nothing, and an
// existing page is never written into.
import { PageDocument, fragmentToJSON, plainText, type DocJSON } from '@cgw/doc';
import { MemoryStore, type Id, type LocalStore } from '@cgw/workspace';
import { describe, expect, it } from 'vitest';
import { FakeServer } from '../../../../workspace/src/testing/fakeServer';
import {
  ALICE,
  device,
  localWorkspace,
  serverRows,
  sharedWorkspace,
} from '../../../../workspace/src/testing/syncHarness';
import { WorkspaceSession } from '../../session';
import {
  declaredHuge,
  deepMarkdown,
  hugeImage,
  largeNotionExport,
  manyPages,
  markdownFolder,
  nestedZips,
  notionExport,
  relatedNotionExport,
  traversalZip,
  unflaggedNames,
  wordDocument,
  wordWithDoctype,
  zip,
  zipBomb,
} from '../fixtures/fixtures';
import { checkPath, readArchive, readFolder } from './archive';
import { contentTypeOf, imageSize, sniff } from './assets';
import { cleanNotionCell, notionDate, notionName, withoutPropertyLines } from './notion';
import { planImport, type ImportKind, type ImportRequest, type ImportSource } from './plan';
import { ImportRefused, ReportBuilder, type ImportReport } from './report';
import { runImport } from './run';

const SECTION_PLACE = { workspaceId: 'w', sectionId: 's', orderKey: 'a5' };

function request(kind: ImportKind, source: ImportSource): ImportRequest {
  return { kind, source, place: SECTION_PLACE, untitled: 'Untitled', viewName: 'Table' };
}

async function local(store: LocalStore = new MemoryStore()) {
  const made = await localWorkspace(store);
  const session = await WorkspaceSession.start(store);
  session.switchTo(made.ws.id);
  return { store, session, ...made };
}

const input = (kind: ImportKind, source: ImportSource, sectionId: Id) => ({
  kind,
  source,
  sectionId,
  untitled: 'Untitled',
  viewName: 'Table',
});

async function content(session: WorkspaceSession, pageId: Id): Promise<DocJSON> {
  const doc = await PageDocument.open(pageId, session.store, { canEdit: false });
  const json = fragmentToJSON(doc.fragment);
  await doc.close();
  return json;
}

function walk(node: DocJSON, visit: (node: DocJSON) => void) {
  visit(node);
  node.content?.forEach((child) => walk(child, visit));
}

const codes = (report: ImportReport) => report.skipped.map((s) => s.code);

/** The pages under a page, by title, each with its parent's title. */
function treeOf(session: WorkspaceSession, topId: Id) {
  const out: Record<string, string | null> = {};
  const visit = (id: Id, parent: string | null) => {
    const page = session.mirror.pages.get(id)!;
    out[page.title] = parent;
    for (const child of session.mirror.childrenOf(id)) visit(child.id, page.title);
  };
  visit(topId, null);
  return out;
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ImportRefused) return error.code;
    throw error;
  }
  throw new Error('The import was not refused');
}

describe('paths, types and Notion’s names', () => {
  it('reads paths safely', () => {
    expect(checkPath('a\\b/./c.md')).toEqual({ path: 'a/b/c.md' });
    expect(checkPath('../x.md')).toEqual({ reason: 'unsafe' });
    expect(checkPath('a/../../x.md')).toEqual({ reason: 'unsafe' });
    expect(checkPath('/x.md')).toEqual({ reason: 'unsafe' });
    expect(checkPath('C:\\x.md')).toEqual({ reason: 'unsafe' });
    expect(checkPath(`a${String.fromCharCode(0)}.md`)).toEqual({ reason: 'unsafe' });
    expect(checkPath('__MACOSX/._a.md')).toEqual({ reason: 'system' });
    expect(checkPath('folder/')).toEqual({ reason: 'folder' });
    expect(checkPath(`${'a/'.repeat(40)}b.md`)).toEqual({ reason: 'tooDeep' });
  });

  it('types files by their bytes as the server does, and reads images’ sizes from headers', () => {
    const { files } = markdownFolder();
    expect(contentTypeOf('logo.png', files['Handbook/images/logo.png'])).toBe('image/png');
    expect(imageSize('image/png', files['Handbook/images/logo.png'])).toEqual({
      width: 16,
      height: 16,
    });
    expect(contentTypeOf('manual.pdf', files['Handbook/files/manual.pdf'])).toBe('application/pdf');
    expect(contentTypeOf('data.bin', files['Handbook/data.bin'])).toBeNull();
    expect(contentTypeOf('notes.md', new TextEncoder().encode('# x'))).toBe('text/markdown');
    expect(contentTypeOf('fake.docx', new TextEncoder().encode('not a zip'))).toBeNull();
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });

  it('takes Notion’s ids off names and reads its dates and cells', () => {
    expect(notionName('Tasks 0123456789abcdef0123456789abcdef')).toEqual({
      name: 'Tasks',
      id: '0123456789abcdef0123456789abcdef',
    });
    expect(notionName('Plain name')).toEqual({ name: 'Plain name', id: null });
    expect(notionDate('November 16, 2026')).toBe('2026-11-16');
    expect(notionDate('February 30, 2026')).toBeNull();
    expect(notionDate('November 16, 2026 3:04 PM')).toBe(
      new Date(2026, 10, 16, 15, 4).toISOString().replace(/\.000Z$/, 'Z'),
    );
    expect(
      cleanNotionCell(
        'Launch (Home%20abc/Launch%200123456789abcdef0123456789abcdef.md), Other (https://www.notion.so/x)',
      ),
    ).toEqual({
      text: 'Launch, Other',
      links: true,
    });
    expect(cleanNotionCell('November 1, 2026 → November 3, 2026').text).toBe(
      '2026-11-01 → 2026-11-03',
    );
    expect(withoutPropertyLines('\nStatus: Done\nDue: x\n\nBody', new Set(['status', 'due']))).toBe(
      '\nBody',
    );
    expect(withoutPropertyLines('\nNote: not a column\n\nBody', new Set(['status']))).toBe(
      '\nNote: not a column\n\nBody',
    );
  });
});

describe('hostile archives', () => {
  it('leaves out paths out of the folder, absolute ones and control characters, and says so', async () => {
    const plan = await planImport(
      request('markdown', { kind: 'bytes', name: 'evil.zip', bytes: traversalZip() }),
    );
    const titles = plan.ops.flatMap((op) => (op.type === 'page.create' ? [op.payload.title] : []));
    // The reversed name's page is named by its heading; its file's name was cleaned.
    expect(titles.sort()).toEqual(['Good', 'Reversed', 'evil']);
    const unsafe = plan.report.skipped.find((s) => s.code === 'unsafePath')!;
    expect(unsafe.count).toBe(5);
    expect(codes(plan.report)).toEqual(
      expect.arrayContaining(['unsafePath', 'tooDeep', 'namesCleaned']),
    );
  });

  it('refuses a zip bomb before unpacking it', async () => {
    expect(
      await refusal(
        planImport(request('markdown', { kind: 'bytes', name: 'b.zip', bytes: zipBomb() })),
      ),
    ).toBe('zipBomb');
  });

  it('refuses an archive that unpacks to more than 500 MB, by what it declares', async () => {
    const bytes = declaredHuge(501);
    expect(bytes.length).toBeLessThan(2 * 1024 * 1024);
    expect(
      await refusal(planImport(request('markdown', { kind: 'bytes', name: 'h.zip', bytes }))),
    ).toBe('tooLarge');
  });

  it('refuses a chosen folder over 500 MB, and too many files', () => {
    const report = new ReportBuilder();
    const file = { path: 'F/a.md', bytes: new Uint8Array(10) };
    expect(() =>
      readFolder([file, { ...file, path: 'F/b.md' }], report, { bytes: 15, files: 10 }),
    ).toThrow(ImportRefused);
    expect(() => readFolder([file], report, { bytes: 100, files: 0 })).toThrow(ImportRefused);
  });

  it('reads archives inside archives two deep, no deeper', async () => {
    const plan = await planImport(
      request('markdown', { kind: 'bytes', name: 'n.zip', bytes: nestedZips(2) }),
    );
    expect(plan.ops.some((op) => op.type === 'page.create' && op.payload.title === 'Deep')).toBe(
      true,
    );
    expect(
      await refusal(
        planImport(request('markdown', { kind: 'bytes', name: 'n.zip', bytes: nestedZips(3) })),
      ),
    ).toBe('empty');
  });

  it('leaves out an image whose header claims too many pixels', async () => {
    const plan = await planImport(
      request('markdown', { kind: 'bytes', name: 'g.zip', bytes: hugeImage() }),
    );
    expect(plan.assets.map((a) => a.record.fileName)).toEqual(['fine.png']);
    expect(plan.report.skipped.find((s) => s.code === 'imageTooLarge')?.examples).toEqual([
      'huge.png',
    ]);
  });

  it('caps a deep Markdown file’s nesting', async () => {
    const bytes = new TextEncoder().encode(deepMarkdown());
    const plan = await planImport(request('markdown', { kind: 'bytes', name: 'Deep.md', bytes }));
    expect(codes(plan.report)).toContain('tooDeep');
    let depth = 0;
    const measure = (node: DocJSON, d: number) => {
      if (node.type === 'block') depth = Math.max(depth, d);
      node.content?.forEach((child) => measure(child, node.type === 'block' ? d + 1 : d));
    };
    measure(plan.documents[0].content, 0);
    expect(depth).toBeLessThanOrEqual(33);
  });

  it('refuses a Word file with a document type, and what is not a Word file', async () => {
    expect(
      await refusal(
        planImport(request('word', { kind: 'bytes', name: 'x.docx', bytes: wordWithDoctype() })),
      ),
    ).toBe('damaged');
    const text = new TextEncoder().encode('not a zip');
    expect(
      await refusal(planImport(request('word', { kind: 'bytes', name: 'x.docx', bytes: text }))),
    ).toBe('notWord');
    const other = zip({ 'a.txt': text });
    expect(
      await refusal(planImport(request('word', { kind: 'bytes', name: 'x.docx', bytes: other }))),
    ).toBe('notWord');
  });

  it('refuses a damaged archive and this app’s own export', async () => {
    const cut = notionExport().bytes.subarray(0, 200);
    expect(
      await refusal(planImport(request('notion', { kind: 'bytes', name: 'x.zip', bytes: cut }))),
    ).toBe('damaged');
    const own = zip({
      'cgw-export.json': new TextEncoder().encode('{}'),
      'Pages/A/A.md': new TextEncoder().encode('# A'),
    });
    expect(
      await refusal(planImport(request('markdown', { kind: 'bytes', name: 'x.zip', bytes: own }))),
    ).toBe('workspaceExport');
  });
});

describe('the limits', () => {
  it('takes 2,000 pages and refuses 2,001 before writing anything', async () => {
    // 1,999 pages and the folder's own page.
    const plan = await planImport(
      request('markdown', { kind: 'bytes', name: 'm.zip', bytes: manyPages(1999) }),
    );
    expect(plan.pageIds).toHaveLength(2000);
    const { session, store, ws } = await local();
    const before = (await store.readMirror(ws.id)).pages.length;
    const code = await refusal(
      runImport(
        session,
        input(
          'markdown',
          { kind: 'bytes', name: 'm.zip', bytes: manyPages(2000) },
          session.mirror.sectionsOf(ws.id)[0].id,
        ),
        { inline: true },
      ),
    );
    expect(code).toBe('tooManyPages');
    expect((await store.readMirror(ws.id)).pages).toHaveLength(before);
  });
});

describe('a Notion export', () => {
  it('makes its pages, a typed database with row pages, links and images, in a local workspace', async () => {
    const fixture = notionExport();
    const { session, store, ws, section, a } = await local();
    const before = await content(session, a.id).catch(() => null);
    const { topId, report } = await runImport(
      session,
      input('notion', { kind: 'bytes', name: fixture.name, bytes: fixture.bytes }, section.id),
      { inline: true },
    );
    // The top page is new, at the end of the section; nothing else changed.
    const top = session.mirror.pages.get(topId)!;
    expect(top).toMatchObject({ title: 'Home', parentPageId: null, sectionId: section.id });
    expect(session.mirror.topPages(section.id).at(-1)!.id).toBe(topId);
    expect(await content(session, a.id).catch(() => null)).toEqual(before);
    expect(treeOf(session, topId)).toEqual({ ...fixture.expected.pages, Tasks: 'Home' });
    // No Notion id is left in a name.
    for (const page of session.mirror.pages.values())
      expect(page.title).not.toMatch(/[0-9a-f]{32}/);

    // The database: its properties typed as the CSV import types them, its rows and their pages.
    const tasks = session.mirror.childrenOf(topId).find((p) => p.title === 'Tasks')!;
    expect(tasks.kind).toBe('database');
    const database = session.mirror.databases.get(tasks.id)!;
    const types = Object.fromEntries(database.properties.map((p) => [p.name, p.type]));
    expect(types).toEqual(fixture.expected.databases.Tasks.types);
    const prop = (name: string) => database.properties.find((p) => p.name === name)!.id;
    const rows = await session.loadRows(tasks.id);
    expect(rows.map((r) => r.title)).toEqual([
      'Write the spec',
      'Review',
      'Ship it',
      'Plan the party',
    ]);
    const spec = rows[0];
    expect(spec.values[prop('Due')]).toEqual({ start: '2026-11-20' });
    expect(spec.values[prop('Done')]).toBe(true);
    expect(spec.values[prop('Estimate')]).toBe(3);
    expect(spec.values[prop('Project')]).toBe('Launch');
    expect(rows[2].values[prop('Due')]).toEqual({ start: '2026-11-25', end: '2026-11-27' });
    const status = database.properties.find((p) => p.name === 'Status')!;
    expect(status.options!.map((o) => o.name)).toEqual(['Doing', 'Done']);
    expect(rows[1].values[status.id]).toBe(status.options![1].id);
    // A row's page is its body, without the property lines Notion writes; a row with no page has
    // no body yet.
    const body = await content(session, spec.id);
    // Its text, then its image's alt text.
    expect(plainText(body)).toBe('The spec covers import.\nchart');
    expect(body.content!.some((b) => b.content![0].type === 'image')).toBe(true);
    expect((await store.loadDoc(rows[2].id)).updates).toHaveLength(0);

    // Home's body: child pages and the inline database where the links stood alone, a page link,
    // a mention found by the page's Notion address, an image, a callout.
    const home = await content(session, topId);
    const projects = session.mirror.childrenOf(topId).find((p) => p.title === 'Projects')!;
    const notes = session.mirror.childrenOf(topId).find((p) => p.title === 'Meeting notes')!;
    const launch = session.mirror.childrenOf(projects.id)[0];
    const bodies = home.content!.map((b) => b.content![0]);
    expect(bodies.filter((b) => b.type === 'childPage').map((b) => b.attrs?.pageId)).toEqual([
      projects.id,
      notes.id,
    ]);
    expect(bodies.find((b) => b.type === 'databaseView')?.attrs?.databaseId).toBe(tasks.id);
    expect(
      bodies.find((b) => b.type === 'textBody' && b.attrs?.kind === 'callout')?.attrs?.icon,
    ).toBe('💡');
    const nodes: DocJSON[] = [];
    walk(home, (n) => nodes.push(n));
    expect(nodes.some((n) => n.marks?.some((m) => m.attrs?.href === `#/p/${projects.id}`))).toBe(
      true,
    );
    expect(nodes.some((n) => n.type === 'pageMention' && n.attrs?.pageId === launch.id)).toBe(true);
    // Launch links back to Home by a relative path.
    const back: DocJSON[] = [];
    walk(await content(session, launch.id), (n) => back.push(n));
    expect(back.some((n) => n.type === 'pageMention' && n.attrs?.pageId === topId)).toBe(true);
    // The images are assets on this device.
    const image = bodies.find((b) => b.type === 'image')!;
    const asset = session.mirror.assets.get(String(image.attrs?.assetId))!;
    expect(asset).toMatchObject({
      fileName: 'diagram.png',
      contentType: 'image/png',
      width: 8,
      height: 6,
    });
    expect(await store.getAssetBytes(asset.id)).not.toBeNull();

    expect(report.made).toEqual({ pages: 4, databases: 1, rows: 4, images: 2, files: 0 });
    expect(codes(report)).toEqual(expect.arrayContaining(fixture.expected.skipped));
    expect(report.skipped.find((s) => s.code === 'notLinked')?.examples[0]).toMatch(/notes\.bin$/);
    expect(notes.title).toBe('Meeting notes');
    void ws;
  });
});

describe('Notion’s relations, files and people', () => {
  async function imported(session: WorkspaceSession, sectionId: Id) {
    const fixture = relatedNotionExport();
    const outcome = await runImport(
      session,
      input('notion', { kind: 'bytes', name: fixture.name, bytes: fixture.bytes }, sectionId),
      { inline: true },
    );
    const [projects, tasks] = ['Projects', 'Tasks'].map((title) =>
      session.mirror.childrenOf(outcome.topId).find((p) => p.title === title)!,
    );
    const P = session.mirror.databases.get(projects.id)!;
    const T = session.mirror.databases.get(tasks.id)!;
    const prop = (db: typeof P, name: string) => db.properties.find((p) => p.name === name)!;
    const projectRows = await session.loadRows(projects.id);
    const taskRows = await session.loadRows(tasks.id);
    const row = (rows: typeof taskRows, title: string) => rows.find((r) => r.title === title)!;
    return { ...outcome, projects, tasks, P, T, prop, projectRows, taskRows, row };
  }

  it('makes two databases related both ways, a relation by names, files as assets, and says what stayed text', async () => {
    const { session, section } = await local();
    const { report, projects, tasks, P, T, prop, projectRows, taskRows, row } = await imported(
      session,
      section.id,
    );
    // Tasks' "Project" and Projects' "Tasks" name each other's rows: one two-way relation.
    expect(prop(T, 'Project')).toMatchObject({
      type: 'relation',
      relation: { databaseId: projects.id, reversePropertyId: prop(P, 'Tasks').id },
    });
    expect(prop(P, 'Tasks')).toMatchObject({
      type: 'relation',
      relation: { databaseId: tasks.id, reversePropertyId: prop(T, 'Project').id },
    });
    // Plain names of rows of its own database: a relation one way.
    expect(prop(P, 'Depends on')).toMatchObject({
      type: 'relation',
      relation: { databaseId: projects.id, reversePropertyId: null },
    });
    expect(prop(T, 'Attachments').type).toBe('files');
    for (const name of ['References', 'Blocked by', 'Assignee'])
      expect(prop(T, name).type, name).toBe('text');
    expect(prop(P, 'Owner').type).toBe('text');

    const [launch, website] = ['Launch', 'Website'].map((t) => row(projectRows, t));
    const [spec, review, ship, unplanned] = [
      'Write the spec',
      'Review',
      'Ship it',
      'Unplanned',
    ].map((t) => row(taskRows, t));
    const project = prop(T, 'Project').id;
    const back = prop(P, 'Tasks').id;
    expect(spec.values[project]).toEqual([launch.id]);
    expect(review.values[project]).toEqual([launch.id]);
    expect(ship.values[project]).toEqual([website.id]);
    expect(unplanned.values[project]).toBeUndefined();
    // The back column follows, both ways, as the planner keeps reverse relations.
    expect([...(launch.values[back] as string[])].sort()).toEqual([spec.id, review.id].sort());
    expect(website.values[back]).toEqual([ship.id]);
    const depends = prop(P, 'Depends on').id;
    expect(website.values[depends]).toEqual([launch.id]);
    expect(launch.values[depends]).toBeUndefined();

    // Files of the export: assets on this device.
    const attachments = prop(T, 'Attachments').id;
    const brief = session.mirror.assets.get((spec.values[attachments] as string[])[0])!;
    expect(brief).toMatchObject({ fileName: 'brief.pdf', contentType: 'application/pdf' });
    const logo = session.mirror.assets.get((ship.values[attachments] as string[])[0])!;
    expect(logo).toMatchObject({ fileName: 'logo.png', width: 6 });
    expect(await session.store.getAssetBytes(brief.id)).not.toBeNull();
    // What stayed text: a page outside the export by its name, a file that is not there.
    expect(spec.values[prop(T, 'Blocked by').id]).toBe('Old plan');
    expect(String(spec.values[prop(T, 'References').id])).toContain('https://example.com/spec.pdf');
    const skipped = Object.fromEntries(report.skipped.map((s) => [s.code, s.examples]));
    expect(skipped.peopleAsText?.sort()).toEqual(['Projects: Owner', 'Tasks: Assignee']);
    expect(skipped.linksAsText).toEqual(['Tasks: Blocked by']);
    expect(skipped.filesAsText).toEqual(['Tasks: References']);
    expect(skipped.notLinked).toBeUndefined();
    // A row page's body, without the property lines.
    expect(plainText(await content(session, spec.id))).toBe("Write the spec's page.");
    expect(report.made).toMatchObject({ databases: 2, rows: 6, files: 1, images: 1 });
  });

  it('reaches the server with its relations both ways and its files', async () => {
    const server = new FakeServer();
    const shared = await sharedWorkspace(server);
    const session = await WorkspaceSession.start(shared.one.store);
    session.switchTo(shared.ws.id);
    const { P, T, prop, projectRows, taskRows, row } = await imported(session, shared.section.id);
    await shared.one.engine.syncOnce();
    await shared.one.engine.syncOnce();
    expect(await shared.one.store.pendingAssets(10)).toEqual([]);
    const two = device(server);
    await two.engine.syncOnce();
    const launch = row(projectRows, 'Launch');
    const onServer = await serverRows(server, ALICE, P.id);
    const tasksOnServer = await serverRows(server, ALICE, T.id);
    const ids = (value: unknown) => [...((value as string[]) ?? [])].sort();
    expect(ids(onServer[launch.id].values[prop(P, 'Tasks').id])).toEqual(
      [row(taskRows, 'Write the spec').id, row(taskRows, 'Review').id].sort(),
    );
    expect(tasksOnServer[row(taskRows, 'Ship it').id].values[prop(T, 'Project').id]).toEqual([
      row(projectRows, 'Website').id,
    ]);
    expect(
      tasksOnServer[row(taskRows, 'Write the spec').id].values[prop(T, 'Attachments').id],
    ).toHaveLength(1);
  });
});

describe('names written without the UTF-8 flag', () => {
  it('reads valid UTF-8 as UTF-8, and keeps an old code page’s name, said to be possibly garbled', async () => {
    const { bytes, arabic } = unflaggedNames();
    const report = new ReportBuilder();
    const files = readArchive(bytes, report);
    const c1 = String.fromCharCode(0x82);
    expect(files.map((f) => f.path)).toEqual([`${arabic}.md`, `R${c1}sum${c1}.md`, 'Plain.md']);
    const garbled = report.build().skipped.find((s) => s.code === 'namesGarbled')!;
    expect(garbled.count).toBe(1);
    // As an import: the Arabic page by its own name.
    const plan = await planImport(request('markdown', { kind: 'bytes', name: 'notes.zip', bytes }));
    const titles = plan.ops.flatMap((op) => (op.type === 'page.create' ? [op.payload.title] : []));
    expect(titles).toContain('ملاحظات');
    expect(codes(plan.report)).toContain('namesGarbled');
  });
});

describe('a Markdown folder', () => {
  it('makes a page tree after its folders, with links, images, files and what it skipped', async () => {
    const fixture = markdownFolder();
    const { session, section } = await local();
    const files = Object.entries(fixture.files).map(([path, bytes]) => ({ path, bytes }));
    const { topId, report } = await runImport(
      session,
      input('markdown', { kind: 'folder', name: 'Handbook', files }, section.id),
      { inline: true },
    );
    expect(treeOf(session, topId)).toEqual(fixture.expected.pages);
    const page = (title: string) =>
      [...session.mirror.pages.values()].find((p) => p.title === title)!;
    const welcome = await content(session, page('Welcome').id);
    const nodes: DocJSON[] = [];
    walk(welcome, (n) => nodes.push(n));
    const mentions = nodes.filter((n) => n.type === 'pageMention').map((n) => n.attrs?.pageId);
    expect(mentions).toEqual([page('Guide').id, page('Install').id]);
    const kinds = welcome.content!.map((b) =>
      b.content![0].type === 'textBody' ? b.content![0].attrs?.kind : b.content![0].type,
    );
    expect(kinds).toEqual([
      'paragraph',
      'image',
      'file',
      'paragraph',
      'paragraph',
      'numberedItem',
      'numberedItem',
      'quote',
      'paragraph',
      'bookmark',
    ]);
    const file = welcome.content![2].content![0];
    expect(session.mirror.assets.get(String(file.attrs?.assetId))).toMatchObject({
      fileName: 'manual.pdf',
      contentType: 'application/pdf',
    });
    // The second numbered item holds its nested bullet; the paragraph keeps its hard break.
    expect(welcome.content![6].content![1].content![0].attrs?.kind).toBe('bulletItem');
    expect(welcome.content![8].content![0].content).toEqual([
      { type: 'text', text: 'Line one' },
      { type: 'hardBreak' },
      { type: 'text', text: 'line two' },
    ]);
    // The folder made into a page lists its pages.
    const reference = await content(session, page('Reference').id);
    expect(reference.content!.map((b) => b.content![0])).toEqual([
      { type: 'childPage', attrs: { pageId: page('API').id } },
    ]);
    expect(report.made).toMatchObject({ pages: 6, images: 1, files: 1 });
    expect(codes(report)).toEqual(expect.arrayContaining(fixture.expected.skipped));
    expect(report.skipped.find((s) => s.code === 'brokenLink')?.examples).toEqual([
      'Handbook/Nowhere.md',
    ]);
  });

  it('reads the same folder from a zip', async () => {
    const fixture = markdownFolder();
    const plan = await planImport(
      request('markdown', { kind: 'bytes', name: 'Handbook.zip', bytes: fixture.bytes }),
    );
    expect(plan.report.made.pages).toBe(6);
  });
});

describe('a Word file', () => {
  it('makes one page with its blocks, images and what Word has that a page does not', async () => {
    const fixture = wordDocument();
    const { session, section } = await local();
    const { topId, report } = await runImport(
      session,
      input('word', { kind: 'bytes', name: fixture.name, bytes: fixture.bytes }, section.id),
      { inline: true },
    );
    expect(session.mirror.pages.get(topId)!.title).toBe('Quarterly report');
    const doc = await content(session, topId);
    expect(doc.content!.length).toBe(fixture.expected.blocks.length);
    const image = doc.content!.find((b) => b.content![0].type === 'image')!.content![0];
    expect(session.mirror.assets.get(String(image.attrs?.assetId))).toMatchObject({
      contentType: 'image/png',
      width: 10,
    });
    expect(report.made).toEqual({ pages: 1, databases: 0, rows: 0, images: 1, files: 0 });
    expect(codes(report)).toEqual(expect.arrayContaining(fixture.expected.skipped));
  });
});

describe('an import that fails or is stopped', () => {
  /** A store that fails the `n`th document write (and passes everything else through). */
  function failingStore(n: number) {
    const store = new MemoryStore();
    let writes = 0;
    const append = store.appendDocUpdates.bind(store);
    store.appendDocUpdates = (pageId, updates) => {
      writes++;
      if (writes === n) return Promise.reject(new Error('the disk is full'));
      return append(pageId, updates);
    };
    return store;
  }

  async function snapshot(store: LocalStore, workspaceId: Id) {
    const mirror = await store.readMirror(workspaceId);
    return {
      pages: mirror.pages.map((p) => p.id).sort(),
      databases: mirror.databases.length,
      views: mirror.views.length,
    };
  }

  it('leaves nothing when a write fails midway: pages, rows, documents and search entries', async () => {
    const store = failingStore(3);
    const { session, ws, section } = await local(store);
    const before = await snapshot(store, ws.id);
    const fixture = notionExport();
    const plan = await planImport({
      ...request('notion', { kind: 'bytes', name: fixture.name, bytes: fixture.bytes }),
      place: {
        workspaceId: ws.id,
        sectionId: section.id,
        orderKey: session.keyFor(section.id, null),
      },
    });
    const { writePlan } = await import('./write');
    expect(await refusal(writePlan(session, plan))).toBe('failed');
    expect(await snapshot(store, ws.id)).toEqual(before);
    for (const id of plan.pageIds) {
      expect(session.record(id)).toBeUndefined();
      expect((await store.loadDoc(id)).updates).toHaveLength(0);
    }
    for (const id of plan.databases) expect(await store.readRows(id)).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.search(ws.id, 'spec', 10)).toEqual([]);
    expect(await store.search(ws.id, 'projects', 10)).toEqual([]);
  });

  it('leaves nothing when stopped while writing', async () => {
    const { session, store, ws, section } = await local();
    const before = await snapshot(store, ws.id);
    const stop = new AbortController();
    const fixture = notionExport();
    const code = await refusal(
      runImport(
        session,
        input('notion', { kind: 'bytes', name: fixture.name, bytes: fixture.bytes }, section.id),
        {
          inline: true,
          signal: stop.signal,
          onPhase: (phase, progress) => {
            if (phase === 'writing' && progress && progress.done > 0) stop.abort();
          },
        },
      ),
    );
    expect(code).toBe('stopped');
    expect(await snapshot(store, ws.id)).toEqual(before);
  });

  it('leaves nothing when its operations fail in a later batch', async () => {
    const { session, store, ws, section } = await local();
    const before = await snapshot(store, ws.id);
    const plan = await planImport({
      ...request('markdown', { kind: 'bytes', name: 'm.zip', bytes: manyPages(700) }),
      place: {
        workspaceId: ws.id,
        sectionId: section.id,
        orderKey: session.keyFor(section.id, null),
      },
    });
    // The second batch makes a page under a parent that is not there: the planner refuses it.
    plan.ops[600] = {
      ...plan.ops[600],
      payload: { ...(plan.ops[600].payload as object), parentPageId: 'gone' },
    } as never;
    const { writePlan } = await import('./write');
    expect(await refusal(writePlan(session, plan))).toBe('failed');
    expect(await snapshot(store, ws.id)).toEqual(before);
  });
});

describe('an import into a synced workspace', () => {
  it('reaches the server: pages, the database and its rows, documents and assets', async () => {
    const server = new FakeServer();
    const shared = await sharedWorkspace(server);
    const session = await WorkspaceSession.start(shared.one.store);
    session.switchTo(shared.ws.id);
    const fixture = notionExport();
    const { topId } = await runImport(
      session,
      input(
        'notion',
        { kind: 'bytes', name: fixture.name, bytes: fixture.bytes },
        shared.section.id,
      ),
      { inline: true },
    );
    await shared.one.engine.syncOnce();
    await shared.one.engine.syncOnce();
    const tree = await server.api(ALICE).tree(shared.ws.id, null);
    const titles = tree.pages.filter((p) => !p.trashedAt).map((p) => p.title);
    expect(titles).toEqual(
      expect.arrayContaining(['Home', 'Projects', 'Launch', 'Meeting notes', 'Tasks']),
    );
    const tasks = tree.pages.find((p) => p.title === 'Tasks')!;
    expect(Object.keys(await serverRows(server, ALICE, tasks.id))).toHaveLength(4);
    expect(await shared.one.store.unsentDocUpdates(100)).toEqual([]);
    expect(await shared.one.store.pendingAssets(10)).toEqual([]);
    // A second device sees it.
    const two = device(server);
    await two.engine.syncOnce();
    expect((await two.store.readMirror(shared.ws.id)).pages.some((p) => p.id === topId)).toBe(true);
  });

  it('leaves nothing on the server when it fails midway', async () => {
    const server = new FakeServer();
    const shared = await sharedWorkspace(server);
    const session = await WorkspaceSession.start(shared.one.store);
    session.switchTo(shared.ws.id);
    const fixture = notionExport();
    const plan = await planImport({
      ...request('notion', { kind: 'bytes', name: fixture.name, bytes: fixture.bytes }),
      place: {
        workspaceId: shared.ws.id,
        sectionId: shared.section.id,
        orderKey: session.keyFor(shared.section.id, null),
      },
    });
    let writes = 0;
    const store = shared.one.store;
    const append = store.appendDocUpdates.bind(store);
    store.appendDocUpdates = async (pageId, updates) => {
      // The engine pushes what was written so far before the failure.
      if (++writes === 2) await shared.one.engine.syncOnce();
      if (writes === 4) throw new Error('the disk is full');
      return append(pageId, updates);
    };
    const { writePlan } = await import('./write');
    expect(await refusal(writePlan(session, plan))).toBe('failed');
    store.appendDocUpdates = append;
    await shared.one.engine.syncOnce();
    await shared.one.engine.syncOnce();
    const tree = await server.api(ALICE).tree(shared.ws.id, null);
    const live = tree.pages.filter((p) => plan.pageIds.includes(p.id) && !p.trashedAt);
    expect(live).toEqual([]);
    expect(tree.pages.map((p) => p.title).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});

describe('the budget', () => {
  it('imports a 1,000-page Notion export on the device well within 60 s', async () => {
    const fixture = largeNotionExport(1000);
    const { session, section } = await local();
    const started = performance.now();
    const plan = await planImport({
      ...request('notion', { kind: 'bytes', name: fixture.name, bytes: fixture.bytes }),
      place: {
        workspaceId: session.workspaceId!,
        sectionId: section.id,
        orderKey: session.keyFor(section.id, null),
      },
    });
    const planned = performance.now();
    const { writePlan } = await import('./write');
    await writePlan(session, plan);
    const written = performance.now();
    expect(plan.pageIds.length).toBe(fixture.pages);
    console.info(
      `1,000-page Notion export: ${plan.pageIds.length} pages, planned in ${Math.round(planned - started)} ms, written in ${Math.round(written - planned)} ms (MemoryStore)`,
    );
    expect(written - started).toBeLessThan(60_000);
  }, 120_000);
});
