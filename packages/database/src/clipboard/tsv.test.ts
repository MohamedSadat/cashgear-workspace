// The clipboard's shapes: tab-separated text written as Excel and Sheet write it and read back
// leniently, and an HTML table written for spreadsheets and read when the clipboard has no text.
import { describe, expect, it } from 'vitest';
import { installDom } from '../testing/dom';
import { parseHtmlTable, parseTsv, toHtmlTable, toTsv } from './tsv';

installDom();

describe('tab-separated text', () => {
  it('quotes a field holding a tab, a line break or a quote, and ends each row with CRLF', () => {
    expect(
      toTsv([
        ['plain', 'a\tb', 'two\nlines'],
        ['She said "yes"', '', '=1+2'],
      ]),
    ).toBe('plain\t"a\tb"\t"two\nlines"\r\n"She said ""yes"""\t\t=1+2\r\n');
  });

  it('reads back what it writes', () => {
    const rows = [
      ['a', 'b\tc', 'd\r\ne', ''],
      ['"quoted"', 'x', '', 'last'],
    ];
    expect(parseTsv(toTsv(rows))).toEqual(rows);
  });

  it('reads Excel’s text: CRLF, LF in a quoted cell, a trailing line end', () => {
    expect(parseTsv('A\tB\r\n"one\ntwo"\t3\r\n')).toEqual([
      ['A', 'B'],
      ['one\ntwo', '3'],
    ]);
  });

  it('reads a quote that does not close its field as a character', () => {
    expect(parseTsv('"Big" deal\tok')).toEqual([['"Big" deal', 'ok']]);
    expect(parseTsv('5" pipe')).toEqual([['5" pipe']]);
    expect(parseTsv('"unclosed\tnext')).toEqual([['"unclosed', 'next']]);
  });

  it('keeps empty cells, short rows and blank lines', () => {
    expect(parseTsv('a\t\tc\nb\n\nd\t')).toEqual([['a', '', 'c'], ['b'], [''], ['d', '']]);
  });

  it('reads a lone line end as one empty cell, and nothing as no rows', () => {
    expect(parseTsv('\r\n')).toEqual([['']]);
    expect(parseTsv('')).toEqual([]);
  });

  it('takes CR alone as a line end', () => {
    expect(parseTsv('a\rb')).toEqual([['a'], ['b']]);
  });
});

describe('an HTML table', () => {
  it('is written with its direction, text escaped, a line break kept in the cell', () => {
    const html = toHtmlTable([['<b>&', 'one\ntwo']], 'rtl');
    expect(html).toContain('<table dir="rtl">');
    expect(html).toContain('<td>&lt;b&gt;&amp;</td>');
    expect(html).toContain('one<br style="mso-data-placement:same-cell">two');
  });

  it('reads back what it writes', () => {
    const rows = [
      ['a', 'b & c'],
      ['two\nlines', ''],
    ];
    expect(parseHtmlTable(toHtmlTable(rows, 'ltr'))!.map((r) => r.map((c) => c.text))).toEqual(
      rows,
    );
  });

  it('reads Sheet’s exact numbers and a cell spanning columns', () => {
    const rows = parseHtmlTable(
      '<table><tr><td x:num="1234.5">1,234.50</td><td colspan="2">wide</td><td>end</td></tr></table>',
    )!;
    expect(rows).toEqual([
      [{ text: '1,234.50', number: 1234.5 }, { text: 'wide' }, { text: '' }, { text: 'end' }],
    ]);
  });

  it('reads a page’s table: paragraphs as lines, runs of spaces as one', () => {
    const rows = parseHtmlTable(
      '<html><body><p>Intro</p><table><tbody><tr><th>Name</th></tr><tr><td><p>First</p><p>  Second   line </p></td></tr></tbody></table></body></html>',
    )!;
    expect(rows.map((r) => r.map((c) => c.text))).toEqual([['Name'], ['First\nSecond line']]);
  });

  it('is nothing without a table', () => {
    expect(parseHtmlTable('<p>No table here</p>')).toBeNull();
  });
});
