// Settings → Your data with and without a workspace shown. Signed out on a device whose
// workspaces are all synced, none is shown (another account's never are), and the panel still
// offers "Import an export", which makes a workspace of its own; export and the other imports need
// the workspace shown.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDom } from '../../../database/src/testing/dom';

installDom();
const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nextProvider } = await import('react-i18next');
const { createI18n } = await import('../i18n');
const { ShellContext } = await import('../context');
const { DataPanel } = await import('./DataPanel');
type WorkspaceSession = import('../session').WorkspaceSession;
type WorkspaceRecord = import('@cgw/workspace').WorkspaceRecord;

const roots: { unmount(): void }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

function render(current: WorkspaceRecord | null) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const session = { workspaceId: current?.id ?? null, current } as unknown as WorkspaceSession;
  const services = { platform: { kind: 'desktop', saveFile: vi.fn() } } as never;
  act(() =>
    root.render(
      h(
        I18nextProvider,
        { i18n: createI18n('en') },
        h(ShellContext.Provider, { value: services }, h(DataPanel, { session })),
      ),
    ),
  );
  return container;
}

const buttons = (scope: ParentNode) =>
  [...scope.querySelectorAll('button')].map((b) => ({ text: b.textContent, disabled: b.disabled }));

describe('Your data', () => {
  it('offers the import alone when no workspace is shown', () => {
    const panel = render(null);
    expect(panel.querySelector('h2')?.textContent).toBe('Your data');
    expect(buttons(panel)).toEqual([{ text: 'Import an export', disabled: false }]);
  });

  it('offers export and every import for the workspace shown', () => {
    const workspace: WorkspaceRecord = {
      id: '01936f6e-0000-7000-8000-0000000000aa',
      name: 'Here',
      icon: null,
      createdAt: '2026-11-21T09:00:00Z',
      version: 1,
      localOnly: true,
      deletedAt: null,
    };
    expect(buttons(render(workspace))).toEqual([
      { text: 'Export workspace', disabled: false },
      { text: 'Import an export', disabled: false },
      { text: 'Import from Markdown, Notion or Word', disabled: false },
    ]);
  });
});
