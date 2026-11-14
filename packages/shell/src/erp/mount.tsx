// An ERP view block's frame (`EditorHost.erp.mount`, contracts section 2): `ErpView` in a React
// root of its own per block, in the editor's frame element, with the app's strings and the
// interface direction, over the tab's ERP services. The editor mounts again when the block's
// link, block id or editability changes: the root drawn for that block a moment before is moved
// into the new element rather than made again, so a block that has just chosen its link keeps its
// place. Any other change of its settings goes to `update`.
import type { ErpMountOptions, MountedFrame } from '@cgw/editor';
import type { ErpViewHost } from '@cgw/erp';
import type { i18n as I18n } from 'i18next';
import { lazy, Suspense, useEffect, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider, useTranslation } from 'react-i18next';
import type { ShellErp } from './services';

// The views load with the first ERP block on screen, not with the editor.
const ErpView = lazy(() => import('@cgw/erp/view').then((m) => ({ default: m.ErpView })));

interface Mounted {
  root: Root;
  container: HTMLElement;
  /** Set while the root waits to be dropped; a mount of the same block takes it back. */
  disposal: ReturnType<typeof setTimeout> | null;
}

const mounted = new Map<string, Mounted>();

export interface ErpMountDeps {
  services: ShellErp;
  i18n: I18n;
}

export function mountErp(
  element: HTMLElement,
  options: ErpMountOptions,
  deps: ErpMountDeps,
): MountedFrame<ErpMountOptions> {
  const key = options.blockId;
  const waiting = key ? mounted.get(key) : undefined;
  let entry: Mounted;
  if (waiting && waiting.disposal !== null) {
    clearTimeout(waiting.disposal);
    waiting.disposal = null;
    entry = waiting;
  } else {
    const container = document.createElement('div');
    container.className = 'cgw-erp-block';
    entry = { root: createRoot(container), container, disposal: null };
    // A second view of the same block (the history's preview) keeps the first one's entry.
    if (key && !waiting) mounted.set(key, entry);
  }
  element.appendChild(entry.container);
  let gone = false;
  const render = (current: ErpMountOptions) =>
    entry.root.render(<ErpBlock options={current} deps={deps} container={entry.container} />);
  render(options);
  return {
    update(next) {
      if (!gone) render(next);
    },
    destroy() {
      if (gone) return;
      gone = true;
      if (entry.disposal !== null) return;
      // Not during the editor's own update (React refuses to unmount a root while rendering).
      entry.disposal = setTimeout(() => {
        entry.disposal = null;
        if (key && mounted.get(key) === entry) mounted.delete(key);
        entry.root.unmount();
        entry.container.remove();
      }, 0);
    },
  };
}

function ErpBlock({
  options,
  deps,
  container,
}: {
  options: ErpMountOptions;
  deps: ErpMountDeps;
  container: HTMLElement;
}) {
  const { i18n, services } = deps;
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
  const { linkId, connectorId, filter, fields, sort, pageSize, editable, setAttrs } = options;
  const host = useMemo<ErpViewHost>(
    () => ({
      attrs: { linkId, connectorId, filter, fields, sort, pageSize },
      editable,
      setAttrs: (attrs) => {
        if (editable) setAttrs(attrs);
      },
      connection: services,
      sessions: services.sessions(),
    }),
    [linkId, connectorId, filter, fields, sort, pageSize, editable, setAttrs, services],
  );
  return (
    <I18nextProvider i18n={i18n}>
      <Suspense fallback={<Loading />}>
        <ErpView host={host} />
      </Suspense>
    </I18nextProvider>
  );
}

function Loading() {
  const { t } = useTranslation();
  return (
    <div className="cgw-erp-block-loading" aria-busy="true">
      {t('app.loading')}
    </div>
  );
}
