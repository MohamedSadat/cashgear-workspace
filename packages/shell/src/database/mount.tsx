// A database block in a page (`EditorHost.databases.mount`, contract section 5): `DatabaseView`
// drawn into the block's element, a React root of its own per block, with the app's strings,
// theme (the document's) and direction. The editor mounts again when the block points at another
// view; the root drawn for that block a moment before is moved into the new element rather than
// made again, so the view does not flash or lose its place.
import type { DatabaseMountOptions } from '@cgw/editor';
import type { i18n as I18n } from 'i18next';
import { lazy, Suspense, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, useTranslation } from 'react-i18next';
import type { ShellDatabaseHost } from './host';

// The views load with the first database on screen, not with the editor.
const DatabaseView = lazy(() => import('@cgw/database').then((m) => ({ default: m.DatabaseView })));

interface Mounted {
  root: Root;
  container: HTMLElement;
  /** Set while the root waits to be dropped; a mount of the same block takes it back. */
  disposal: ReturnType<typeof setTimeout> | null;
}

const mounted = new Map<string, Mounted>();

export interface MountDeps {
  host: ShellDatabaseHost;
  i18n: I18n;
}

export function mountDatabase(
  element: HTMLElement,
  options: DatabaseMountOptions,
  deps: MountDeps,
): () => void {
  const key = options.blockId ? `${options.blockId}/${options.databaseId}` : null;
  const waiting = key ? mounted.get(key) : undefined;
  let entry: Mounted;
  if (waiting && waiting.disposal !== null) {
    clearTimeout(waiting.disposal);
    waiting.disposal = null;
    entry = waiting;
  } else {
    const container = document.createElement('div');
    container.className = 'cgw-db-block';
    entry = { root: createRoot(container), container, disposal: null };
    // A second view of the same block (the history's preview) keeps the first one's entry.
    if (key && !waiting) mounted.set(key, entry);
  }
  element.appendChild(entry.container);
  entry.root.render(<DatabaseBlock options={options} deps={deps} container={entry.container} />);
  return () => {
    if (entry.disposal !== null) return;
    // Not during the editor's own update (React refuses to unmount a root while rendering).
    entry.disposal = setTimeout(() => {
      entry.disposal = null;
      if (key && mounted.get(key) === entry) mounted.delete(key);
      entry.root.unmount();
      entry.container.remove();
    }, 0);
  };
}

function DatabaseBlock({
  options,
  deps,
  container,
}: {
  options: DatabaseMountOptions;
  deps: MountDeps;
  container: HTMLElement;
}) {
  const { i18n } = deps;
  // The block's own direction and language: the CashGear controls read the nearest `dir`.
  useEffect(() => {
    const apply = () => {
      container.dir = i18n.dir(i18n.language);
      container.lang = i18n.language;
    };
    apply();
    i18n.on('languageChanged', apply);
    return () => i18n.off('languageChanged', apply);
  }, [i18n, container]);
  return (
    <I18nextProvider i18n={i18n}>
      <Suspense fallback={<Loading />}>
        <DatabaseView
          host={deps.host}
          databaseId={options.databaseId}
          viewId={options.viewId}
          embedded
          editable={options.editable}
          onViewChange={(viewId) => {
            if (options.editable && viewId !== options.viewId) options.setViewId(viewId);
          }}
        />
      </Suspense>
    </I18nextProvider>
  );
}

function Loading() {
  const { t } = useTranslation();
  return (
    <div className="cgw-db-block-loading" aria-busy="true">
      {t('app.loading')}
    </div>
  );
}
