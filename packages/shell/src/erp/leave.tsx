// The warning before leaving ERP changes behind (Phase 7, INTEGRATIONS.md, "Level 2: editable ERP
// blocks"): a move to another route asks first (the router keeps showing the page meanwhile),
// the browser asks before the tab closes or reloads, and the desktop asks before its window
// closes. Leaving forgets the page's drafts; they were only ever in memory.
import type { ErpDrafts } from '@cgw/erp';
import type { i18n as I18n } from 'i18next';
import { createRoot } from 'react-dom/client';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { Dialog } from '../Dialog';
import type { WorkspacePlatform } from '../platform';
import { setLeaveGuard } from '../route';

let asking: Promise<boolean> | null = null;

/** Asks whether to leave and forget the changes; one dialog at a time. True: leave. */
export function askToLeave(i18n: I18n): Promise<boolean> {
  if (asking) return asking;
  asking = new Promise<boolean>((resolve) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const done = (leave: boolean) => {
      resolve(leave);
      // Not during the dialog's own event: React refuses to unmount a root while it renders.
      setTimeout(() => {
        root.unmount();
        container.remove();
      }, 0);
    };
    root.render(
      <I18nextProvider i18n={i18n}>
        <LeaveDialog onDone={done} />
      </I18nextProvider>,
    );
  }).finally(() => {
    asking = null;
  });
  return asking;
}

function LeaveDialog({ onDone }: { onDone: (leave: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Dialog role="alertdialog" title={t('erp.leaveTitle')} onClose={() => onDone(false)}>
      <p data-testid="erp-leave-text">{t('erp.leaveText')}</p>
      <div className="cgw-dialog-buttons">
        <button type="button" className="cgw-button" onClick={() => onDone(false)}>
          {t('erp.leaveStay')}
        </button>
        <button type="button" className="cgw-button is-danger" onClick={() => onDone(true)}>
          {t('erp.leaveGo')}
        </button>
      </div>
    </Dialog>
  );
}

/** The warning for the tab's drafts, until the returned function removes it. */
export function installErpLeaveGuard(
  drafts: ErpDrafts,
  i18n: I18n,
  platform: Pick<WorkspacePlatform, 'onCloseAsk'>,
): () => void {
  const offRoute = setLeaveGuard({
    blocks: (from, to) =>
      from.kind === 'page' &&
      drafts.pendingOn(from.pageId) &&
      !(to.kind === 'page' && to.pageId === from.pageId),
    ask: async (from) => {
      const leave = await askToLeave(i18n);
      if (leave && from.kind === 'page') drafts.discardPage(from.pageId);
      return leave;
    },
  });
  // The browser's own question; it shows its own text.
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (drafts.pending().length > 0) event.preventDefault();
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  const offClose = platform.onCloseAsk?.(async () => {
    if (drafts.pending().length === 0) return true;
    const leave = await askToLeave(i18n);
    if (leave) drafts.clear();
    return leave;
  });
  return () => {
    offRoute();
    window.removeEventListener('beforeunload', onBeforeUnload);
    offClose?.();
  };
}

const held = new WeakMap<ErpDrafts, { count: number; off: () => void }>();

/** One warning per tab, however many pages' blocks ask for it. Returns the release. */
export function holdErpLeaveGuard(
  drafts: ErpDrafts,
  i18n: I18n,
  platform: Pick<WorkspacePlatform, 'onCloseAsk'>,
): () => void {
  let entry = held.get(drafts);
  if (!entry) {
    entry = { count: 0, off: installErpLeaveGuard(drafts, i18n, platform) };
    held.set(drafts, entry);
  }
  const mine = entry;
  mine.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mine.count--;
    if (mine.count === 0 && held.get(drafts) === mine) {
      mine.off();
      held.delete(drafts);
    }
  };
}
