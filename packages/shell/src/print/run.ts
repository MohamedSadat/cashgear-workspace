// Phase 19: a page out of the workspace (ARCHITECTURE.md, "Word, PDF and print"), loaded with the
// first export or print. Export to Word: collected on the device (after 0.19.0 each page is read in
// a worker, collect.ts), written and zipped in that worker, saved by the platform (the desktop's
// save dialog, a download on the web). Print and Save as PDF: the print view, its HTML made in the
// same worker, drawn into a root of the app's own document that only print media shows (the spike:
// WebView2 saves only its top document to a PDF, WKWebView prints only its main frame), the page's
// title as the document's while it prints, then printed by the engine:
// - the web: `window.print()`; Save as PDF is the print dialog's own printer, which the person
//   is told to choose;
// - the Windows app: Print is `window.print()`; Save as PDF goes straight to a file the person
//   names (WebView2's `PrintToPdf`, `platform.print`), with no print dialog;
// - the Mac app: the view is cut into pages by script (WebKit draws no margin boxes), then printed
//   by an `NSPrintOperation` of the paper's size with no margins, through the print panel, or to a
//   file with none (`platform.print`).
// The root goes once the dialog closes (`afterprint`), or once the platform's print is done.
import type { PrintMode, PrintView } from '@cgw/doc/out';
import type { PrintJob, WorkspacePlatform } from '../platform';
import { collect, leftOutText, type OutDeps } from './collect';
import { NAMES } from './words';

export type OutKind = 'word' | 'print' | 'pdf';

export interface OutRequest {
  pageId: string;
  kind: OutKind;
  subPages: boolean;
}

export type OutResult =
  | { status: 'done'; message: string | null }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

/** A file name a page's title may have on every system. */
export function fileName(title: string, untitled: string, extension: string): string {
  const safe = [...(title || untitled)]
    .map((c) => (c < ' ' || '\\/:*?"<>|'.includes(c) ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return `${safe || untitled}.${extension}`;
}

/** Chromium draws `@page`'s margin boxes; WebKit (the Mac app, Safari) and others are paged by script. */
export function printMode(userAgent = navigator.userAgent): PrintMode {
  return /\b(Chrome|Chromium|Edg|HeadlessChrome)\//.test(userAgent) ? 'css' : 'paged';
}

const ROOT = 'cgw-print-root';

/** The print root's and its stylesheet's place in the document, and what to put back. */
interface Mounted {
  root: HTMLElement;
  style: HTMLStyleElement;
  title: string;
}

function unmount(mounted: Mounted) {
  mounted.root.remove();
  mounted.style.remove();
  document.title = mounted.title;
}

/** Draws the print view where only print media shows it; paged, cut into pages by script first. */
export async function mountPrintView(view: PrintView, mode: PrintMode): Promise<Mounted> {
  for (const old of document.querySelectorAll(`.${ROOT}, #${ROOT}-style`)) old.remove();
  const style = document.createElement('style');
  style.id = `${ROOT}-style`;
  style.textContent =
    `${view.css}\n.${ROOT}{display:none;}\n` +
    `@media print{html,body{height:auto!important;min-height:0!important;overflow:visible!important;background:#fff!important;}` +
    `body>:not(.${ROOT}){display:none!important;}.${ROOT}{display:block!important;}\n${view.pageCss}}`;
  document.head.append(style);
  const root = document.createElement('div');
  root.className = ROOT;
  root.setAttribute('aria-hidden', 'true');
  root.dataset.testid = 'print-view';
  document.body.append(root);
  const { imagesLoaded, paginate } = await import('./paginate');
  if (mode === 'css') {
    root.innerHTML = view.html;
    await imagesLoaded(root);
  } else {
    // Laid out off screen at the content's width, measured, then moved into pages.
    const measure = document.createElement('div');
    measure.innerHTML = view.html;
    const flow = measure.firstElementChild as HTMLElement;
    flow.classList.add('pv-measure');
    document.body.append(measure);
    try {
      await imagesLoaded(measure);
      const pages = document.createElement('div');
      pages.className = 'pv pv-pages';
      pages.lang = flow.lang;
      root.append(pages);
      root.dataset.pages = String(paginate(view, flow, pages));
    } finally {
      measure.remove();
    }
  }
  const title = document.title;
  document.title = view.title;
  return { root, style, title };
}

/** Prints the mounted view: the platform's own print when it has one, else the engine's dialog. */
async function printMounted(
  mounted: Mounted,
  platform: WorkspacePlatform,
  job: PrintJob,
): Promise<'printed' | 'saved' | 'cancelled'> {
  if (platform.print) {
    try {
      const answer = await platform.print(job);
      // The engine's own dialog is open: it says when it closes.
      if (answer === 'dialog') {
        afterPrint(mounted);
        return 'printed';
      }
      unmount(mounted);
      return answer;
    } catch (error) {
      unmount(mounted);
      throw error;
    }
  }
  afterPrint(mounted);
  window.print();
  return 'printed';
}

/** Takes the view away once the print dialog closes (Chromium says so by `afterprint`). */
function afterPrint(mounted: Mounted) {
  const done = () => {
    window.removeEventListener('afterprint', done);
    unmount(mounted);
  };
  window.addEventListener('afterprint', done);
}

/** Exports, prints or saves a page as a PDF; says what it left out. */
export async function runOut(
  deps: OutDeps & { platform: WorkspacePlatform },
  request: OutRequest,
): Promise<OutResult> {
  const { i18n, platform } = deps;
  const t = i18n.t.bind(i18n) as unknown as (
    key: string,
    options?: Record<string, unknown>,
  ) => string;
  const untitled = t('print.words.untitled');
  const collected = await collect(deps, request.pageId, {
    subPages: request.subPages,
    purpose: request.kind === 'word' ? 'word' : 'print',
  });
  const { title } = collected;
  const left = leftOutText(t, collected.leftOut, collected.locale);
  try {
    if (request.kind === 'word') {
      const bytes = await collected.word();
      const name = fileName(title, untitled, 'docx');
      await platform.saveFile(
        name,
        bytes,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      return { status: 'done', message: left };
    }
    const mode = platform.printMode ?? printMode();
    const view = await collected.print(mode);
    const mounted = await mountPrintView(view, mode);
    const job: PrintJob = {
      pdf: request.kind === 'pdf',
      name: fileName(title, untitled, 'pdf'),
      paged: mode === 'paged',
      paper: { width: view.box.width, height: view.box.height },
      margins:
        mode === 'paged'
          ? { block: 0, inline: 0 }
          : { block: view.box.block, inline: view.box.inline },
    };
    const answer = await printMounted(mounted, platform, job);
    if (answer === 'cancelled') return { status: 'cancelled' };
    // On the web, Save as PDF is the dialog's printer: the person was told to choose it.
    return { status: 'done', message: left };
  } finally {
    // Blob addresses the print view drew from go once it has printed (or the dialog closed).
    if (request.kind === 'word') collected.dispose();
    else window.setTimeout(() => collected.dispose(), 60_000);
  }
}

/** The hint the web gives before Save as PDF opens the print dialog. */
export const pdfHint = (t: (key: string, options?: Record<string, unknown>) => string) =>
  t('print.out.pdfHint', { printer: NAMES.printer });
