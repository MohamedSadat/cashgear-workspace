// Phase 19: Export to Word, Print and Save as PDF, from a page's (or a row's) menu. A page with
// sub-pages asks whether they go too; on the web, Save as PDF first says to choose the print
// dialog's "Save as PDF" printer. Otherwise it starts at once, says it is preparing the page, and
// closes when the file is saved or the print dialog has opened; what was left out is said in a
// notice after. Its words are the `print` section, loaded with it.
import { CgCheckBox } from '@cashgear/ui';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../Dialog';
import { useSection } from '../i18n/sections';
import { pageEvents } from '../page/PageMenu';
import type { WorkspacePlatform } from '../platform';
import { MAX_SUB_PAGES, subPagesOf, type OutDeps } from './collect';
import { pdfHint, runOut, type OutKind } from './run';
import { NAMES, printWords } from './words';
import './print.css';

const notice = (text: string) =>
  pageEvents.dispatchEvent(new CustomEvent('notice', { detail: text }));

export function OutDialog({
  deps,
  pageId,
  kind,
  onClose,
}: {
  deps: OutDeps & { platform: WorkspacePlatform };
  pageId: string;
  kind: OutKind;
  onClose: () => void;
}) {
  useSection(printWords);
  const { t } = useTranslation();
  const page = deps.session.mirror.pages.get(pageId);
  const subPages = page ? subPagesOf(deps.session, pageId).length : 0;
  // A choice to make: whether sub-pages go too, or (the web) which printer saves a PDF.
  const webPdf = kind === 'pdf' && !deps.platform.print;
  const ask = subPages > 0 || webPdf;
  const [withSubPages, setWithSubPages] = useState(false);
  const [busy, setBusy] = useState(!ask);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const title = t(`print.out.${kind}`, { word: NAMES.word, pdf: NAMES.pdf });

  const go = async (sub: boolean) => {
    if (started.current) return;
    started.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await runOut(deps, { pageId, kind, subPages: sub });
      if (result.status === 'failed') throw new Error(result.message);
      if (result.status === 'done') {
        const saved =
          kind === 'word'
            ? t('print.out.saved', { name: page?.title || t('print.words.untitled') })
            : null;
        const said = [saved, result.message].filter(Boolean).join(' ');
        if (said) notice(said);
      }
      onClose();
    } catch (failure) {
      console.error('Phase 19 output failed:', failure);
      started.current = false;
      setBusy(false);
      setError(t(kind === 'word' ? 'print.out.failed' : 'print.out.printFailed'));
    }
  };

  // Once, when it opens with nothing to ask (`started` keeps a second call from running).
  const auto = useRef(!ask);
  useEffect(() => {
    if (!auto.current) return;
    auto.current = false;
    void go(false);
  });

  return (
    <Dialog title={title} onClose={() => !busy && onClose()}>
      <div className="cgw-print-out" data-testid="out-dialog" data-kind={kind}>
        {ask && !busy && (
          <>
            {subPages > 0 && (
              <CgCheckBox
                label={t('print.out.subPages', { number: subPages })}
                description={t('print.out.subPagesNote', { number: MAX_SUB_PAGES })}
                checked={withSubPages}
                onCheckedChange={(on) => setWithSubPages(on === true)}
              />
            )}
            {webPdf && (
              <p className="cgw-muted">
                {pdfHint(
                  t as unknown as (key: string, options?: Record<string, unknown>) => string,
                )}
              </p>
            )}
          </>
        )}
        {busy && (
          <p className="cgw-muted" role="status" aria-busy="true">
            {t('print.out.working')}
          </p>
        )}
        {error && (
          <p className="cgw-print-error" role="alert">
            {error}
          </p>
        )}
        {(!busy || error) && (
          <div className="cgw-dialog-buttons">
            <button type="button" className="cgw-button" onClick={onClose}>
              {t('print.out.cancel')}
            </button>
            <button
              type="button"
              className="cgw-button is-primary"
              data-testid="out-go"
              onClick={() => void go(withSubPages)}
            >
              {t(
                kind === 'word'
                  ? 'print.out.goWord'
                  : kind === 'pdf'
                    ? 'print.out.goPdf'
                    : 'print.out.goPrint',
              )}
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
