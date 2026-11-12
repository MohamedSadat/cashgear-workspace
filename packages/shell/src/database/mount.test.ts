// A database block in a page (`EditorHost.databases.mount`): `DatabaseView` drawn into the block's
// element with the app's strings and direction, a root of its own per block, taken over (not made
// again) when the editor mounts the same block again, and gone after the last unmount.
import { MemoryStore } from '@cgw/workspace';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';
import { localWorkspace } from '../../../workspace/src/testing/syncHarness';
import { createI18n } from '../i18n';
import { WorkspaceSession } from '../session';
import { ShellDatabaseHost } from './host';
import { newDatabaseOps } from './make';
import { mountDatabase } from './mount';

installDom();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++)
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  expect(check()).toBe(true);
}

// The first test loads the views (about 2.5 s under a full run): room for CI's smaller runner.
describe('a database block', { timeout: 30_000 }, () => {
  it('draws the database in its element, in the interface direction, and keeps its root', async () => {
    const store = new MemoryStore();
    const made = await localWorkspace(store);
    const session = await WorkspaceSession.start(store);
    session.switchTo(made.ws.id);
    const host = new ShellDatabaseHost({ session });
    const database = newDatabaseOps(
      {
        workspaceId: made.ws.id,
        sectionId: made.section.id,
        parentPageId: made.a.id,
        orderKey: 'a5',
      },
      { title: 'Name', table: 'Table' },
    );
    await host.apply(database.ops);
    const i18n = createI18n('en');
    const options = {
      databaseId: database.databaseId,
      viewId: null,
      blockId: 'AbCdEfGhIjKl',
      editable: true,
      setViewId: vi.fn(),
    };
    const first = document.createElement('div');
    document.body.append(first);
    let unmount = mountDatabase(first, options, { host, i18n });
    const container = first.firstElementChild as HTMLElement;
    expect(container.className).toBe('cgw-db-block');
    await until(() => !!container.querySelector('.cgw-db [role="grid"]'));
    expect(container.dir).toBe('ltr');
    expect(container.querySelectorAll('[role="row"]').length).toBeGreaterThan(1);

    // The editor mounts the block again (another view chosen): the same root, moved.
    unmount();
    const second = document.createElement('div');
    document.body.append(second);
    unmount = mountDatabase(second, { ...options, viewId: database.viewId }, { host, i18n });
    expect(second.firstElementChild).toBe(container);
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(container.isConnected).toBe(true);
    expect(container.querySelector('.cgw-db')).not.toBeNull();

    // Arabic: the block is drawn right to left.
    await act(async () => {
      await i18n.changeLanguage('ar');
    });
    expect(container.dir).toBe('rtl');
    expect(container.lang).toBe('ar');

    unmount();
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(second.childElementCount).toBe(0);
    host.dispose();
  });
});
