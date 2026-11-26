// Phase 19, M19.3: the print view's HTML and CSS (print.ts), over the page with every block. What
// the engines make of it is the specs' (tests/e2e/print.spec.ts, read back from the PDF).
import { describe, expect, it } from 'vitest';
import { LAYOUT, everyBlockInput } from './fixtures';
import { printView } from './print';

describe('the print view', () => {
  it('draws every block of the page and its sub-page, nothing lazy', () => {
    const view = printView(everyBlockInput('en'), 'css');
    const html = view.html;
    for (const text of [
      'Quarterly report',
      'Heading one',
      'Green apples',
      'Small ones',
      'Fifth step',
      'Still open',
      'A quotation that stands apart.',
      'Mind the step.',
      'Inside the toggle.',
      'const a = 1;',
      'North and South',
      'A small picture',
      'Budget.xlsx',
      'https://example.com/bookmark',
      'A child page',
      'Write the report',
      'And 997 more rows',
      'Cash Gear ERP: Vendors (its data is not exported)',
      'Board: Tasks',
      'Text of a block from a later build',
      'Notes, a sub-page',
      'The sub-page’s own text.',
      '@Sara',
      '26 Nov 2026',
    ])
      expect(html, text).toContain(text);
    // Numbers count from the first item's start, nested lists count again, check boxes are drawn.
    expect(html).toContain('<span class="pv-mark">3.</span>');
    expect(html).toContain('<span class="pv-mark">5.</span>');
    expect(html.match(/☑/g)).toHaveLength(1);
    expect(html.match(/☐/g)).toHaveLength(2);
    // The table of contents links to its headings.
    expect(html).toMatch(/<a href="#pv-blk0+1">Heading one<\/a>/);
    // A chart is an image (no script can run in it); the missing image a placeholder.
    expect(html).toContain('src="data:image/svg+xml;charset=utf-8,');
    expect(html).not.toContain('<svg');
    expect(html).toContain('An image not on this device');
    // The sub-page starts a page of its own.
    expect(view.css).toContain('.pv-doc+.pv-doc{break-before:page;');
    expect(html.match(/<section class="pv-doc"/g)).toHaveLength(2);
  });

  it('escapes what it writes and links only to safe addresses', () => {
    const input = everyBlockInput('en');
    input.pages[0].content = {
      type: 'doc',
      content: [
        {
          type: 'block',
          attrs: { id: 'blk1' },
          content: [
            {
              type: 'textBody',
              attrs: { kind: 'paragraph' },
              content: [
                { type: 'text', text: '<script>alert(1)</script> & "x"' },
                {
                  type: 'text',
                  text: 'bad',
                  marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
                },
              ],
            },
          ],
        },
      ],
    };
    const { html } = printView(input, 'css');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;');
    expect(html).not.toContain('javascript:');
  });

  it("writes the layout's paper, margins and margin boxes, with page numbers", () => {
    const { pageCss, box } = printView(everyBlockInput('en'), 'css');
    expect(box).toEqual({ width: 210, height: 297, block: 25.4, inline: 25.4 });
    expect(pageCss).toContain('@page{size:210mm 297mm;margin:25.4mm 25.4mm;');
    // Each section's own page: its title in the header's start, the date at its end.
    expect(pageCss).toContain(
      '@page pv-doc-0{@top-left{content:"Quarterly report";}@top-right{content:"26 Nov 2026";}@bottom-center{content:counter(page) " / " counter(pages);}}',
    );
    expect(pageCss).toContain('@page pv-doc-1{@top-left{content:"Notes, a sub-page";}');
    const letter = printView(
      everyBlockInput('en', {
        ...LAYOUT,
        size: 'letter',
        orientation: 'landscape',
        margins: 'wide',
      }),
      'css',
    );
    expect(letter.pageCss).toContain('@page{size:279.4mm 215.9mm;margin:25.4mm 50.8mm;');
  });

  it('puts a band’s start on the right of a right-to-left page', () => {
    const { pageCss, html, bands } = printView(everyBlockInput('ar'), 'css');
    expect(pageCss).toContain(
      '@page pv-doc-0{@top-right{content:"تقرير الربع";}@top-left{content:"٢٦ نوفمبر ٢٠٢٦";}',
    );
    expect(html).toContain('<section class="pv-doc" data-doc="0" dir="rtl"');
    expect(bands[0].dir).toBe('rtl');
  });

  it('gives the paged mode no page margin, and each band its fields to fill', () => {
    const view = printView(everyBlockInput('en'), 'paged');
    expect(view.pageCss).toBe('@page{size:210mm 297mm;margin:0;}\n');
    expect(view.bands[0].header.places).toEqual({
      start: 'Quarterly report',
      center: '',
      end: '26 Nov 2026',
    });
    expect(view.bands[0].footer.places.center).toBe(
      '<span data-field="page"></span> / <span data-field="pages"></span>',
    );
    expect(view.bands[0].shown).toEqual({ header: true, footer: true });
  });
});
