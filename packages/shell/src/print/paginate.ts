// Phase 19: the print view cut into pages by script, for WebKit (the Mac app), which draws no
// `@page` margin boxes and takes the print info's margins (the spike, DECISIONS.md 2026-11-26).
// The view's flow is laid out off screen at the content's width; its units (`.pv-u`) are measured
// and moved, in order, into page boxes of the paper's size (`.pv-page`), each with its header and
// footer in its margins and its number. A section (the page, each sub-page) starts a page; a
// heading goes with what follows it; a table is cut between rows (its header row on each page, its
// columns fixed so they line up), a code block between lines. A unit taller than a page that is
// neither is drawn from the top of a page of its own and cut at its foot: a paragraph that long is
// the one thing this mode does not carry over (Chromium's mode, the web's and the Windows app's,
// breaks anything).
import type { PrintView } from '@cgw/doc/out';

const PX_PER_MM = 96 / 25.4;

/** An element's height with its margins. */
function outer(el: Element): number {
  const style = getComputedStyle(el);
  return (
    el.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom)
  );
}

interface Piece {
  el: HTMLElement;
  height: number;
  /** A heading: kept with the piece after it. */
  keep: boolean;
  /** A table row, with the table it came from: rows of one table share a page's table. */
  row?: { table: HTMLTableElement; head: number };
}

/** A unit's pieces: itself, or what it is cut into (a table's rows, a code block's lines). */
function piecesOf(unit: HTMLElement, limit: number): Piece[] {
  const height = outer(unit);
  const keep = /^H[1-6]$/.test(unit.tagName);
  // A table is placed a row at a time (its rows fill a page, then go on on the next).
  const table = unit.querySelector<HTMLTableElement>('table.pv-table');
  if (table && table.tBodies[0]) {
    const pieces: Piece[] = [];
    const head = table.tHead ? table.tHead.getBoundingClientRect().height : 0;
    const shell = () => unit.cloneNode(false) as HTMLElement;
    for (const child of [...unit.children]) {
      if (child === table || child.contains(table)) {
        for (const tr of [...table.tBodies[0].rows])
          pieces.push({
            el: tr,
            height: tr.getBoundingClientRect().height,
            keep: false,
            row: { table, head },
          });
        continue;
      }
      const piece = shell();
      piece.append(child);
      pieces.push({ el: piece, height: outer(child), keep: false });
    }
    return pieces;
  }
  if (unit.classList.contains('pv-code') && height > limit) {
    const lines = [...unit.querySelectorAll<HTMLElement>(':scope > .pv-line')];
    const pieces: Piece[] = [];
    const style = getComputedStyle(unit);
    const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    let chunk = unit.cloneNode(false) as HTMLElement;
    let used = pad;
    for (const line of lines) {
      const h = line.getBoundingClientRect().height;
      if (used + h > limit - 8 && chunk.childElementCount) {
        pieces.push({ el: chunk, height: used, keep: false });
        chunk = unit.cloneNode(false) as HTMLElement;
        used = pad;
      }
      chunk.append(line);
      used += h;
    }
    if (chunk.childElementCount) pieces.push({ el: chunk, height: used, keep: false });
    return pieces;
  }
  return [{ el: unit, height, keep }];
}

/** Fills each band's page fields (`data-field="page"`, `"pages"`) once every page is made. */
function fillFields(pages: HTMLElement[]) {
  pages.forEach((page, i) => {
    for (const field of page.querySelectorAll<HTMLElement>('[data-field]'))
      field.textContent = String(field.dataset.field === 'page' ? i + 1 : pages.length);
  });
}

/**
 * Cuts the print view's flow into page boxes: `measure` holds the flow laid out off screen at the
 * content's width (its images loaded); the pages go into `into`. Returns how many there are.
 */
export function paginate(view: PrintView, measure: HTMLElement, into: HTMLElement): number {
  const limit = (view.box.height - 2 * view.box.block) * PX_PER_MM;
  const pages: HTMLElement[] = [];
  let body: HTMLElement | null = null;
  let used = 0;
  let table: { from: HTMLTableElement; to: HTMLTableElement } | null = null;

  const newPage = (section: number) => {
    const band = (kind: 'head' | 'foot') => {
      const shown =
        kind === 'head' ? view.bands[section].shown.header : view.bands[section].shown.footer;
      const places = (kind === 'head' ? view.bands[section].header : view.bands[section].footer)
        .places;
      if (!shown) return '';
      return `<div class="pv-band pv-${kind}" dir="${view.bands[section].dir}"><span class="pv-start">${places.start}</span><span class="pv-centre">${places.center}</span><span class="pv-end">${places.end}</span></div>`;
    };
    const page = document.createElement('div');
    page.className = 'pv-page';
    page.innerHTML = `${band('head')}<div class="pv-body" dir="${view.bands[section].dir}"></div>${band('foot')}`;
    into.append(page);
    pages.push(page);
    body = page.querySelector<HTMLElement>('.pv-body');
    used = 0;
    table = null;
  };

  const sections = [...measure.querySelectorAll<HTMLElement>('section.pv-doc')];
  sections.forEach((section, index) => {
    newPage(index);
    const sectionShell = section.cloneNode(false) as HTMLElement;
    sectionShell.removeAttribute('style');
    body!.append(sectionShell);
    let holder = sectionShell;
    const reopen = () => {
      holder = section.cloneNode(false) as HTMLElement;
      holder.removeAttribute('style');
      body!.append(holder);
    };
    const units = [...section.children].filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    );
    const pieces = units.flatMap((unit) => piecesOf(unit, limit));
    pieces.forEach((piece, i) => {
      const head = piece.row && table?.from !== piece.row.table ? piece.row.head : 0;
      const next = piece.keep ? (pieces[i + 1]?.height ?? 0) : 0;
      if (used > 0 && used + piece.height + head + next > limit) {
        newPage(index);
        reopen();
      }
      if (piece.row) {
        if (!table || table.from !== piece.row.table) {
          const from = piece.row.table;
          const to = from.cloneNode(false) as HTMLTableElement;
          const colgroup = from.querySelector('colgroup');
          if (colgroup) to.append(colgroup.cloneNode(true));
          if (from.tHead) to.append(from.tHead.cloneNode(true));
          to.append(document.createElement('tbody'));
          // A table keeps its unit's indent and title placement.
          const wrap = (from.closest('.pv-u') ?? from.parentElement)!.cloneNode(
            false,
          ) as HTMLElement;
          wrap.append(to);
          holder.append(wrap);
          table = { from, to };
          used += from.tHead ? from.tHead.getBoundingClientRect().height : 0;
        }
        table.to.tBodies[0].append(piece.el);
      } else {
        table = null;
        holder.append(piece.el);
      }
      used += piece.height;
    });
  });
  fillFields(pages);
  return pages.length;
}

/** Waits until every image of an element has loaded (or failed), so it measures as it prints. */
export async function imagesLoaded(root: HTMLElement): Promise<void> {
  await Promise.all(
    [...root.querySelectorAll('img')].map((image) =>
      image.complete ? Promise.resolve() : image.decode().catch(() => undefined),
    ),
  );
}

export const mmToPx = (mm: number) => mm * PX_PER_MM;
