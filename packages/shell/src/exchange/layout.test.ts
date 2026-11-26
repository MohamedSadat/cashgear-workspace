// Phase 19, M19.1: a page's layout in the workspace's export and import, and in a copy of a
// template. The manifest's entry holds it; an import keeps it when it passes the layout's check
// (an export's file may have been edited by hand), and a page made from a template prints as the
// template does.
import { MemoryStore } from '@cgw/workspace';
import { describe, expect, it } from 'vitest';
import { localWorkspace } from '../../../workspace/src/testing/syncHarness';
import { WorkspaceSession } from '../session';
import { MANIFEST, buildExport, readExportWith } from './exchange';

const LAYOUT = {
  size: 'letter',
  orientation: 'landscape',
  margins: 'narrow',
  header: { start: '{title}', center: '', end: '{date}' },
  footer: { start: '', center: 'صفحة {page} من {pages}', end: '' },
};

async function workspace() {
  const store = new MemoryStore();
  const made = await localWorkspace(store);
  const session = await WorkspaceSession.start(store);
  session.switchTo(made.ws.id);
  await session.updatePage(made.a.id, { layout: LAYOUT });
  return { store, session, ...made };
}

const titled = (session: WorkspaceSession, title: string) =>
  [...session.mirror.pages.values()].filter(
    (p) => p.workspaceId === session.workspaceId && p.title === title,
  );

describe("a page's layout in the export and import", () => {
  it('is written in its entry, and an import makes the page with it', async () => {
    const { session, a, b } = await workspace();
    const { manifest, files } = await buildExport(session, { untitled: 'Untitled' });
    expect(manifest.pages.find((p) => p.id === a.id)?.layout).toEqual(LAYOUT);
    // A page with none has no key at all.
    expect(manifest.pages.find((p) => p.id === b.id)).not.toHaveProperty('layout');
    await readExportWith(session, files, ' (imported)');
    const copies = titled(session, 'Alpha').filter((p) => p.id !== a.id);
    expect(copies).toHaveLength(1);
    expect(copies[0].layout).toEqual(LAYOUT);
  });

  it('leaves out a layout an edited file made wrong, and imports the page all the same', async () => {
    const { session, a } = await workspace();
    const { files } = await buildExport(session, { untitled: 'Untitled' });
    const manifest = JSON.parse(new TextDecoder().decode(files[MANIFEST]));
    manifest.pages.find((p: { id: string }) => p.id === a.id).layout = { size: 'a3' };
    files[MANIFEST] = new TextEncoder().encode(JSON.stringify(manifest));
    await readExportWith(session, files, ' (imported)');
    const copy = titled(session, 'Alpha').find((p) => p.id !== a.id)!;
    expect(copy).toBeDefined();
    expect(copy.layout ?? null).toBeNull();
  });

  it('is copied with a template, so the new page prints as the template does', async () => {
    const { session, a } = await workspace();
    await session.updatePage(a.id, { isTemplate: true });
    const made = await session.newFromTemplate(a.id);
    expect(made.layout).toEqual(LAYOUT);
    expect(session.mirror.pages.get(made.id)?.layout).toEqual(LAYOUT);
  });
});
